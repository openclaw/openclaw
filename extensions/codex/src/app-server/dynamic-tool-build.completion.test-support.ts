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
import { runInHarnessToolAuthorityForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveSandboxRuntimeStatusAsync } from "openclaw/plugin-sdk/sandbox";
import {
  getSessionEntryAsync,
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  drainSystemEventEntries,
  peekSystemEventEntries,
} from "openclaw/plugin-sdk/system-event-runtime";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  createCodexRuntimePlanFixture,
  createParams,
} = await import("./dynamic-tool-build.test-support.js");

import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { flattenCodexDynamicToolFunctions, type JsonObject } from "./protocol.js";
import { buildCodexRuntimeThreadConfig } from "./thread-requests.js";

type ToolOptions = Parameters<typeof createOpenClawCodingTools>[0];

export function registerCodexCompletionCommandTest() {
  it.each(["default", "sandbox-deny", "custom-allow", "global-deny"] as const)(
    "constructs and completes sandbox Goal controls through the production host (%s)",
    async (policy) => {
      await withOpenClawTestState({ label: "codex-core-goal-completion" }, async (state) => {
        const params = createParams(state.path("goal.jsonl"), state.workspaceDir);
        params.disableTools = false;
        params.runtimePlan = createCodexRuntimePlanFixture();
        params.config = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          plugins: { enabled: false },
          tools:
            policy === "sandbox-deny"
              ? { sandbox: { tools: { deny: ["update_goal"] } } }
              : policy === "custom-allow"
                ? { sandbox: { tools: { allow: ["get_goal", "create_goal"] } } }
                : policy === "global-deny"
                  ? { deny: ["update_goal"] }
                  : undefined,
        };
        const configuredPolicy = structuredClone(params.config.tools);
        const existingGoal =
          policy === "default"
            ? undefined
            : {
                schemaVersion: 1 as const,
                id: "existing-session-goal",
                objective: "Preserve the saved checkpoint",
                status: "paused" as const,
                createdAt: 1000,
                updatedAt: 1200,
                pausedAt: 1200,
                tokenStart: 12,
                tokenStartFresh: true,
                tokensUsed: 3,
                tokenBudget: 50,
                continuationTurns: 5,
                lastStatusNote: "Keep the existing progress",
              };
        const closers: Array<() => void> = [];
        const previousConfig = getRuntimeConfigSnapshot();
        const previousSource = getRuntimeConfigSourceSnapshot();
        setRuntimeConfigSnapshot(params.config);
        try {
          await upsertSessionEntry({
            agentId: "main",
            sessionKey: expectDefined(params.sessionKey, "Goal session key"),
            entry: { sessionId: params.sessionId, updatedAt: Date.now(), goal: existingGoal },
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
          await bindProductionCodexHostCapabilities(params, closers);
          const tools = await buildDynamicToolsForTest(params, state.workspaceDir, { sandbox });
          const bridge = createCodexDynamicToolBridge({
            tools,
            signal: new AbortController().signal,
          });
          expect(buildCodexRuntimeThreadConfig(undefined)["features.goals"]).toBe(false);
          const registeredNames = flattenCodexDynamicToolFunctions(bridge.specs).map(
            (tool) => tool.name,
          );
          for (const name of ["get_goal", "create_goal"]) {
            expect(bridge.specs).toContainEqual(
              expect.objectContaining({ type: "function", name }),
            );
          }
          const call = (tool: string, args: JsonObject) =>
            bridge.handleToolCall({
              threadId: "core-goal-thread",
              turnId: "core-goal-turn",
              callId: tool,
              tool,
              arguments: args,
            });
          if (policy !== "default") {
            expect(registeredNames).not.toContain("update_goal");
            expect(await call("update_goal", { status: "complete" })).toMatchObject({
              success: false,
            });
            expect(await call("get_goal", {})).toMatchObject({ success: true });
            expect(
              (
                await getSessionEntryAsync({
                  sessionKey: expectDefined(params.sessionKey, "Goal session key"),
                  agentId: "main",
                })
              )?.goal,
            ).toEqual(existingGoal);
            expect(params.config.tools).toEqual(configuredPolicy);
            return;
          }
          expect(bridge.specs).toContainEqual(
            expect.objectContaining({
              type: "function",
              name: "update_goal",
            }),
          );
          expect(
            await call("create_goal", { objective: "Verify the synthetic fixture" }),
          ).toMatchObject({ success: true });
          const active = (
            await getSessionEntryAsync({
              sessionKey: expectDefined(params.sessionKey, "Goal session key"),
              agentId: "main",
            })
          )?.goal;
          expect(active).toMatchObject({
            status: "active",
            objective: "Verify the synthetic fixture",
          });
          expect(await call("get_goal", {})).toMatchObject({ success: true });
          expect(await call("update_goal", { status: "complete" })).toMatchObject({
            success: true,
          });
          expect(
            (
              await getSessionEntryAsync({
                sessionKey: expectDefined(params.sessionKey, "Goal session key"),
                agentId: "main",
              })
            )?.goal,
          ).toMatchObject({
            id: active?.id,
            status: "complete",
          });
        } finally {
          for (const close of closers) {
            close();
          }
          if (previousConfig) {
            setRuntimeConfigSnapshot(previousConfig, previousSource ?? undefined);
          } else {
            clearRuntimeConfigSnapshot();
          }
        }
      });
    },
  );
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
        params.abortSignal = controller.signal;
        params.execOverrides = { host: "gateway", mode: "full" };
        params.messageProvider = route.channel;
        params.currentChannelId = route.to;
        params.agentAccountId = route.accountId;
        params.currentThreadTs = route.threadId;
        const config = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          plugins: { enabled: false },
        };
        params.config = config;
        const localHostClosers: Array<() => void> = [];
        const factory = vi.fn((options: ToolOptions) =>
          createOpenClawCodingTools(options).filter((tool) =>
            ["exec", "process"].includes(tool.name),
          ),
        );
        await setHostToolFactoryForTest(params, factory);
        await bindProductionCodexHostCapabilities(params, localHostClosers);
        try {
          await runInHarnessToolAuthorityForTest(params, "codex", async (prepared) => {
            const previousRuntimeConfig = getRuntimeConfigSnapshot();
            const previousSourceConfig = getRuntimeConfigSourceSnapshot();
            const activeRun: Parameters<typeof setActiveEmbeddedRun>[1] = {
              runId: params.runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
              queueMessage: async () => {},
              isStreaming: () => true,
              isCompacting: () => false,
              abort: () => {
                controller.abort();
                clearActiveEmbeddedRun(params.sessionId, activeRun, sessionKey, params.sessionFile);
              },
            };
            setRuntimeConfigSnapshot(config);
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
              setActiveEmbeddedRun(
                params.sessionId,
                activeRun,
                sessionKey,
                params.sessionFile,
                "main",
              );
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
              });
              const launched = await tool("exec").execute("continuation-exec", {
                command: "echo codex-chain-ok",
                background: true,
              });
              if (!isRecord(launched.details) || typeof launched.details.sessionId !== "string") {
                throw new Error(
                  `Expected a background process: ${JSON.stringify(launched.details)}`,
                );
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
              clearActiveEmbeddedRun(params.sessionId, activeRun, sessionKey, params.sessionFile);
              if (previousRuntimeConfig) {
                setRuntimeConfigSnapshot(previousRuntimeConfig, previousSourceConfig ?? undefined);
              } else {
                clearRuntimeConfigSnapshot();
              }
            }
          });
        } finally {
          try {
            await abortAndDrainAgentHarnessRun({ sessionId: params.sessionId, sessionKey });
          } finally {
            for (const close of localHostClosers) {
              close();
            }
          }
        }
      },
    );
  });
}
