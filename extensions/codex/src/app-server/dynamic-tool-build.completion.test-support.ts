import "./dynamic-tool-build.test-support.js";
import { expectDefined, isRecord } from "@openclaw/normalization-core";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  abortAndDrainAgentHarnessRun,
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { acknowledgeInternalToolResult } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { setHostToolFactoryForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  drainSystemEventEntries,
  peekSystemEventEntries,
} from "openclaw/plugin-sdk/system-event-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  createCodexRuntimePlanFixture,
  createParams,
} = await import("./dynamic-tool-build.test-support.js");

type ToolOptions = Parameters<typeof createOpenClawCodingTools>[0];

export function registerCodexCompletionCommandTest() {
  it("marks a command started by a conversation's completion turn as the conversation's own", async () => {
    await withOpenClawTestState(
      { label: "codex-completion-command", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
        const route = {
          channel: "telegram",
          to: "-100155462274",
          accountId: "work",
          threadId: "42",
        };
        const params = createParams(state.path("continuation.jsonl"), state.workspaceDir);
        params.disableTools = false;
        params.runtimePlan = createCodexRuntimePlanFixture();
        const controller = new AbortController();
        params.agentId = "main";
        params.sessionKey = sessionKey;
        params.trigger = "event";
        params.continuesConversation = true;
        params.abortSignal = controller.signal;
        params.execOverrides = { host: "gateway", mode: "full" };
        params.messageProvider = route.channel;
        params.currentChannelId = route.to;
        params.agentAccountId = route.accountId;
        params.currentThreadTs = route.threadId;
        params.config = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          plugins: { enabled: false },
        };
        const previousRuntimeConfig = getRuntimeConfigSnapshot();
        const previousSourceConfig = getRuntimeConfigSourceSnapshot();
        const localHostClosers: Array<() => void> = [];
        const activeRun: Parameters<typeof setActiveEmbeddedRun>[1] = {
          runId: params.runId,
          queueMessage: async () => {},
          isStreaming: () => true,
          isCompacting: () => false,
          abort: () => {
            controller.abort();
            clearActiveEmbeddedRun(params.sessionId, activeRun, sessionKey, params.sessionFile);
          },
        };
        setRuntimeConfigSnapshot(params.config);
        try {
          await upsertSessionEntry({
            agentId: "main",
            sessionKey,
            entry: {
              sessionId: params.sessionId,
              updatedAt: Date.now(),
              permissionMode: "full",
              chatType: "group",
              delivery: normalizeSessionDeliveryState({ context: route }),
            },
          });
          const factory = vi.fn((options: ToolOptions) =>
            createOpenClawCodingTools(options).filter((tool) =>
              ["exec", "process"].includes(tool.name),
            ),
          );
          await setHostToolFactoryForTest(params, factory);
          await bindProductionCodexHostCapabilities(params, localHostClosers);
          setActiveEmbeddedRun(params.sessionId, activeRun, sessionKey, params.sessionFile, "main");
          const tools = await buildDynamicToolsForTest(params, state.workspaceDir, {
            nativeToolSurfaceEnabled: false,
            runAbortController: controller,
          });
          const tool = (name: string) =>
            expectDefined(
              tools.find((candidate) => candidate.name === name),
              `OpenClaw ${name}`,
            );
          expect(factory.mock.calls[0]?.[0]).toMatchObject({
            sessionKey,
            trigger: "event",
            continuesConversation: true,
          });
          const launched = await tool("exec").execute("continuation-exec", {
            command: "echo codex-chain-ok",
            background: true,
          });
          if (!isRecord(launched.details) || typeof launched.details.sessionId !== "string") {
            throw new Error(`Expected a background process: ${JSON.stringify(launched.details)}`);
          }
          const processId = launched.details.sessionId;
          await vi.waitFor(
            () =>
              expect(peekSystemEventEntries(sessionKey)).toEqual([
                expect.objectContaining({
                  text: expect.stringContaining("codex-chain-ok"),
                  deliveryContext: route,
                }),
              ]),
            { timeout: 10_000 },
          );
          const result = await tool("process").execute("continuation-poll", {
            action: "poll",
            sessionId: processId,
          });
          expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
          expect(result.content).toContainEqual(
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("codex-chain-ok"),
            }),
          );
          acknowledgeInternalToolResult(result);
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
          await tool("process").execute("continuation-clear", {
            action: "clear",
            sessionId: processId,
          });
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        } finally {
          controller.abort();
          drainSystemEventEntries(sessionKey);
          try {
            await abortAndDrainAgentHarnessRun({ sessionId: params.sessionId, sessionKey });
          } finally {
            clearActiveEmbeddedRun(params.sessionId, activeRun, sessionKey, params.sessionFile);
            for (const close of localHostClosers) {
              close();
            }
            if (previousRuntimeConfig) {
              setRuntimeConfigSnapshot(previousRuntimeConfig, previousSourceConfig ?? undefined);
            } else {
              clearRuntimeConfigSnapshot();
            }
          }
        }
      },
    );
  });
}
