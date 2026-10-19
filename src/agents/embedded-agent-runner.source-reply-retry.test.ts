// Real message-tool settlement and reply ownership cross the real retry/terminal loop.
// Only channel I/O and model attempts are scripted; no live provider or channel is contacted.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelMessageActionContext,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import {
  workspaceConfig,
  workspaceTestPlugin,
} from "../infra/outbound/message-action-runner.test-support.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import { resolveCommandReplyExpectation } from "./reply-completion.js";
import {
  buildEmbeddedRunnerAssistant,
  cleanupEmbeddedAgentRunnerTestWorkspace,
  createEmbeddedAgentRunnerOpenAiConfig,
  createEmbeddedAgentRunnerTestWorkspace,
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

const runAttempt = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
let runEmbeddedAgent: typeof import("./embedded-agent-runner/run.js").runEmbeddedAgent;
let prepareAdmission: typeof import("./admitted-run-context.js").prepareSystemAgentRunAdmission;
let createReplyOperation: typeof import("../sessions/session-controller.js").createReplyOperation;
let createMessageTool: typeof import("./tools/message-tool-execution.js").createMessageTool;
let mintCapability: typeof import("../gateway/message-action-turn-capability.js").mintMessageActionTurnCapability;
let revokeCapability: typeof import("../gateway/message-action-turn-capability.js").revokeMessageActionTurnCapability;
let setRegistry: typeof import("../plugins/runtime.js").setActivePluginRegistry;
let resetRegistry: typeof import("../plugins/runtime.js").resetPluginRuntimeStateForTest;
let setConfig: typeof import("../config/config.js").setRuntimeConfigSnapshot;
let clearConfig: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let workspace: Awaited<ReturnType<typeof createEmbeddedAgentRunnerTestWorkspace>>;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks({ hookRunner: "full" });
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: (params) => runAttempt(params) });
  installEmbeddedRunnerBackoffE2eMocks({ computeBackoff: () => 0, sleepWithAbort: async () => {} });
  // mock-isolation: synthetic routes must not regenerate shared provider configuration.
  vi.doMock("./models-config.js", () => ({
    ensureOpenClawModelsJson: async () => ({ wrote: false }),
  }));
  // mock-isolation: resolve only fixture models without booting provider discovery.
  vi.doMock("./embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId),
  }));
  ({ runEmbeddedAgent } = await import("./embedded-agent-runner/run.js"));
  ({ prepareSystemAgentRunAdmission: prepareAdmission } =
    await import("./admitted-run-context.js"));
  ({ createReplyOperation } = await import("../sessions/session-controller.js"));
  ({ createMessageTool } = await import("./tools/message-tool-execution.js"));
  ({
    mintMessageActionTurnCapability: mintCapability,
    revokeMessageActionTurnCapability: revokeCapability,
  } = await import("../gateway/message-action-turn-capability.js"));
  ({ setActivePluginRegistry: setRegistry, resetPluginRuntimeStateForTest: resetRegistry } =
    await import("../plugins/runtime.js"));
  ({ setRuntimeConfigSnapshot: setConfig, clearRuntimeConfigSnapshot: clearConfig } =
    await import("../config/config.js"));
  workspace = await createEmbeddedAgentRunnerTestWorkspace("source-reply-retry-");
});
afterAll(async () => await cleanupEmbeddedAgentRunnerTestWorkspace(workspace));
beforeEach(() => {
  runAttempt.mockReset();
});

