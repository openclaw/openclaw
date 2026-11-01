// Real message-tool settlement and reply ownership cross the real retry/terminal loop.
// Only channel I/O and model attempts are scripted; no live provider or channel is contacted.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type {
  ChannelMessageActionContext,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import {
  workspaceConfig,
  workspaceTestPlugin,
} from "../infra/outbound/message-action-runner.test-support.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  installScriptedRunnerMocks,
  type RunParams,
} from "./embedded-agent-runner.mock-test-support.js";
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
  makeEmbeddedRunnerAttempt,
  immediateEnqueue,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

const runAttempt = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
let runtime: Awaited<ReturnType<typeof loadRuntime>>;
async function loadRuntime() {
  installScriptedRunnerMocks({
    runEmbeddedAttempt: (params) => runAttempt(params),
    hookRunner: "full",
    modelsConfig: "plain",
    backoff: { computeBackoff: () => 0, sleepWithAbort: async () => {} },
  });
  return {
    run: (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent,
    prepare: (await import("./admitted-run-context.js")).prepareSystemAgentRunAdmission,
    operation: (await import("../sessions/session-controller.js")).createReplyOperation,
    tool: (await import("./tools/message-tool-execution.js")).createMessageTool,
    capability: await import("../gateway/message-action-turn-capability.js"),
    registry: await import("../plugins/runtime.js"),
    config: await import("../config/config.js"),
    workspace: await createEmbeddedAgentRunnerTestWorkspace("source-reply-retry-"),
  };
}
beforeAll(async () => {
  runtime = await loadRuntime();
});
afterAll(async () => await cleanupEmbeddedAgentRunnerTestWorkspace(runtime.workspace));
beforeEach(() => {
  runAttempt.mockReset();
});

function completedAttempt(sessionId: string, text?: string) {
  const assistant = buildEmbeddedRunnerAssistant({
    content: text === undefined ? [] : [{ type: "text", text }],
  });
  return makeEmbeddedRunnerAttempt({
    sessionIdUsed: sessionId,
    assistantTexts: text === undefined ? [] : [text],
    lastAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    ...(text === undefined ? { sourceReplyDeliveryState: "missing" as const } : {}),
  });
}

function run(
  id: string,
  config: RunParams["config"],
  options: Pick<RunParams, "sessionKey" | "preparedRunAdmission"> & Partial<RunParams>,
) {
  return runtime.run({
    agentId: "test",
    sessionId: id,
    workspaceDir: runtime.workspace.workspaceDir,
    agentDir: runtime.workspace.agentDir,
    config,
    provider: "openai",
    model: "mock-1",
    runId: id,
    timeoutMs: 10_000,
    prompt: "Finish the work and reply.",
    enqueue: immediateEnqueue,
    ...options,
  });
}

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
    const sessionKey = "agent:test:workspace:group:c123:" + id;
    const operation = runtime.operation({ sessionId: id, sessionKey, resetTriggered: false });
    const config = {
      ...createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]),
      channels: workspaceConfig.channels,
      tools: { message: { crossContext: { allowWithinProvider: true } } },
    };
    runtime.config.setRuntimeConfigSnapshot(config);
    const admission = runtime.prepare(config, id, "test", "source-reply-retry-test");
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
    runtime.registry.setActivePluginRegistry(
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
    const capability = runtime.capability.mintMessageActionTurnCapability({
      agentId: "test",
      runId: id,
      sessionKey,
      requesterAccountId: "default",
      toolContext: source,
    });
    const tool = runtime.tool({
      config,
      ...source,
      agentId: "test",
      runId: id,
      sessionId: id,
      agentSessionKey: sessionKey,
      agentAccountId: "default",
      messageActionTurnCapability: capability,
      sourceReplyDeliveryMode: "automatic",
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
          toolMetas:
            attempts === 1
              ? [{ toolName: "message", toolCallId: "send-once", replaySafe: mode === "dry-run" }]
              : [],
          didSendViaMessagingTool: attempts === 1 && mode !== "dry-run",
          sourceReplyDeliveryState:
            attempts === 1 && operation.sourceReplyDelivered ? "delivered" : "missing",
        });
      }
      if (mode === "steered") {
        operation.markSteeredInputAccepted({ inboundAudio: false });
      }
      return completedAttempt(params.sessionId);
    });
    try {
      const result = await run(id, config, {
        sessionKey,
        replyOperation: operation,
        preparedRunAdmission: admission,
        messageActionTurnCapability: capability,
        terminalReplyExpectation: "required",
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
        expect(result.meta).toMatchObject({ error: { kind: "incomplete_turn" } });
        expect(result.meta.terminalReply).toEqual({ disposition: "empty" });
        expect(result.meta.finalAssistantVisibleText).toBeUndefined();
        expect(result.meta.finalAssistantRawText).toBeUndefined();
      }
    } finally {
      admission.close();
      operation.complete();
      runtime.capability.revokeMessageActionTurnCapability(capability);
      runtime.config.clearRuntimeConfigSnapshot();
      runtime.registry.resetPluginRuntimeStateForTest();
    }
  },
);

it.each([
  ["subagent", "NO_REPLY", { lane: "subagent" }],
  ["private", "", { privateCompletion: true }],
  ["webchat", "NO_REPLY\n<final></final>", {}],
] as const)("recovers a %s result after '%s'", async (name, raw, opts) => {
  const sessionKey = name === "private" ? "agent:test:private" : `agent:test:${name}:required`;
  const config = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
  const id = `internal-${name}`;
  const admission = runtime.prepare(config, id, "test", "internal-result-recovery");
  const answer = `Recovered ${name} result`;
  let attempt = 0;
  runAttempt.mockImplementation(async (params) => {
    return completedAttempt(params.sessionId, attempt++ === 0 ? raw : answer);
  });
  runtime.registry.setActivePluginRegistry(createTestRegistry([]));
  runtime.config.setRuntimeConfigSnapshot(config);
  try {
    const result = await run(id, config, {
      sessionKey,
      preparedRunAdmission: admission,
      prompt: "Return a result.",
      terminalReplyExpectation: resolveCommandReplyExpectation({
        cfg: config,
        sessionKey,
        messageChannel: name === "webchat" ? "webchat" : "telegram",
        opts,
      }),
    });
    expect(result.payloads).toEqual([expect.objectContaining({ text: answer })]);
    expect(result.meta.error).toBeUndefined();
  } finally {
    admission.close();
    runtime.config.clearRuntimeConfigSnapshot();
    runtime.registry.resetPluginRuntimeStateForTest();
  }
});
