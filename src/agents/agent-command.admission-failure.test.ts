import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  readAgentRunTerminalError,
  readAgentRunTerminalOutcome,
} from "../channels/turn/agent-run-terminal-outcome.js";
import type { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";
import { deliverAgentCommandResult } from "./command/delivery.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.errors.js";

const sendMock = vi.hoisted(() => vi.fn<typeof deliverOutboundPayloads>());
// mock-isolation: Fix the external send boundary while real finalization and delivery custody run.
vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: sendMock,
  deliverOutboundPayloadsInternal: sendMock,
}));
const platformSend = vi.fn<() => Promise<Awaited<ReturnType<typeof deliverOutboundPayloads>>>>();
const channelPlugin = createOutboundTestPlugin({
  id: "discord",
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ channel: "discord", messageId: "notice-1" }),
  },
});

registerAgentCommandCompactionTestHooks();
beforeEach(() => {
  platformSend.mockReset();
  sendMock.mockReset().mockImplementation(async (params) => {
    await params.onPlatformSendDispatch?.();
    params.assertDirectAdapterHandoff?.();
    return await platformSend();
  });
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", source: "test", plugin: channelPlugin }]),
  );
  state.deliverAgentCommandResultMock.mockImplementation(
    (params: Parameters<typeof deliverAgentCommandResult>[0]) =>
      deliverAgentCommandResult({ ...params, preparedPlugin: channelPlugin }),
  );
});
afterEach(() => clearActivePluginRegistry());

const refusalText =
  "Model runtime replacement is in progress; admitted plugin work cannot wait for the reload. Retry after the plugin reload completes.";

function initialRefusal() {
  return new PreparedModelRuntimeOwnerNotPublishedError(refusalText, { admissionBlocked: true });
}

async function fixture() {
  const sessionKey = "agent:main:discord:channel:123";
  const sessionId = "refused-continuation-session";
  const runId = "announce:requester-settle:failed-children:yield-1";
  const target = { agentId: "main", sessionKey, storePath: requireCompactionStorePath() };
  await compactionTestRuntime.replaceSessionEntry(target, {
    sessionId,
    updatedAt: Date.now(),
    modelProvider: "openai",
    model: "gpt-5.5",
    agentHarnessId: "openclaw",
    contextTokens: 64000,
    contextTokensSource: "runtime",
  });
  const opts = {
    sessionKey,
    sessionId,
    runId,
    message: "Report the failed child outcome",
    channel: "discord",
    to: "channel:123",
    accountId: "main",
    threadId: "456",
    deliver: true,
    sourceReplyDeliveryMode: "message_tool_only" as const,
    inputProvenance: { kind: "inter_session" as const, sourceTool: "subagent_settle" },
    allowModelOverride: false,
  };
  return { target, opts, runId };
}

it.each(["sent", "failed"] as const)(
  "settles a refused continuation using the actual %s delivery outcome",
  async (status) => {
    const { target, opts } = await fixture();
    state.runAgentAttemptMock.mockRejectedValueOnce(initialRefusal());
    state.deliverAgentCommandResultMock.mockImplementationOnce(
      async (params: Parameters<typeof deliverAgentCommandResult>[0]) => {
        const entry = await params.resolveFreshSessionEntryForDelivery?.();
        expect(entry?.pendingFinalDelivery).toBeDefined();
        expect(params.opts).toMatchObject({
          replyChannel: "discord",
          replyTo: "channel:123",
          replyAccountId: "main",
          threadId: "456",
        });
        expect(params.payloads).toEqual([
          expect.objectContaining({ isError: true, text: expect.stringContaining("couldn't") }),
        ]);
        const payload = params.payloads?.[0];
        assert.isDefined(payload);
        expect(payload.text).toBe(
          "⚠️ OpenClaw couldn't finish this request. Check the conversation before trying again. For details, open Settings → Logs in the OpenClaw app or run `openclaw logs --follow`.",
        );
        expect(getReplyPayloadMetadata(payload)).toMatchObject({
          deliverDespiteSourceReplySuppression: true,
        });
        return await deliverAgentCommandResult({ ...params, preparedPlugin: channelPlugin });
      },
    );
    if (status === "sent") {
      platformSend.mockResolvedValueOnce([{ channel: "discord", messageId: "notice-1" }]);
    } else {
      platformSend.mockRejectedValueOnce(new Error("Synthetic transport failed"));
    }
    const result = await agentCommandFromGatewayIngress(
      { ...opts, bestEffortDeliver: true },
      ...GATEWAY_INGRESS_ARGS,
    );
    expect(readAgentRunTerminalOutcome(result)).toBe("failed");
    expect(readAgentRunTerminalError(result)).toBe(refusalText);
    expect(result.meta).toMatchObject({ stopReason: "error", providerStarted: false });
    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0]?.[0]).toMatchObject({
      channel: "discord",
      to: "channel:123",
      accountId: "main",
      threadId: "456",
      payloads: [expect.objectContaining({ text: expect.stringContaining("couldn't") })],
    });
    const settled = compactionTestRuntime.loadSessionEntry(target);
    expect(settled).toMatchObject({
      agentHarnessId: "openclaw",
      contextTokens: 64000,
      contextTokensSource: "runtime",
    });
    if (status === "sent") {
      expect(settled?.pendingFinalDelivery).toBeUndefined();
    } else {
      expect(settled?.pendingFinalDelivery).toBeDefined();
    }
    const terminalEvents = state.emitAgentEventMock.mock.calls
      .map(([event]) => event)
      .filter(
        (event) => event.stream === "lifecycle" && ["end", "error"].includes(event.data.phase),
      );
    expect(terminalEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "error",
          providerStarted: false,
          terminalDelivery: { status, resultCount: status === "sent" ? 1 : 0 },
        }),
      }),
    ]);
  },
);

