import "../test-helpers/fast-coding-tools.js";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "../../auto-reply/reply/restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "../../auto-reply/reply/restart-recovery-claim.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { loadTranscriptEventsSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { OutboundHandoffRejectedError } from "../../infra/outbound/deliver-handoff.js";
import { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
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
import { readToolResultDetails } from "../tool-result-error.js";
import { jsonResult, type AnyAgentTool } from "../tools/common.js";
import type { MessageToolOptions } from "../tools/message-tool-execution.types.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

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
const providerStream = vi.fn<StreamFn>();
const messageTools: AnyAgentTool[] = [];
const messageExecutions: MockInstance<AnyAgentTool["execute"]>[] = [];
const attemptResults: EmbeddedRunAttemptResult[] = [];
const events: string[] = [];
let beforeBuildMessage: () => void;
let requestRefresh: (signal?: AbortSignal) => Promise<void>;
let state: OpenClawTestState;

// Prepared catalogs, auth and external I/O are fixture inputs. Keep the real
// harness and attempt owners for tool authority, persistence and release.
installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full", pluginRegistry: registry });
installEmbeddedRunnerFastRunE2eMocks({
  runEmbeddedAttempt: async (params) => {
    const { runEmbeddedAttempt } =
      await vi.importActual<typeof import("./run/attempt.js")>("./run/attempt.js");
    const result = await runEmbeddedAttempt(params);
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
  const options = (input?: MessageToolOptions): MessageToolOptions => ({
    ...input,
    runMessageAction: (action) =>
      runMessageAction({
        ...action,
        gateway: {
          request: transport,
          terminalSourceReplyReceiptOwner: "caller",
          clientName: "gateway-client",
          mode: "backend",
        },
      }),
    getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
    resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
      resolvedConfig,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }),
  });
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
      return record(actual.createMessageTool(options(input)));
    },
    createMessageToolAsync: async (input?: MessageToolOptions) => {
      beforeBuildMessage();
      return record(await actual.createMessageToolAsync(options(input)));
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
  attemptResults.length = 0;
  events.length = 0;
  transport.mockReset();
  providerStream.mockReset();
  setActivePluginRegistry(registry);
});

afterEach(async () => {
  try {
    await resetCodeModeTestState();
  } finally {
    try {
      await disposeAllSessionMcpRuntimes();
    } finally {
      await state?.cleanup();
    }
  }
});

describe("ordinary source reply across deferred plugin refresh", () => {
  it.for(["confirmed", "not-dispatched"] as const)(
    "preserves the real %s receipt when the runner rebuilds its message tool",
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
      let entry: InternalSessionEntry = { sessionId: identity.sessionId, updatedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const operation = createReplyOperation({ ...identity, resetTriggered: false });
      await using actor = createReplyRecoveryActorFixture({
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
      const claim = createReplyRestartRecoveryClaimController({
        ...scope,
        sourceTurnId,
        admissionRunId: identity.runId,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        getEntry: () => entry,
        getSessionId: () => identity.sessionId,
        setEntry: (next) => {
          entry = next;
        },
        acquireSessionActor: () => actor.acquireSessionActor(),
        isRestartAbort: () => false,
        resolveDeliveryContext: () => ({ channel: "refreshchat", to: "C123" }),
        sourceReplyDeliveryMode: "message_tool_only",
      });
      expect(await claim.admitUserTurn(recorder)).toBe("admitted");
      expect(recorder.hasPersisted()).toBe(true);
      expect(loadSessionEntry(scope)).toMatchObject({
        restartRecoveryDeliveryRunId: identity.runId,
        restartRecoveryDeliverySourceRunId: sourceTurnId,
      });

      const started = createDeferred();
      const release = createDeferred();
      const parked = createDeferred();
      const physicalSend = vi.fn(() => ({ ok: true, messageId: "reply-1", toJid: "C123" }));
      let firstCallId: string | undefined;
      let refreshOwner: ReturnType<typeof captureAgentPluginRuntimeRefresh> | undefined;
      transport.mockImplementation(async () => {
        const current = loadSessionEntry(scope);
        expect(current?.restartRecoveryDeliveryReceiptState).toBe("terminal-pending");
        expect(current?.restartRecoveryDeliverySourceRunId).toBe(sourceTurnId);
        if (transport.mock.calls.length === 1) {
          firstCallId = current?.restartRecoveryDeliveryToolCallId;
          expect(firstCallId).toBeTypeOf("string");
          // A confirmed send holds only its ACK; refusal never dispatches an effect.
          const reply = outcome === "confirmed" ? physicalSend() : undefined;
          started.resolve();
          await release.promise;
          if (outcome === "not-dispatched") {
            events.push("transport:refused");
            throw new OutboundHandoffRejectedError(new Error("fixture refused before dispatch"));
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
        const current = loadSessionEntry(scope);
        expect(current?.restartRecoveryDeliverySourceRunId).toBe(sourceTurnId);
        if (outcome === "confirmed") {
          expect(current?.restartRecoveryDeliveryReceiptState).toBe("delivered-terminal");
          expect(current?.restartRecoveryDeliveryToolCallId).toBe(firstCallId);
          expect(attemptResults[0]?.didSendViaMessagingTool).toBe(true);
        } else {
          expect(current?.restartRecoveryDeliveryReceiptState).toBeUndefined();
          expect(current?.restartRecoveryDeliveryToolCallId).toBeUndefined();
          expect(attemptResults[0]?.didSendViaMessagingTool).toBe(false);
        }
      };
      const sentForGeneration = new Set<number>();
      providerStream.mockImplementation((_model, providerContext) => {
        const generation = messageTools.length;
        const last = providerContext.messages.at(-1);
        const details = last?.role === "toolResult" ? readToolResultDetails(last) : undefined;
        let call: { name: string; arguments: Record<string, unknown> } | undefined;
        if (details?.status === "waiting") {
          expect(details.runId).toBeTypeOf("string");
          if (generation === 1) {
            parked.resolve();
          }
          call = { name: "wait", arguments: { runId: details.runId } };
        } else if (!sentForGeneration.has(generation)) {
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
        const message = buildEmbeddedRunnerAssistant({
          content: call
            ? [
                {
                  type: "toolCall",
                  id: `call-${generation}-${providerStream.mock.calls.length}`,
                  ...call,
                },
              ]
            : [{ type: "text", text: "The result." }],
          stopReason: call ? "toolUse" : "stop",
        });
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
          stream.end();
        });
        return stream;
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
            running,
            "run settled before deferred refresh parked",
          ),
          context.signal,
        );
        expect(messageTools).toHaveLength(1);
        expect(attemptResults).toHaveLength(0);
        expect(refreshOwner?.isRequested()).toBe(true);
        expect(refreshOwner?.isPending()).toBe(false);
        expect(physicalSend).toHaveBeenCalledTimes(outcome === "confirmed" ? 1 : 0);
        release.resolve();
        const result = await withinTest(running, context.signal);
        expect(result.meta.error).toBeUndefined();
        expect(attemptResults.map((attempt) => attempt.terminal.kind)).toEqual(["ok", "ok"]);
        expect(messageTools).toHaveLength(2);
        expect(messageTools[1]).not.toBe(messageTools[0]);
        expect(messageExecutions[1]).toHaveBeenCalledOnce();
        const successorResult = await messageExecutions[1]?.mock.results[0]?.value;
        if (outcome === "confirmed") {
          expect(successorResult).toMatchObject({ details: { status: "already_delivered" } });
        }
        expect(events.indexOf("message:2:built")).toBeGreaterThan(
          events.indexOf("attempt:1:settled"),
        );
        expect(physicalSend).toHaveBeenCalledOnce();
        expect(transport).toHaveBeenCalledTimes(outcome === "confirmed" ? 1 : 2);
        expect(loadSessionEntry(scope)?.restartRecoveryDeliveryReceiptState).toBe(
          "delivered-terminal",
        );
        expect(result.didSendViaMessagingTool).toBe(true);
        expect(
          loadTranscriptEventsSync(scope).filter((event) => {
            const message = asOptionalRecord(asOptionalRecord(event)?.message);
            return message?.role === "user" && message.idempotencyKey === sourceTurnId;
          }),
        ).toHaveLength(1);
        expect(testing.activeRuns.size).toBe(0);
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
