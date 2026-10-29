import "../test-helpers/fast-coding-tools.js";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createReplyActorFixture } from "../../auto-reply/reply/reply-actor.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { OutboundHandoffRejectedError } from "../../infra/outbound/deliver-handoff.js";
import * as messageActionRunner from "../../infra/outbound/message-action-runner.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { disposeAllSessionMcpRuntimes } from "../agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agent-bundle-mcp-manager.test-support.js";
import {
  pluginToolWithExecute,
  resetCodeModeTestState,
  testing,
} from "../code-mode.test-support.js";
import { captureAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import type { StreamFn } from "../runtime/index.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { createQueuedAssistantStream } from "../test-helpers/assistant-event-stream.test-support.js";
import {
  buildEmbeddedRunnerAssistant,
  createEmbeddedAgentRunnerOpenAiConfig,
  createResolvedEmbeddedRunnerModel,
  immediateEnqueue,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "../test-helpers/embedded-agent-runner-e2e-mocks.js";
import { jsonResult, type AnyAgentTool } from "../tools/common.js";
import type { MessageToolOptions } from "../tools/message-tool-execution.types.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./run/types.js";

const plugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "refreshchat",
    capabilities: { chatTypes: ["group"] },
    config: { resolveAccount: () => ({ enabled: true }), isConfigured: () => true },
  }),
  messaging: {
    normalizeTarget: (target) => target.replace(/^channel:/, ""),
    targetResolver: { looksLikeId: (target) => target === "C123" },
  },
  actions: {
    describeMessageTool: () => ({ actions: ["send"] }),
    resolveExecutionMode: () => "gateway",
    handleAction: vi.fn(),
  },
};
const registry = createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]);
const transport = vi.fn();
const runMessageAction = messageActionRunner.runMessageAction;
let messageActionRunnerSpy: MockInstance<typeof runMessageAction> | undefined;
const providerStream = vi.fn<StreamFn>();
const messageTools: AnyAgentTool[] = [];
const messageExecutions: MockInstance<AnyAgentTool["execute"]>[] = [];
const attemptInputs: Array<
  Pick<EmbeddedRunAttemptParams, "operation" | "disableTools"> & {
    settled?: ReturnType<typeof snapshotAttempt>;
  }
> = [];
const attemptResults: EmbeddedRunAttemptResult[] = [];
const events: string[] = [];
let beforeBuildMessage: () => void;
let requestRefresh: (signal?: AbortSignal) => Promise<void>;
let state: OpenClawTestState;

function diagnosticText(value: unknown): string | undefined {
  const text =
    value instanceof Error ? value.message : typeof value === "string" ? value : undefined;
  return text?.slice(0, 512);
}

function snapshotAttempt(result: EmbeddedRunAttemptResult, params: EmbeddedRunAttemptParams) {
  return {
    terminal: result.terminal.kind,
    stopReason: diagnosticText(result.lastAssistant?.stopReason),
    didSendViaMessagingTool: result.didSendViaMessagingTool,
    didDeliverSourceReplyViaMessageTool: result.didDeliverSourceReplyViaMessageTool,
    sourceReplyDelivered: result.sourceReplyDelivered,
    sourceReplyDeliveryState: result.sourceReplyDeliveryState,
    finalTargets: result.messagingToolSentTargets.filter(
      (target) => target.sourceReplyFinal === true,
    ).length,
    finalPayloads: result.messagingToolSourceReplyPayloads?.filter(
      (payload) => payload.sourceReplyFinal === true,
    ).length,
    operationSourceReplyDelivered: params.replyOperation?.sourceReplyDelivered,
  };
}