it("delivers an admitted continuation without a failure notice", async () => {
  const { opts } = await fixture();
  state.runAgentAttemptMock.mockResolvedValueOnce(
    makeCompactionResult({
      sessionId: opts.sessionId,
      text: "The child failed; no work was lost.",
    }),
  );
  platformSend.mockResolvedValueOnce([{ channel: "discord", messageId: "reply-1" }]);

  const result = await agentCommandFromGatewayIngress(
    { ...opts, sourceReplyDeliveryMode: "automatic" },
    ...GATEWAY_INGRESS_ARGS,
  );

  expect(readAgentRunTerminalOutcome(result)).toBe("completed");
  expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
  expect(sendMock).toHaveBeenCalledOnce();
  expect(sendMock.mock.calls[0]?.[0].payloads).toEqual([
    expect.objectContaining({ text: "The child failed; no work was lost." }),
  ]);
  expect(result.payloads?.some((payload) => payload.isError)).toBe(false);
});

it.each([
  ["an ordinary error", () => [new Error(refusalText)], "completion"],
  [
    "a missing runtime owner",
    () => [
      new PreparedModelRuntimeOwnerNotPublishedError(refusalText, { admissionBlocked: false }),
    ],
    "completion",
  ],
  [
    "a refusal after a live model switch",
    () => [
      new LiveSessionModelSwitchError({ provider: "openai", model: "gpt-5.5" }),
      initialRefusal(),
    ],
    "completion",
  ],
  ["a runtime refusal of an ordinary chat turn", () => [initialRefusal()], "chat"],
] as const)(
  "delivers one failure notice when the turn fails before it starts: %s",
  async (_name, errors, turn) => {
    const { opts } = await fixture();
    const thrown = errors();
    for (const error of thrown) {
      state.runAgentAttemptMock.mockRejectedValueOnce(error);
    }
    platformSend.mockResolvedValueOnce([{ channel: "discord", messageId: "notice-1" }]);

    const result = await agentCommandFromGatewayIngress(
      turn === "chat" ? { ...opts, inputProvenance: undefined } : opts,
      ...GATEWAY_INGRESS_ARGS,
    );

    expect(readAgentRunTerminalOutcome(result)).toBe("failed");
    expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(thrown.length);
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0]?.[0].payloads).toEqual([
      expect.objectContaining({ text: expect.stringContaining("couldn't") }),
    ]);
  },
);

it.each([
  "private",
  "internal",
  "cancelled",
  "revoked source authority",
  "started execution",
  "an ordinary chat error",
] as const)("does not synthesize delivery after %s", async (scenario) => {
  const { opts } = await fixture();
  let sourceCurrent = true;
  const controller = new AbortController();
  state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
    if (scenario === "cancelled") {
      controller.abort(new Error("Stopped by operator"));
    }
    if (scenario === "revoked source authority") {
      sourceCurrent = false;
    }
    if (scenario === "started execution") {
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    }
    throw scenario === "an ordinary chat error" ? new Error(refusalText) : initialRefusal();
  });
  await expect(
    agentCommandFromGatewayIngress(
      {
        ...opts,
        ...(scenario === "an ordinary chat error" ? { inputProvenance: undefined } : {}),
        deliver: scenario !== "private",
        ...(scenario === "internal" ? { sessionEffects: "internal" as const } : {}),
        abortSignal: controller.signal,
        assertSourceCurrent: () => {
          if (!sourceCurrent) {
            throw new Error("Source owner revoked");
          }
        },
      },
      ...GATEWAY_INGRESS_ARGS,
    ),
  ).rejects.toThrow();
  expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
  expect(platformSend).not.toHaveBeenCalled();
  expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
});

// Private and in-session requesters get no command notice; their owner reads the rethrown error.
it.each([
  ["before it started", false],
  ["after it started", undefined],
] as const)("marks whether a run that failed %s showed nothing", async (when, providerStarted) => {
  const { opts } = await fixture();
  state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
    if (when === "after it started") {
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    }
    throw new Error("Attempt failed");
  });

  const error = await agentCommandFromGatewayIngress(
    { ...opts, deliver: false },
    ...GATEWAY_INGRESS_ARGS,
  ).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  if (providerStarted === false) {
    expect(error).toMatchObject({ providerStarted: false });
  } else {
    expect(error).not.toHaveProperty("providerStarted");
  }
});

it("does not mark a shutdown reason that other runs share", async () => {
  const { opts } = await fixture();
  const controller = new AbortController();
  const shutdown = new Error("Gateway is restarting");
  state.runAgentAttemptMock.mockImplementationOnce(async () => {
    controller.abort(shutdown);
    throw shutdown;
  });

  await expect(
    agentCommandFromGatewayIngress(
      { ...opts, abortSignal: controller.signal },
      ...GATEWAY_INGRESS_ARGS,
    ),
  ).rejects.toThrow();
  expect(shutdown).not.toHaveProperty("providerStarted");
});
