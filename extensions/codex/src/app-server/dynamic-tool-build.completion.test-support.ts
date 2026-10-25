import "./dynamic-tool-build.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { setHostToolFactoryForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { runInHarnessToolAuthorityForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveSandboxRuntimeStatusAsync } from "openclaw/plugin-sdk/sandbox";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  createCodexRuntimePlanFixture,
  createParams,
} = await import("./dynamic-tool-build.test-support.js");

import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { JsonObject } from "./protocol.js";

type ToolOptions = Parameters<typeof createOpenClawCodingTools>[0];

async function withToolsState(
  options: Parameters<typeof withOpenClawTestState>[0],
  run: (
    state: OpenClawTestState,
    params: ReturnType<typeof createParams>,
    bindHost: () => Promise<void>,
  ) => Promise<void>,
) {
  await withOpenClawTestState(options, async (state) => {
    const params = createParams(state.path("session.jsonl"), state.workspaceDir, {
      disableTools: false,
      runtimePlan: createCodexRuntimePlanFixture(),
      config: {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      },
    });
    const closers: Array<() => void> = [];
    setRuntimeConfigSnapshot(params.config!);
    try {
      await run(state, params, () => bindProductionCodexHostCapabilities(params, closers));
    } finally {
      closers.forEach((close) => close());
    }
  });
}

export function registerCodexCompletionCommandTest() {
  it("constructs and completes default sandbox Goal controls through the production host", async () => {
    await withToolsState(
      { label: "codex-core-goal-completion" },
      async (state, params, bindHost) => {
        await upsertSessionEntry({
          agentId: "main",
          sessionKey: expectDefined(params.sessionKey, "Goal session key"),
          entry: { sessionId: params.sessionId, updatedAt: Date.now() },
        });
        const sandboxPolicy = await resolveSandboxRuntimeStatusAsync({
          cfg: params.config,
          agentId: "main",
          sessionKey: expectDefined(params.sessionKey, "Goal session key"),
          preparedSessionEntry: null,
        });
        const sandbox = {
          ...createSandboxTestContext({
            overrides: {
              backendId: "node",
              sessionKey: expectDefined(params.sessionKey, "Goal session key"),
              workspaceDir: state.workspaceDir,
              agentWorkspaceDir: state.workspaceDir,
              containerWorkdir: state.workspaceDir,
              tools: sandboxPolicy.toolPolicy,
            },
          }),
          placementExecutionMode: "remote-exec" as const,
          placementNodeId: "synthetic-node",
          placementEnvironmentId: "synthetic-environment",
          placementSessionId: params.sessionId,
          placementOwnerEpoch: 1,
        };
        params.sandbox = sandbox;
        await bindHost();
        const tools = await buildDynamicToolsForTest(params, state.workspaceDir, { sandbox });
        const bridge = createCodexDynamicToolBridge({
          tools,
          signal: new AbortController().signal,
        });
        const call = (tool: string, args: JsonObject) =>
          bridge.handleToolCall({
            threadId: "core-goal-thread",
            turnId: "core-goal-turn",
            callId: tool,
            tool,
            arguments: args,
          });
        expect(
          await call("create_goal", { objective: "Verify the synthetic fixture" }),
        ).toMatchObject({ success: true });
        expect(await call("get_goal", {})).toMatchObject({ success: true });
        expect(await call("update_goal", { status: "complete" })).toMatchObject({
          success: true,
        });
      },
    );
  });
  it("constructs completion-turn tools with the originating conversation context", async () => {
    await withToolsState(
      { label: "codex-completion-command", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state, params, bindHost) => {
        const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
        const route = {
          channel: "telegram",
          to: "-100155462274",
          accountId: "work",
          threadId: "42",
        };
        params.agentId = "main";
        params.sessionKey = sessionKey;
        params.trigger = "event";
        params.execOverrides = { host: "gateway", mode: "full" };
        params.messageProvider = route.channel;
        params.currentChannelId = route.to;
        params.agentAccountId = route.accountId;
        params.currentThreadTs = route.threadId;
        const factory = vi.fn((options: ToolOptions) =>
          createOpenClawCodingTools(options).filter((tool) =>
            ["exec", "process"].includes(tool.name),
          ),
        );
        await setHostToolFactoryForTest(params, factory);
        await bindHost();
        await runInHarnessToolAuthorityForTest(params, "codex", async () => {
          await buildDynamicToolsForTest(params, state.workspaceDir, {
            nativeToolSurfaceEnabled: false,
          });
          expect(factory.mock.calls[0]?.[0]).toMatchObject({
            trigger: "event",
            sessionKey,
            sessionId: params.sessionId,
            runId: params.runId,
            messageProvider: route.channel,
            currentChannelId: route.to,
            currentThreadTs: route.threadId,
            agentAccountId: route.accountId,
          });
        });
      },
    );
  });
}
