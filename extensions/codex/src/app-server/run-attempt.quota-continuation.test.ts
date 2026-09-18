import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { asOptionalRecord as asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import { isJsonObject } from "./protocol.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import {
  createParams,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed,
  retainSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

setupRunAttemptTestHooks();

describe("Codex settled quota continuation offer", () => {
  it.each([
    "quota",
    "text-only",
    "transient",
    "active",
    "uncertain",
    "async",
    "cleanup-failure",
    "mirror-failure",
    "no-fallback",
    "opaque-tool",
    "late-request",
    "admitted-request",
    "required-cleanup-failure",
    "required-cleanup-timeout",
    "shared-peer",
    "shared-peer-cleanup-failure",
    "adjusted-arguments",
    "rewritten-mirror",
    "oversized-result",
    "image-result",
  ] as const)(
    "preserves one write and the correct handoff verdict for %s",
    async (scenario) => {
      const sharedPeer = scenario === "shared-peer" || scenario === "shared-peer-cleanup-failure";
      const workspaceDir = path.join(tempDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const counter = path.join(workspaceDir, "effect-count");
      const tool = createRuntimeDynamicTool(scenario === "opaque-tool" ? "opaque_write" : "write");
      tool.parameters = {
        type: "object",
        properties: { value: { type: "string" } },
        additionalProperties: false,
      };
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let quotaSent = false;
      let lateRejected = false;
      let cleanupFinished = false;
      let cleanupCalls = 0;
      tool.execute = async (_id, args) => {
        entered.resolve();
        if (scenario === "admitted-request") {
          await release.promise;
        }
        const value = asRecord(args)?.value;
        await fs.appendFile(counter, `${typeof value === "string" ? value : "effect"}\n`);
        return {
          content:
            scenario === "image-result"
              ? [
                  {
                    type: "image",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ9kAAAAASUVORK5CYII=",
                    mimeType: "image/png",
                  },
                ]
              : [
                  {
                    type: "text",
                    text:
                      scenario === "oversized-result"
                        ? "x".repeat(12_000)
                        : "effect committed once",
                  },
                ],
          details: scenario === "async" ? { async: true, status: "started" } : {},
        };
      };
      dynamicToolBuildState.openClawCodingToolsFactory = (options) => {
        if (scenario === "required-cleanup-failure" || scenario === "shared-peer-cleanup-failure") {
          options?.registerRunCleanup?.(async () => {
            cleanupCalls++;
            throw new Error("required tool cleanup failed");
          });
        }
        if (scenario === "required-cleanup-timeout") {
          vi.stubEnv("OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS", "15");
          options?.registerRunCleanup?.(async () => {
            cleanupCalls++;
            await new Promise((resolve) => {
              setTimeout(resolve, 60);
            });
            cleanupFinished = true;
          });
        }
        return [tool];
      };
      if (scenario === "adjusted-arguments") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            { hookName: "before_tool_call", handler: () => ({ params: { value: "adjusted" } }) },
          ]),
        );
      }
      if (scenario === "rewritten-mirror") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_message_write",
              handler: (event) => {
                const message = asRecord(asRecord(event)?.message);
                return message?.role === "toolResult"
                  ? {
                      message: castAgentMessage({
                        ...message,
                        content: [{ type: "text", text: "rewritten effect evidence" }],
                      }),
                    }
                  : {};
              },
            },
          ]),
        );
      }
      const harness = createStartedThreadHarness(
        async (method, requestParams) => {
          if (method === "thread/resume" && asRecord(requestParams)?.threadId === "thread-peer") {
            return threadStartResult("thread-peer");
          }
          if (method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (method === "mcpServerStatus/list") {
            return { data: [], nextCursor: null };
          }
          if (
            method === "thread/backgroundTerminals/list" &&
            scenario === "late-request" &&
            quotaSent
          ) {
            await expect(
              harness.handleServerRequest({
                id: "late-write",
                method: "item/tool/call",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  callId: "late-write",
                  namespace: null,
                  tool: tool.name,
                  arguments: {},
                },
              }),
            ).rejects.toThrow(/sealed/);
            lateRejected = true;
          }
          if (method === "thread/backgroundTerminals/list" && scenario === "active") {
            return { data: [{ processId: "still-active" }] };
          }
          if (method === "thread/unsubscribe" && scenario === "cleanup-failure") {
            throw new Error("synthetic unsubscribe failure");
          }
          return undefined;
        },
        sharedPeer ? { persistedThreads: ["thread-peer"] } : {},
      );
      const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
      params.prompt = "Perform the action once, then report its result.";
      params.runtimePlan = createCodexRuntimePlanFixture();
      // The shared fixture observer assumes non-message tools are read-only. This
      // fixture actually appended a file, so preserve that execution evidence.
      params.observeToolTerminal = (observation) => ({
        executionStarted: observation.executionStarted !== false,
        sideEffectEvidence: observation.executionStarted !== false,
        effectReceipt: {
          state:
            observation.outcome === "success" && scenario !== "uncertain"
              ? "mutation_committed"
              : "uncertain",
        },
      });
      params.agentId = "main";
      params.pluginHarnessToolPolicyRestricted = true;
      params.toolsAllow = [tool.name];
      params.isFinalFallbackAttempt = scenario === "no-fallback";
      if (scenario === "mirror-failure") {
        vi.spyOn(codexTranscriptMirrorRuntime, "mirrorBestEffort").mockResolvedValue({
          assistantTranscriptOwned: false,
          mirroredMessages: [],
        });
      }
      const sessionTarget = {
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey!,
        storePath: path.join(tempDir, "openclaw-agent.sqlite"),
      };
      params.sessionTarget = sessionTarget;
      await upsertSessionEntry({
        ...sessionTarget,
        entry: { sessionId: params.sessionId, updatedAt: 1 },
      });
      setCodexTestModelSupportsTools(params, true);
      const run = runCodexAppServerAttempt(params);
      await Promise.race([
        harness.waitForMethod("turn/start", 10_000),
        run.then(() => {
          throw new Error("Native attempt ended before turn/start");
        }),
      ]);
      const peerNotifications = vi.fn();
      const peerRoute = sharedPeer
        ? getCodexAppServerTurnRouter(harness.client).reserveThread({
            threadId: "thread-peer",
            onNotification: peerNotifications,
          })
        : undefined;
      if (sharedPeer) {
        const releasePeer = retainSharedCodexAppServerClientIfCurrent(harness.client);
        expect(releasePeer).toBeTypeOf("function");
        onTestFinished(() => {
          peerRoute?.release();
          releasePeer?.();
        });
        peerRoute?.armTurn();
        await peerRoute?.bindTurn("peer-turn");
        await harness.client.request(
          "thread/resume",
          { threadId: "thread-peer" },
          { timeoutMs: 1_000 },
        );
      }
      const pendingResponse = harness.handleServerRequest({
        id: "write-once",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "write-once",
          namespace: null,
          tool: tool.name,
          arguments: {},
        },
      });
      if (scenario === "admitted-request") {
        await entered.promise;
        quotaSent = true;
        await harness.notify(
          turnCompleted({
            id: "turn-1",
            status: "failed",
            error: {
              message: "You've reached your usage limit.",
              codexErrorInfo: "usageLimitExceeded",
            },
          }),
        );
        release.resolve();
      }
      const response = await pendingResponse;
      expect(response).toMatchObject({ success: true });
      if (!isJsonObject(response)) {
        throw new Error("Expected a completed dynamic tool response");
      }
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "dynamicToolCall",
            id: "write-once",
            tool: tool.name,
            ...response,
          },
        },
      });
      quotaSent = true;
      await harness.notify(
        turnCompleted({
          id: "turn-1",
          status: "failed",
          error: {
            message: "You've reached your usage limit.",
            ...(scenario === "text-only"
              ? {}
              : {
                  codexErrorInfo:
                    scenario === "transient"
                      ? { responseTooManyFailedAttempts: { httpStatusCode: 429 } }
                      : "usageLimitExceeded",
                }),
          },
        }),
      );
      const result = await run;
      expect(await fs.readFile(counter, "utf8")).toBe(
        scenario === "adjusted-arguments" ? "adjusted\n" : "effect\n",
      );
      if (scenario === "late-request") {
        expect(lateRejected).toBe(true);
      }
      if (scenario === "required-cleanup-timeout") {
        await new Promise((resolve) => {
          setTimeout(resolve, 80);
        });
        expect(cleanupFinished).toBe(true);
      }
      if (
        scenario === "required-cleanup-failure" ||
        scenario === "shared-peer-cleanup-failure" ||
        scenario === "required-cleanup-timeout"
      ) {
        // Required active-turn cleanup and the outer finally share one disposer.
        expect(cleanupCalls).toBe(1);
      }
      if (sharedPeer) {
        // The unclaimed-retirement owner must refuse while exactly the peer lease remains.
        expect(clearSharedCodexAppServerClientIfCurrentAndUnclaimed(harness.client)).toEqual({
          found: true,
          closed: false,
          activeLeases: 1,
          pendingAcquires: 0,
        });
        expect(harness.client.getCloseError()).toBeUndefined();
        expect(peerRoute?.signal.aborted).toBe(false);
        expect(
          harness.requests
            .filter((request) => request.method === "thread/unsubscribe")
            .map((request) => asRecord(request.params)?.threadId),
        ).toEqual(["thread-1"]);
        await expect(
          harness.handleServerRequest({
            id: "retired-source",
            method: "item/tool/call",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              callId: "retired-source",
              namespace: null,
              tool: tool.name,
              arguments: {},
            },
          }),
        ).resolves.toEqual({
          contentItems: [
            {
              type: "inputText",
              text: "OpenClaw did not register a handler for this app-server tool call.",
            },
          ],
          success: false,
        });
        expect(await fs.readFile(counter, "utf8")).toBe("effect\n");
        await expect(
          harness.client.request(
            "thread/read",
            { threadId: "thread-peer", includeTurns: false },
            { timeoutMs: 1_000 },
          ),
        ).resolves.toMatchObject({ thread: { id: "thread-peer", status: { type: "idle" } } });
        await harness.notify({
          method: "turn/completed",
          params: {
            threadId: "thread-peer",
            turn: {
              id: "peer-turn",
              status: "completed",
              items: [],
            },
          },
        });
        expect(peerNotifications).toHaveBeenCalledWith(
          expect.objectContaining({ method: "turn/completed" }),
          { threadId: "thread-peer", turnId: "peer-turn" },
        );
        expect(peerRoute?.signal.aborted).toBe(false);
        expect(harness.client.getCloseError()).toBeUndefined();
      }
      expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: true, replaySafe: false });
      if (scenario === "text-only") {
        expect(readAttemptTerminal(result).promptError).toBe("You've reached your usage limit.");
      } else {
        expect(readAttemptTerminal(result).promptError).toMatchObject({ status: 429 });
      }
      if (["quota", "late-request", "admitted-request", "shared-peer"].includes(scenario)) {
        expect(result.settledQuotaContinuation).toMatchObject({ reason: "quota_exhausted" });
        expect(
          result.settledQuotaContinuation?.messages.filter((m) => m.role === "toolResult"),
        ).toHaveLength(1);
      } else {
        expect(result.settledQuotaContinuation).toBeUndefined();
      }
    },
    30_000,
  );
});