describe("source reply settlement across provider retries", () => {
  it.each([
    { mode: "final", fault: "rate-limit", delivered: true, failures: 1 },
    { mode: "final", fault: "network", delivered: true, failures: 2 },
    { mode: "progress", fault: "rate-limit", delivered: false, failures: 1 },
    { mode: "failure", fault: "rate-limit", delivered: false, failures: 1 },
    { mode: "partial", fault: "network", delivered: false, failures: 1 },
    { mode: "ambiguous", fault: "rate-limit", delivered: false, failures: 1 },
    { mode: "other-target", fault: "rate-limit", delivered: false, failures: 1 },
    { mode: "dry-run", fault: "rate-limit", delivered: false, failures: 1 },
    { mode: "steered", fault: "rate-limit", delivered: false, failures: 1 },
  ])(
    "keeps $mode delivery distinct after $failures $fault failure(s)",
    async ({ mode, fault, delivered, failures }) => {
      const id = [mode, fault, failures].join("-");
      const sessionId = id;
      const sessionKey = "agent:test:workspace:group:c123:" + id;
      const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
      const config = {
        ...createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]),
        channels: workspaceConfig.channels,
        tools: { message: { crossContext: { allowWithinProvider: true } } },
      };
      setConfig(config);
      const admission = prepareAdmission(config, id, "test", "source-reply-retry-test");
      const channelSend = vi.fn(async ({ params }: ChannelMessageActionContext) => {
        if (mode === "ambiguous") {
          throw new Error("synthetic transport closed before receipt");
        }
        return {
          content: [{ type: "text" as const, text: "channel receipt" }],
          details: {
            ok: mode !== "failure",
            messageId: "native-message-1",
            toJid: params.to,
            ...(mode === "partial" ? { sentBeforeError: true } : {}),
          },
        };
      });
      setRegistry(
        createTestRegistry([
          {
            pluginId: "workspace",
            source: "test",
            plugin: {
              ...workspaceTestPlugin,
              actions: {
                describeMessageTool: () => ({ actions: ["send"] }),
                handleAction: channelSend,
              },
            } satisfies ChannelPlugin,
          },
        ]),
      );
      const source = {
        currentChannelProvider: "workspace",
        currentChannelId: "C123",
        currentMessagingTarget: "C123",
        currentMessageId: "inbound-message",
      };
      const capability = mintCapability({
        agentId: "test",
        runId: id,
        sessionKey,
        requesterAccountId: "default",
        toolContext: source,
      });
      const tool = createMessageTool({
        config,
        ...source,
        agentId: "test",
        runId: id,
        sessionId,
        agentSessionKey: sessionKey,
        agentAccountId: "default",
        messageActionTurnCapability: capability,
        sourceReplyDeliveryMode: "automatic",
        getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
        resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
          resolvedConfig,
          diagnostics: [],
          targetStatesByPath: {},
          hadUnresolvedTargets: false,
        }),
      });
      let attempts = 0;
      runAttempt.mockImplementation(async (params) => {
        attempts += 1;
        if (attempts === 1) {
          const sending = tool.execute("send-once", {
            action: "send",
            target: mode === "other-target" ? "C999" : "C123",
            message: "The requested work is complete.",
            final: mode !== "progress",
            ...(mode === "dry-run" ? { dryRun: true } : {}),
          });
          if (mode === "ambiguous") {
            await expect(sending).rejects.toThrow("synthetic transport closed");
          } else {
            await sending;
          }
          expect(operation.sourceReplyDelivered).toBe(mode === "final" || mode === "steered");
        }
        if (attempts <= failures) {
          const failed = buildEmbeddedRunnerAssistant({
            stopReason: "error",
            errorMessage:
              fault === "network"
                ? "Connection error."
                : "429 Too Many Requests: rate limit exceeded",
          });
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: params.sessionId,
            lastAssistant: failed,
            ...(attempts === 1
              ? {
                  toolMetas: [
                    {
                      toolName: "message",
                      toolCallId: "send-once",
                      replaySafe: mode === "dry-run",
                    },
                  ],
                  didSendViaMessagingTool: mode !== "dry-run",
                }
              : {}),
            sourceReplyDeliveryState:
              attempts === 1 && operation.sourceReplyDelivered ? "delivered" : "missing",
          });
        }
        if (mode === "steered") {
          operation.markSteeredInputAccepted({ inboundAudio: false });
        }
        const empty = buildEmbeddedRunnerAssistant({ content: [] });
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          lastAssistant: empty,
          currentAttemptCompletedAssistant: empty,
          sourceReplyDeliveryState: "missing",
        });
      });
      try {
        const result = await runEmbeddedAgent({
          agentId: "test",
          sessionId,
          sessionKey,
          replyOperation: operation,
          preparedRunAdmission: admission,
          messageActionTurnCapability: capability,
          workspaceDir: workspace.workspaceDir,
          agentDir: workspace.agentDir,
          config,
          prompt: "Finish the work and reply.",
          terminalReplyExpectation: "required",
          provider: "openai",
          model: "mock-1",
          runId: id,
          timeoutMs: 10_000,
          enqueue: async (task) => await task(),
        });
        expect(result.sourceReplyDeliveryState).toBe(delivered ? "delivered" : "missing");
        expect(attempts).toBe(failures + (delivered ? 1 : 2));
        expect(channelSend).toHaveBeenCalledTimes(mode === "dry-run" ? 0 : 1);
        expect(result.meta.replayInvalid).toBe(true);
        if (delivered) {
          expect(result.payloads ?? []).toEqual([]);
          expect(result.meta.error).toBeUndefined();
          expect(result.meta.agentMeta?.terminalReceipt?.sourceReplyDelivered).toBe(true);
        } else {
          expect(result.payloads).toEqual([
            expect.objectContaining({
              isError: true,
              isStatusNotice: true,
              text:
                mode === "dry-run"
                  ? "No answer was returned. Ask again if you still need one."
                  : "No answer was returned. Ask again if you still need one. Note: some tool actions may have already been executed — please verify before retrying.",
            }),
          ]);
          expect(result.meta.error?.kind).toBe("incomplete_turn");
          expect(result.meta.terminalReply).toEqual({ disposition: "empty" });
          expect(result.meta.finalAssistantVisibleText).toBeUndefined();
          expect(result.meta.finalAssistantRawText).toBeUndefined();
        }
      } finally {
        admission.close();
        operation.complete();
        revokeCapability(capability);
        clearConfig();
        resetRegistry();
      }
    },
  );

  it.each(
    (
      [
        {
          name: "subagent",
          sessionKey: "agent:test:subagent:required",
          messageChannel: "telegram",
          opts: { lane: "subagent" },
        },
        {
          name: "private",
          sessionKey: "agent:test:private",
          messageChannel: "telegram",
          opts: { privateCompletion: true },
        },
        {
          name: "webchat",
          sessionKey: "agent:test:webchat:required",
          messageChannel: "webchat",
          opts: {},
        },
      ] as const
    ).flatMap((scenario) =>
      ["NO_REPLY", "", "NO_REPLY\n<final></final>"].map((raw) => Object.assign({ raw }, scenario)),
    ),
  )(
    "recovers a $name result after '$raw'",
    async ({ name, sessionKey, messageChannel, opts, raw }) => {
      const config = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
      const id = `internal-${name}-${raw === "NO_REPLY" ? "silent" : raw ? "rendered-empty" : "empty"}`;
      const admission = prepareAdmission(config, id, "test", "internal-result-recovery");
      const answer = `Recovered ${name} result`;
      let attempt = 0;
      runAttempt.mockImplementation(async (params) => {
        const text = attempt++ === 0 ? raw : answer;
        const assistant = buildEmbeddedRunnerAssistant({
          content: [{ type: "text", text }],
          stopReason: "stop",
        });
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          assistantTexts: [text],
          lastAssistant: assistant,
          currentAttemptCompletedAssistant: assistant,
        });
      });
      setRegistry(createTestRegistry([]));
      setConfig(config);
      try {
        const result = await runEmbeddedAgent({
          agentId: "test",
          sessionId: id,
          sessionKey,
          preparedRunAdmission: admission,
          workspaceDir: workspace.workspaceDir,
          agentDir: workspace.agentDir,
          config,
          prompt: "Return a result.",
          provider: "openai",
          model: "mock-1",
          runId: id,
          timeoutMs: 10_000,
          enqueue: async (task) => await task(),
          terminalReplyExpectation: resolveCommandReplyExpectation({
            cfg: config,
            sessionKey,
            messageChannel,
            opts,
          }),
        });
        expect(result.payloads).toEqual([expect.objectContaining({ text: answer })]);
        expect(result.meta.error).toBeUndefined();
      } finally {
        admission.close();
        clearConfig();
        resetRegistry();
      }
    },
  );
});
