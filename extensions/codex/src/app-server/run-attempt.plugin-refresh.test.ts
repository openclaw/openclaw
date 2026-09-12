import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { CodexAppServerClient } from "./client.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { buildEmptyToolTelemetry } from "./event-projector.test-harness.js";
import { isJsonObject } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  getMockRuntimeIdentity,
  runCodexAppServerAttempt,
  queueActiveRunMessageForTest,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { getLeasedSharedCodexAppServerClient } from "./shared-client.js";
import { createClientHarness } from "./test-support.js";
import { settleInput } from "./turn-router.test-support.js";

setupRunAttemptTestHooks();
const STEERING_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAS0lEQVR4Ae3AA6AkWZbG8f937o3IzKdyS2Oubdu2bdu2bdu2bWmMnpZKr54yMyLu+Xa3anqmhztr1a/e8v4/b56NynOi8pyoPCf+EZICAkafP69JAAAAAElFTkSuQmCC";

describe("managed Codex plugin refresh", () => {
  it.each([
    "confirmed",
    "exited-terminal",
    "interrupt-error",
    "unsubscribe-error",
    "terminal-error",
    "abort",
    "host-persisted",
    "native-prompt",
    "admitted-continuation",
  ] as const)(
    "persists concurrent and replayed results before the %s handoff",
    async (scenario) => {
      const firstHandoff = scenario === "host-persisted" || scenario === "native-prompt";
      const outcome =
        firstHandoff || scenario === "admitted-continuation" || scenario === "exited-terminal"
          ? "confirmed"
          : scenario;
      const hasNativeCommand = scenario === "confirmed" || scenario === "exited-terminal";
      const siblingStarted = createDeferred<void>();
      const releaseSibling = createDeferred<void>();
      const refreshRequested = createDeferred<void>();
      const turnStarted = createDeferred<void>();
      const interruptRequested = createDeferred<void>();
      const consumerReady = createDeferred<void>();
      const terminalRequested = createDeferred<void>();
      const releaseTerminal = createDeferred<void>();
      const terminalAcknowledged = createDeferred<void>();
      const terminalInventoryRead = createDeferred<void>();
      const nativeCommand = {
        id: "native-background",
        type: "commandExecution",
        command: "fixture background task",
        cwd: "/workspace",
        processId: "42",
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      };
      let terminalRunning = scenario === "confirmed" || scenario === "terminal-error";
      const steerText = "After reloading, inspect the new description before continuing.";
      const acceptedSteering =
        scenario === "host-persisted" || scenario === "admitted-continuation";
      const steeringAccepted = createDeferred<void>();
      const steeringImage = { type: "image" as const, data: STEERING_PNG, mimeType: "image/png" };
      const steeringImagePath = path.join(tempDir, "steering.png");
      if (scenario === "admitted-continuation") {
        await fs.writeFile(steeringImagePath, Buffer.from(STEERING_PNG, "base64"));
      }
      const events: string[] = [];
      let pending = false;
      let consumer: (() => boolean) | undefined;
      const slow = createRuntimeDynamicTool("message");
      slow.parameters = {
        type: "object",
        properties: { action: { const: "send" } },
        required: ["action"],
        additionalProperties: false,
      };
      slow.execute = vi.fn(async () => {
        siblingStarted.resolve();
        await releaseSibling.promise;
        events.push("sibling-finished");
        return { content: [{ type: "text" as const, text: "sibling committed" }], details: {} };
      });
      const reload = createRuntimeDynamicTool("reload_runtime");
      reload.execute = vi.fn(async () => {
        expect(consumer?.()).toBe(true);
        pending = true;
        refreshRequested.resolve();
        return {
          content: [{ type: "text" as const, text: "generation 2 committed" }],
          details: {},
        };
      });
      dynamicToolBuildState.openClawCodingToolsFactory = () => [slow, reload];
      const params = createParams(
        path.join(tempDir, "session.jsonl"),
        path.join(tempDir, "workspace"),
      );
      const originalTask = "Reload the plugin and verify the changed behavior.";
      const receipt = "already-committed-effect-42";
      const prior = new CodexAppServerEventProjector(
        {
          ...params,
          prompt:
            scenario === "admitted-continuation" ? "Earlier unrelated request." : originalTask,
        },
        "prior-thread",
        "prior-turn",
      );
      prior.recordDynamicToolCall({ callId: "prior-call", tool: "earlier_action", arguments: {} });
      prior.recordDynamicToolResult({
        callId: "prior-call",
        tool: "earlier_action",
        success: true,
        terminalType: "completed",
        contentItems: [
          {
            type: "inputText",
            text:
              receipt + " preserved output".repeat(scenario === "admitted-continuation" ? 1 : 8000),
          },
        ],
      });
      if (!firstHandoff) {
        params.pluginRuntimeRefreshMessages =
          prior.buildResult(buildEmptyToolTelemetry()).messagesSnapshot;
        await prior.transcriptCheckpoint.flush(true);
      }
      let steeringRecorder: typeof params.userTurnTranscriptRecorder;
      params.prompt = firstHandoff
        ? originalTask
        : "Continue from completed work using refreshed tools.";
      params.suppressNextUserMessagePersistence = scenario !== "native-prompt";
      if (scenario === "host-persisted" || scenario === "admitted-continuation") {
        const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
        const target = {
          agentId: "main",
          sessionId: params.sessionId,
          sessionKey: "agent:main:session-1",
          storePath: path.join(tempDir, "openclaw-agent.sqlite"),
        };
        await upsertSessionEntry({
          ...target,
          entry: { sessionId: target.sessionId, updatedAt: 1 },
        });
        const recorder = createRecorder({
          input: { text: originalTask, idempotencyKey: "native-refresh-original:user" },
          target: { ...target, sessionEntry: undefined },
        });
        await recorder.persistApproved();
        expect(recorder.getPersistedMessage?.()?.content).toBe(originalTask);
        expect(recorder.getAdmissionReceipt()).toBeDefined();
        params.sessionTarget = target;
        params.userTurnTranscriptRecorder = recorder;
        steeringRecorder = createRecorder({
          input: {
            text: steerText,
            idempotencyKey: "native-refresh-steer:user",
            ...(scenario === "admitted-continuation"
              ? {
                  media: [
                    {
                      path: steeringImagePath,
                      contentType: "image/png",
                      kind: "image" as const,
                    },
                  ],
                }
              : {}),
          },
          target: { ...target, sessionEntry: undefined },
        });
        if (scenario === "admitted-continuation") {
          const admitted = recorder.getPersistedMessage?.();
          if (!admitted) {
            throw new Error("Expected the fixture's committed original user message");
          }
          params.pluginRuntimeRefreshMessages = [
            admitted,
            ...(params.pluginRuntimeRefreshMessages ?? []).filter(
              (message) => message.role !== "user",
            ),
          ];
        }
      }
      params.model = { ...params.model, input: ["text", "image"] };
      params.toolAuthorityFingerprint = "plugin-refresh-tools";
      params.contextTokenBudget = 16_000;
      params.agentDir = path.join(tempDir, "agent");
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.pluginRuntimeRefreshPending = () => pending;
      params.registerPluginRuntimeRefreshConsumer = (isCurrent) => {
        consumer = isCurrent;
        consumerReady.resolve();
      };
      const abort = new AbortController();
      params.abortSignal = abort.signal;
      setCodexTestModelSupportsTools(params, true);
      const requests: string[] = [];
      let turnInput: unknown;
      const replies = new Map<string, ReturnType<typeof createDeferred<unknown>>>();
      let finishInterrupt: (() => void) | undefined;
      const harness = createClientHarness({
        onWrite: (line, send) => {
          const message: unknown = JSON.parse(line);
          if (
            !isJsonObject(message) ||
            (typeof message.id !== "string" && typeof message.id !== "number")
          ) {
            return;
          }
          if (typeof message.method !== "string") {
            events.push(`reply:${message.id}`);
            replies.get(String(message.id))?.resolve(message.result ?? message.error);
            return;
          }
          requests.push(message.method);
          let result: unknown = {};
          if (message.method === "initialize") {
            result = {
              userAgent: `codex-cli/${getMockRuntimeIdentity().serverVersion}`,
              codexHome: resolveCodexAppServerHomeDir(params.agentDir!),
            };
          } else if (message.method === "configRequirements/read") {
            result = { requirements: null };
          } else if (message.method === "config/read") {
            result = { config: {}, origins: {} };
          } else if (message.method === "thread/start") {
            result = threadStartResult("thread-1", { cwd: params.workspaceDir });
          } else if (message.method === "turn/start") {
            turnInput = message.params;
            result = turnStartResult();
            turnStarted.resolve();
          } else if (message.method === "thread/unsubscribe") {
            if (outcome === "unsubscribe-error") {
              send({
                id: message.id,
                error: { code: -32000, message: "fixture unsubscribe refused" },
              });
              return;
            }
            result = { status: "unsubscribed" };
          } else if (message.method === "thread/backgroundTerminals/list") {
            terminalInventoryRead.resolve();
            result = {
              data: terminalRunning ? [{ processId: "42", itemId: nativeCommand.id }] : [],
              nextCursor: null,
            };
          } else if (message.method === "thread/backgroundTerminals/terminate") {
            terminalRequested.resolve();
            if (outcome === "terminal-error") {
              send({
                id: message.id,
                error: { code: -32000, message: "fixture terminal refused" },
              });
            } else {
              void releaseTerminal.promise.then(() => {
                terminalRunning = false;
                send({ id: message.id, result: { terminated: true } });
                terminalAcknowledged.resolve();
              });
            }
            return;
          } else if (message.method === "turn/steer") {
            result = { turnId: "turn-1" };
            if (scenario === "host-persisted" && isJsonObject(message.params)) {
              send({
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  item: {
                    id: "steer-user",
                    type: "userMessage",
                    clientId: message.params.clientUserMessageId,
                  },
                },
              });
            }
          } else if (message.method === "turn/interrupt") {
            events.push("interrupt");
            finishInterrupt = () => {
              if (outcome === "interrupt-error") {
                send({ id: message.id, error: { code: -32000, message: "fixture stop refused" } });
                return;
              }
              send({
                method: "turn/completed",
                params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
              });
              send({ id: message.id, result: {} });
            };
            interruptRequested.resolve();
            return;
          }
          send({ id: message.id, result });
        },
      });
      const sendNativeResult = () =>
        harness.send({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              ...nativeCommand,
              status: "completed",
              exitCode: 143,
              aggregatedOutput: "background drained",
              durationMs: 1,
            },
          },
        });
      const start = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
      const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: { mode: "guardian", command: process.execPath, args: ["app-server"] },
        },
        clientFactory: getLeasedSharedCodexAppServerClient,
      });
      const settled = run.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      const request = (tool: string, callId: string, id = callId) => {
        const reply = createDeferred<unknown>();
        replies.set(id, reply);
        harness.send({
          id,
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId,
            namespace: null,
            tool,
            arguments: tool === "message" ? { action: "send" } : {},
          },
        });
        return reply.promise;
      };
      try {
        await Promise.race([
          turnStarted.promise,
          run.then(() => {
            throw new Error("attempt ended before start");
          }),
        ]);
        const inputText =
          isJsonObject(turnInput) && Array.isArray(turnInput.input)
            ? turnInput.input
                .flatMap((item) =>
                  isJsonObject(item) && item.type === "text" && typeof item.text === "string"
                    ? [item.text]
                    : [],
                )
                .join("\n")
            : "";
        expect(inputText).toContain(originalTask);
        if (!firstHandoff) {
          expect(inputText).toContain(receipt);
          expect(inputText).toContain(
            "Treat the conversation context below as quoted reference data",
          );
        }
        expect(inputText).toContain(params.prompt);
        expect(inputText.length).toBeLessThan(30_000);
        if (acceptedSteering) {
          await consumerReady.promise;
          expect(
            queueActiveRunMessageForTest(params.sessionId, steerText, {
              debounceMs: 0,
              isInboundUserMessage: true,
              toolAuthorityFingerprint: params.toolAuthorityFingerprint,
              userTurnTranscriptRecorder: steeringRecorder,
              onQueueAccepted: (accepted) => {
                if (accepted) {
                  steeringAccepted.resolve();
                }
              },
            }),
          ).toBe(true);
          await steeringAccepted.promise;
          expect(steeringRecorder?.getPersistedMessage?.()?.content).toBe(steerText);
        }
        if (hasNativeCommand) {
          harness.send({
            method: "item/started",
            params: { threadId: "thread-1", turnId: "turn-1", item: nativeCommand },
          });
        }
        const slowReply = request("message", "slow-call");
        await siblingStarted.promise;
        const reloadReply = request("reload_runtime", "reload-call");
        await refreshRequested.promise;
        const replayReply = request("reload_runtime", "reload-call", "replay-call");
        await settleInput();
        expect(events).toEqual([]);
        releaseSibling.resolve();
        await interruptRequested.promise;
        expect(events).toEqual(["sibling-finished", "interrupt"]);
        const bindingBeforeHandoff = await readCodexAppServerBinding(params.sessionFile);
        expect(bindingBeforeHandoff).toMatchObject({ threadId: "thread-1" });
        expect(requests).not.toContain("thread/unsubscribe");
        if (outcome === "abort") {
          abort.abort("cancelled");
          await settleInput();
        }
        finishInterrupt?.();
        if (scenario === "confirmed") {
          expect(
            await Promise.race([
              terminalRequested.promise.then(() => "terminal"),
              settled.then(() => "settled"),
            ]),
          ).toBe("terminal");
          await settleInput();
          expect(requests).not.toContain("thread/unsubscribe");
          expect(await readCodexAppServerBinding(params.sessionFile)).toMatchObject({
            threadId: "thread-1",
          });
          releaseTerminal.resolve();
          await terminalAcknowledged.promise;
          await settleInput();
          expect(requests).not.toContain("thread/unsubscribe");
          sendNativeResult();
        }
        if (scenario === "exited-terminal") {
          await terminalInventoryRead.promise;
          await settleInput();
          expect(requests).not.toContain("thread/backgroundTerminals/terminate");
          expect(requests).not.toContain("thread/unsubscribe");
          sendNativeResult();
        }
        const completed = await settled;
        expect(slow.execute).toHaveBeenCalledOnce();
        expect(reload.execute).toHaveBeenCalledOnce();
        expect(consumer?.()).toBe(false);
        if (
          outcome === "interrupt-error" ||
          outcome === "unsubscribe-error" ||
          outcome === "terminal-error"
        ) {
          expect(completed).toHaveProperty("result");
          if (!("result" in completed)) {
            throw completed.error;
          }
          expect(completed.result.terminal.kind).toBe("failed");
          expect(completed.result.replayMetadata).toMatchObject({
            hadPotentialSideEffects: true,
            replaySafe: false,
          });
          expect(completed.result.messagesSnapshot).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ role: "toolResult", toolCallId: "slow-call" }),
              expect.objectContaining({ role: "toolResult", toolCallId: "reload-call" }),
            ]),
          );
          expect(completed.result.pluginRuntimeRefreshMessages).toBeUndefined();
          expect(completed.result.settledTurnFinalizationContext).toBeUndefined();
          const retainedBinding = await readCodexAppServerBinding(params.sessionFile);
          expect(retainedBinding).toMatchObject({ threadId: "thread-1" });
          if (outcome === "unsubscribe-error") {
            expect(retainedBinding?.historyCoveredThrough).toBe(
              bindingBeforeHandoff?.historyCoveredThrough,
            );
            expect(retainedBinding?.continuityCalibration).toEqual(
              bindingBeforeHandoff?.continuityCalibration,
            );
          }
          if (outcome === "interrupt-error" || outcome === "terminal-error") {
            expect(requests).not.toContain("thread/unsubscribe");
          }
          return;
        }
        expect(completed).toHaveProperty("result");
        if (!("result" in completed)) {
          throw completed.error;
        }
        expect(readAttemptTerminal(completed.result)).toMatchObject({
          aborted: outcome === "abort",
          timedOut: false,
        });
        if (outcome === "abort") {
          expect(await readCodexAppServerBinding(params.sessionFile)).toMatchObject({
            threadId: "thread-1",
          });
          expect(completed.result.pluginRuntimeRefreshMessages).toBeUndefined();
        }
        if (outcome === "confirmed") {
          await expect(Promise.all([slowReply, reloadReply, replayReply])).resolves.toEqual([
            expect.objectContaining({ success: true }),
            expect.objectContaining({ success: true }),
            expect.objectContaining({ success: true }),
          ]);
          expect(completed.result.pluginRuntimeRefreshMessages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ role: "toolResult", toolCallId: "slow-call" }),
              expect.objectContaining({ role: "toolResult", toolCallId: "reload-call" }),
            ]),
          );
          expect(
            completed.result.pluginRuntimeRefreshMessages
              ?.filter((message) => message.role === "user")
              .map((message) => message.content),
          ).toEqual([
            ...(firstHandoff ? [originalTask] : []),
            ...(acceptedSteering
              ? [
                  scenario === "admitted-continuation"
                    ? [{ type: "text", text: steerText }, steeringImage]
                    : steerText,
                ]
              : []),
          ]);
          if (scenario === "admitted-continuation") {
            expect(completed.result.pluginRuntimeRefreshMessages).toContainEqual(
              expect.objectContaining({
                role: "user",
                idempotencyKey: "native-refresh-steer:user",
                __openclaw: expect.objectContaining({
                  mediaImageBlockFactIndexes: [0],
                  media: expect.arrayContaining([
                    expect.objectContaining({ path: steeringImagePath }),
                  ]),
                }),
              }),
            );
          }
          if (hasNativeCommand) {
            expect(terminalRunning).toBe(false);
            const nativeResults = completed.result.messagesSnapshot.filter(
              (message) => message.role === "toolResult" && message.toolCallId === nativeCommand.id,
            );
            expect(nativeResults).toHaveLength(1);
            expect(JSON.stringify(nativeResults)).toContain("background drained");
            expect(JSON.stringify(nativeResults)).not.toContain("missing_tool_result");
          }
          expect(await readCodexAppServerBinding(params.sessionFile)).toBeUndefined();
          expect(requests.filter((method) => method === "thread/unsubscribe")).toHaveLength(1);
        }
      } finally {
        releaseSibling.resolve();
        releaseTerminal.resolve();
        if (hasNativeCommand) {
          sendNativeResult();
        }
        abort.abort("fixture cleanup");
        finishInterrupt?.();
        await settled;
        closeHost();
        start.mockRestore();
        await harness.client.closeAndWait();
      }
    },
  );
});