// Prepared catalogs, auth and external I/O are fixture inputs. Keep the real
// harness and attempt owners for tool authority, persistence and release.
installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full", pluginRegistry: registry });
installEmbeddedRunnerFastRunE2eMocks({
  runEmbeddedAttempt: async (params) => {
    const observation: (typeof attemptInputs)[number] = {
      operation: params.operation ?? "attempt",
      disableTools: params.disableTools === true,
    };
    attemptInputs.push(observation);
    const { runEmbeddedAttempt } =
      await vi.importActual<typeof import("./run/attempt.js")>("./run/attempt.js");
    const result = await runEmbeddedAttempt(params);
    // The outer runner mutates delivery projections after this return. Preserve
    // producer facts here so diagnostics cannot mistake inherited state for them.
    observation.settled = snapshotAttempt(result, params);
    attemptResults.push(result);
    events.push(`attempt:${attemptResults.length}:settled`);
    return result;
  },
});
// Restore the whole lifecycle boundary, not isolated exports: selection binds
// tool authority, while init/registry retain the logical turn's context engine.
vi.doUnmock("../../context-engine/init.js");
vi.doUnmock("../../context-engine/registry.js");
vi.doUnmock("../harness/selection.js");
vi.doUnmock("../runtime-plan/build.js");
vi.doUnmock("../../plugins/provider-runtime.js");
vi.doUnmock("../../plugins/provider-hook-runtime.js");
vi.doMock("../provider-stream.js", async () => ({
  ...(await vi.importActual<typeof import("../provider-stream.js")>("../provider-stream.js")),
  registerProviderStreamForModel: () => providerStream,
}));
vi.doMock("./model.js", async () => ({
  ...(await vi.importActual<typeof import("./model.js")>("./model.js")),
  resolveModelAsync: async (provider: string, modelId: string) => {
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(provider, "synthetic-fixture-key");
    return {
      ...createResolvedEmbeddedRunnerModel(provider, modelId),
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
    };
  },
}));
vi.doMock("../tools/message-tool-execution.js", async () => {
  const actual = await vi.importActual<typeof import("../tools/message-tool-execution.js")>(
    "../tools/message-tool-execution.js",
  );
  const record = (tool: AnyAgentTool) => {
    messageTools.push(tool);
    messageExecutions.push(vi.spyOn(tool, "execute"));
    events.push(`message:${messageTools.length}:built`);
    return tool;
  };
  return {
    ...actual,
    createMessageTool: (input?: MessageToolOptions) => {
      beforeBuildMessage();
      return record(actual.createMessageTool(input));
    },
    createMessageToolAsync: async (input?: MessageToolOptions) => {
      beforeBuildMessage();
      return record(await actual.createMessageToolAsync(input));
    },
  };
});
vi.doMock("../../plugins/tools.js", async () => ({
  ...(await vi.importActual<typeof import("../../plugins/tools.js")>("../../plugins/tools.js")),
  resolvePluginTools: () => [
    pluginToolWithExecute(
      "reload_runtime",
      "Request a deferred plugin refresh",
      async (_id, _args, signal) => {
        await requestRefresh(signal);
        return { ...jsonResult({ requested: true }), terminate: true };
      },
    ),
  ],
}));
const { runEmbeddedAgent } = await import("./run.js");

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "reply-refresh" });
  await bindSessionMcpRuntimeTestScheduler();
  messageTools.length = 0;
  messageExecutions.length = 0;
  attemptInputs.length = 0;
  attemptResults.length = 0;
  events.length = 0;
  transport.mockReset();
  providerStream.mockReset();
  messageActionRunnerSpy = vi
    .spyOn(messageActionRunner, "runMessageAction")
    .mockImplementation((action) =>
      runMessageAction({
        ...action,
        gateway: {
          request: transport,
          clientName: "gateway-client",
          mode: "backend",
        },
      }),
    );
  setActivePluginRegistry(registry);
});

afterEach(async () => {
  try {
    await resetCodeModeTestState();
  } finally {
    try {
      await disposeAllSessionMcpRuntimes();
    } finally {
      try {
        await state?.cleanup();
      } finally {
        messageActionRunnerSpy?.mockRestore();
        messageActionRunnerSpy = undefined;
      }
    }
  }
});

describe("ordinary source reply across deferred plugin refresh", () => {
  it.for(["confirmed", "not-dispatched", "ambiguous"] as const)(
    "preserves %s delivery facts when the runner rebuilds its message tool",
    async (outcome, context) => {
      const sourceTurnId = `source-${outcome}`;
      const identity = {
        agentId: "main",
        runId: `run-${outcome}`,
        sessionId: `session-${outcome}`,
        sessionKey: `agent:main:refreshchat:group:${outcome}`,
      };
      const scope = {
        ...identity,
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      const config: OpenClawConfig = {
        ...createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]),
        channels: { refreshchat: { enabled: true } },
        session: { store: scope.storePath },
        skills: { load: { watch: false } },
        tools: { codeMode: true, allow: ["message", "reload_runtime", "exec", "wait"] },
      };
      setRuntimeConfigSnapshot(config);
      const entry: InternalSessionEntry = { sessionId: identity.sessionId, updatedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const operation = createReplyOperation({ ...identity, resetTriggered: false });
      await using actor = createReplyActorFixture({
        ...scope,
        operation,
        getSessionId: () => identity.sessionId,
      });
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          role: "user",
          content: "Send the result, then refresh.",
          idempotencyKey: sourceTurnId,
          timestamp: 1,
        },
        target: { ...scope, sessionEntry: entry },
        updateMode: "none",
      });
      await actor.bind();
      await recorder.persistApproved();
      expect(recorder.hasPersisted()).toBe(true);

      const started = createDeferred();
      const release = createDeferred();
      const parked = createDeferred();
      const physicalSend = vi.fn(() => ({ ok: true, messageId: "reply-1", toJid: "C123" }));
      let refreshOwner: ReturnType<typeof captureAgentPluginRuntimeRefresh> | undefined;
      transport.mockImplementation(async () => {
        if (transport.mock.calls.length === 1) {
          // Hold the response after the effect; only a definite refusal never sends.
          const reply = outcome !== "not-dispatched" ? physicalSend() : undefined;
          started.resolve();
          await release.promise;
          if (outcome === "not-dispatched") {
            events.push("transport:refused");
            throw new OutboundHandoffRejectedError(new Error("fixture refused before dispatch"));
          }
          if (outcome === "ambiguous") {
            events.push("transport:unknown");
            // An unstructured provider failure cannot prove whether dispatch happened.
            throw Object.assign(new Error("fixture lost the reply after dispatch"), {
              name: "GatewayClientRequestError",
              gatewayCode: "UNAVAILABLE",
            });
          }
          events.push("transport:acknowledged");
          return reply;
        }
        events.push("transport:sent");
        return physicalSend();
      });
      requestRefresh = async (signal) => {
        await withinTest(started.promise, signal ?? abort.signal);
        signal?.throwIfAborted();
        abort.signal.throwIfAborted();
        refreshOwner = captureAgentPluginRuntimeRefresh();
        expect(refreshOwner.request()).toBe(true);
        events.push("refresh:requested");
      };
      beforeBuildMessage = () => {
        if (messageTools.length === 0) {
          return;
        }
        expect(messageTools).toHaveLength(1);
        expect(attemptResults).toHaveLength(1);
        expect(attemptResults[0]?.terminal.kind).toBe("ok");
        expect(testing.activeRuns.size).toBe(0);
        expect(attemptResults[0]?.didSendViaMessagingTool).toBe(outcome === "confirmed");
        if (outcome === "ambiguous") {
          expect(events).toContain("transport:unknown");
        }
      };
      const sentForGeneration = new Set<number>();
      let previousCall: { id: string; name: string; generation: number } | undefined;
      providerStream.mockImplementation((_model, providerContext) => {
        const generation = messageTools.length;
        const previous = previousCall;
        // Provider projection strips private details and may append context after
        // a tool result. Follow the matched visible control, not transcript position.
        const last = previous
          ? providerContext.messages.findLast(
              (message) => message.role === "toolResult" && message.toolCallId === previous.id,
            )
          : undefined;
        const controlText =
          last?.role === "toolResult"
            ? last.content.find((part) => part.type === "text")?.text
            : undefined;
        let details: Record<string, unknown> | undefined;
        if (previous) {
          const assistant = providerContext.messages.findLast(
            (message) =>
              message.role === "assistant" &&
              message.content.some((part) => part.type === "toolCall" && part.id === previous.id),
          );
          expect(assistant).toMatchObject({
            content: expect.arrayContaining([
              expect.objectContaining({ type: "toolCall", id: previous.id, name: previous.name }),
            ]),
          });
          expect(last).toMatchObject({ toolName: previous.name, isError: false });
          expect(controlText).toBeTypeOf("string");
          details = asOptionalRecord(JSON.parse(controlText ?? ""));
          expect(details?.status).toMatch(/^(waiting|completed)$/);
          if (previous.generation !== generation) {
            expect(details?.status).toBe("completed");
          }
        }
        let call: { name: string; arguments: Record<string, unknown> } | undefined;
        if (details?.status === "waiting") {
          expect(details.runId).toEqual(expect.stringMatching(/\S/));
          if (generation === 1) {
            parked.resolve();
          }
          call = { name: "wait", arguments: { runId: details.runId } };
        } else if (
          !sentForGeneration.has(generation) &&
          (generation === 1 || outcome === "not-dispatched")
        ) {
          sentForGeneration.add(generation);
          const send =
            'message({ action: "send", target: "C123", message: "The result.", final: true })';
          call = {
            name: "exec",
            arguments: {
              title: "Deliver the source reply",
              code:
                generation === 1
                  ? `const pending = ${send}.then(value => ({ value }), error => ({ error: String(error) })); await reload_runtime({}); await yield_control(); return await pending;`
                  : `return await ${send};`,
            },
          };
        }
        events.push(
          JSON.stringify({
            stream: providerStream.mock.calls.length,
            generation,
            action: call?.name ?? "final",
            control: diagnosticText(details?.status),
            error: diagnosticText(asOptionalRecord(details?.error)?.message ?? details?.error),
            toolText:
              last?.role === "toolResult"
                ? last.content
                    .filter((part) => part.type === "text")
                    .slice(0, 2)
                    .map((part) => part.text.slice(0, 256))
                    .join("\n")
                : undefined,
          }),
        );
        const toolCallId = `call_${generation}_${providerStream.mock.calls.length}`;
        if (call) {
          previousCall = { id: toolCallId, name: call.name, generation };
        }
        const message = buildEmbeddedRunnerAssistant({
          content: call
            ? [
                {
                  type: "toolCall",
                  id: toolCallId,
                  ...call,
                },
              ]
            : [{ type: "text", text: "The result." }],
          stopReason: call ? "toolUse" : "stop",
        });
        return createQueuedAssistantStream((push) => {
          push({ type: "done", reason: call ? "toolUse" : "stop", message });
        });
      });

      const abort = new AbortController();
      const admission = prepareSystemAgentRunAdmission(
        config,
        identity.runId,
        "main",
        "reply-refresh-test",
      );
      const capability = mintMessageActionTurnCapability({
        ...identity,
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "refreshchat",
          currentChannelId: "C123",
          currentMessagingTarget: "C123",
          currentMessageId: "inbound-message",
          currentSourceTurnId: sourceTurnId,
        },
      });
      const running = runEmbeddedAgent({
        ...identity,
        config,
        preparedRunAdmission: admission,
        replyOperation: operation,
        sessionTarget: scope,
        workspaceDir: state.workspaceDir,
        agentDir: state.agentDir(),
        provider: "openai",
        model: "mock-1",
        agentHarnessId: "openclaw",
        prompt: "Send the result, then refresh.",
        messageActionTurnCapability: capability,
        currentMessageId: "inbound-message",
        currentChannelId: "C123",
        messageChannel: "refreshchat",
        agentAccountId: "default",
        messageTo: "C123",
        currentMessagingTarget: "C123",
        suppressNextUserMessagePersistence: true,
        sourceReplyDeliveryMode: "message_tool_only",
        disableTools: false,
        disableMessageTool: false,
        abortSignal: abort.signal,
        timeoutMs: 30_000,
        enqueue: immediateEnqueue,
      });
      const settled = running.then(
        () => "settled" as const,
        () => "settled" as const,
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            parked.promise,
            running.then((result) => {
              // Resolved semantic failures need their own diagnostics; leave actual
              // rejections untouched and retain the original promise for cleanup.
              throw new Error("run settled before deferred refresh parked", {
                cause: {
                  error: result.meta.error && {
                    kind: result.meta.error.kind,
                    message: diagnosticText(result.meta.error.message),
                  },
                  stopReason: diagnosticText(result.meta.stopReason),
                  aborted: result.meta.aborted,
                  attempts: attemptResults.slice(-4).map(({ terminal, lastAssistant }) => ({
                    terminal: terminal.kind,
                    source: terminal.kind === "ok" ? undefined : terminal.source,
                    error: diagnosticText(
                      terminal.kind === "failed"
                        ? terminal.error
                        : terminal.kind === "ok"
                          ? undefined
                          : terminal.failure?.error,
                    ),
                    stopReason: diagnosticText(lastAssistant?.stopReason),
                  })),
                  providerCalls: providerStream.mock.calls.length,
                  messageCalls: messageExecutions.slice(-4).map((spy) => spy.mock.calls.length),
                  transportCalls: transport.mock.calls.length,
                  effects: physicalSend.mock.calls.length,
                  events: events.slice(-12),
                },
              });
            }),
            "run settled before deferred refresh parked",
          ),
          context.signal,
        );
        expect(messageTools).toHaveLength(1);
        expect(attemptResults).toHaveLength(0);
        expect(refreshOwner?.isRequested()).toBe(true);
        expect(refreshOwner?.isPending()).toBe(false);
        expect(physicalSend).toHaveBeenCalledTimes(outcome !== "not-dispatched" ? 1 : 0);
        release.resolve();
        const result = await withinTest(running, context.signal);
        expect(result.meta.error).toBeUndefined();
        const settlementDiagnostics = JSON.stringify({
          attempts: attemptInputs.slice(-4),
          providerCalls: providerStream.mock.calls.length,
          messageCalls: messageExecutions.slice(-4).map((spy) => spy.mock.calls.length),
          transportCalls: transport.mock.calls.length,
          effects: physicalSend.mock.calls.length,
          events: events.slice(-12).map((event) => event.slice(0, 512)),
        });
        expect(messageTools, settlementDiagnostics).toHaveLength(2);
        expect(messageTools[1]).not.toBe(messageTools[0]);
        expect(messageExecutions[1]).toHaveBeenCalledTimes(outcome === "not-dispatched" ? 1 : 0);
        expect(events.indexOf("message:2:built")).toBeGreaterThan(
          events.indexOf("attempt:1:settled"),
        );
        expect(physicalSend).toHaveBeenCalledOnce();
        expect(transport).toHaveBeenCalledTimes(outcome === "not-dispatched" ? 2 : 1);
        if (outcome === "ambiguous") {
          expect(result.didSendViaMessagingTool).toBe(false);
          expect(result.didDeliverSourceReplyViaMessageTool).not.toBe(true);
          expect(result.sourceReplyDelivered).not.toBe(true);
          expect(result.sourceReplyDeliveryState).not.toBe("delivered");
          expect(result.meta.agentMeta?.terminalReceipt?.sourceReplyDelivered).not.toBe(true);
          expect(operation.sourceReplyDelivered).not.toBe(true);
          for (const input of attemptInputs) {
            expect(input.settled, settlementDiagnostics).toBeDefined();
            expect(input.settled?.terminal, settlementDiagnostics).toBe("ok");
            expect(input.settled?.didSendViaMessagingTool).not.toBe(true);
            expect(input.settled?.didDeliverSourceReplyViaMessageTool).not.toBe(true);
            expect(input.settled?.sourceReplyDelivered).not.toBe(true);
            expect(input.settled?.sourceReplyDeliveryState).not.toBe("delivered");
            expect(input.settled?.finalTargets).toBe(0);
            expect(input.settled?.finalPayloads).toBe(0);
            expect(input.settled?.operationSourceReplyDelivered).not.toBe(true);
          }
        } else {
          expect(result.didSendViaMessagingTool).toBe(true);
        }
        expect(
          loadTranscriptEventsSync(scope).filter((event) => {
            const message = asOptionalRecord(asOptionalRecord(event)?.message);
            return message?.role === "user" && message.idempotencyKey === sourceTurnId;
          }),
        ).toHaveLength(1);
        expect(testing.activeRuns.size).toBe(0);
        if (outcome !== "ambiguous") {
          expect(
            attemptResults.map((attempt) => attempt.terminal.kind),
            settlementDiagnostics,
          ).toEqual(["ok", "ok"]);
        }
      } finally {
        release.resolve();
        abort.abort();
        try {
          await settled;
        } finally {
          admission.close();
          revokeMessageActionTurnCapability(capability);
        }
      }
    },
  );
});
