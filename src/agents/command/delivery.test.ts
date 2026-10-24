import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { createReplyMediaPathNormalizer } from "../../auto-reply/reply/reply-media-paths.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { buildRestartRecoveryTerminalDeliveryEvidence } from "../agent-command-restart-recovery.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import type { AgentCommandDeliveryResult } from "./delivery-result.js";
import { deliverAgentCommandResult } from "./delivery.js";
import { registerAgentCommandReplyPolicyTests } from "./delivery.reply-policy.test-support.js";
import type { AgentCommandOpts } from "./types.js";

const outboundMock = vi.hoisted(() => vi.fn<typeof deliverOutboundPayloads>());
// mock-isolation: Replace both delivery entrypoints without loading live channel transports.
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: outboundMock,
  deliverOutboundPayloadsInternal: outboundMock,
}));

const normalizerMock = vi.hoisted(() => vi.fn<typeof createReplyMediaPathNormalizer>());
vi.mock("../../auto-reply/reply/reply-media-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../auto-reply/reply/reply-media-paths.js")>()),
  createReplyMediaPathNormalizer: normalizerMock,
}));

type DeliverParams = Parameters<typeof deliverAgentCommandResult>[0];
type RunResult = DeliverParams["result"];
const emptyRegistry = createTestRegistry([]);
const slackPluginForTest = createOutboundTestPlugin({
  id: "slack",
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ to, text }) => ({ channel: "slack", messageId: `${to}:${text}` }),
  },
});
function setSlackPlugin(overrides: Partial<typeof slackPluginForTest>) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: { ...slackPluginForTest, ...overrides },
      },
    ]),
  );
}

function createResult(overrides: Partial<RunResult> = {}): RunResult {
  return { ...overrides, meta: { durationMs: 1, ...overrides.meta } };
}

const mediaSession = { key: "agent:tester:slack:direct:alice", agentId: "tester" };
const mediaPayload = { text: "here you go", mediaUrls: ["./out/photo.png"] };
const readyPayload = { text: "Ready" };
const sentMessage = [{ channel: "slack" as const, messageId: "msg-1" }];
const createRuntime = () => ({
  log: vi.fn(),
  error: vi.fn(),
  writeStdout: vi.fn(),
  writeJson: vi.fn(),
});

it.each([false, true])("reports a thinking clamp through local output (json=%s)", async (json) => {
  const thinkingClamp =
    "Thinking level clamped to off for ollama/llama3.2 (requested high; preference retained).";
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const delivered = await deliverForTest({
    runtime,
    opts: { deliver: false, json },
    payloads: [{ text: "hello" }],
    result: createResult({
      meta: { durationMs: 1, requestShaping: { thinking: "off", thinkingClamp } },
    }),
  });

  expect(delivered.meta.requestShaping).toEqual({ thinking: "off", thinkingClamp });
  expect(delivered.payloads).toEqual([{ text: "hello", mediaUrl: null }]);
  if (json) {
    expect(runtime.log).not.toHaveBeenCalledWith(thinkingClamp);
    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toMatchObject({
      meta: { requestShaping: { thinking: "off", thinkingClamp } },
    });
  } else {
    expect(runtime.log).toHaveBeenCalledWith(thinkingClamp);
    expect(runtime.log).toHaveBeenCalledWith("hello");
  }
});

type MessagingToolSentTarget = NonNullable<RunResult["messagingToolSentTargets"]>[number];

type DeliveryFixture = Omit<Partial<DeliverParams>, "opts" | "payloads" | "result"> & {
  payloads: DeliverParams["payloads"];
  opts?: Partial<AgentCommandOpts>;
  omitReplyTarget?: boolean;
  result?: Partial<RunResult>;
  sentTarget?: Partial<MessagingToolSentTarget>;
  workspace?: boolean;
};

function deliverForTest({
  opts,
  omitReplyTarget,
  result,
  sentTarget,
  workspace,
  ...params
}: DeliveryFixture) {
  const runResult: RunResult = { ...createResult(), ...result };
  if (sentTarget) {
    runResult.messagingToolSentTargets = [
      { tool: "message", provider: "slack", to: "channel:C123", ...sentTarget },
    ];
  }
  return deliverAgentCommandResult({
    cfg: (workspace
      ? { agents: { entries: { tester: { workspace: "/tmp/agent-workspace" } } } }
      : {}) as OpenClawConfig,
    deps: {},
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    opts: {
      message: "completion handoff",
      deliver: true,
      ...(omitReplyTarget ? {} : { replyChannel: "slack", replyTo: "channel:C123" }),
      ...opts,
    } as AgentCommandOpts,
    outboundSession: undefined,
    sessionEntry: undefined,
    result: runResult,
    ...params,
  } as DeliverParams);
}

function outboundArgs() {
  return outboundMock.mock.lastCall![0];
}

function expectOutboundPayloads(...payloads: Record<string, unknown>[]) {
  expect(outboundArgs().payloads).toEqual(
    payloads.map((payload) => expect.objectContaining(payload)),
  );
}

type DeliveryStatusLike = NonNullable<AgentCommandDeliveryResult["deliveryStatus"]>;

function expectStatus(
  delivered: AgentCommandDeliveryResult,
  expected: Partial<DeliveryStatusLike>,
) {
  expect(delivered.deliveryStatus).toMatchObject({
    requested: true,
    attempted: true,
    succeeded: expected.status === "sent" || expected.status === "suppressed",
    ...expected,
  });
  return delivered.deliveryStatus!;
}

type JsonOutput = { payloads: unknown[]; meta?: unknown; deliveryStatus?: DeliveryStatusLike };

function deliverMediaReplyForTest({ opts, ...overrides }: Partial<DeliveryFixture> = {}) {
  return deliverForTest({
    workspace: true,
    opts: { message: "go", replyTo: "#general", ...opts },
    payloads: [mediaPayload],
    ...overrides,
  });
}

describe("deliverAgentCommandResult payload normalization", () => {
  beforeEach(() => {
    setSlackPlugin({
      threading: {
        resolveReplyTransport: ({ threadId }) => ({
          replyToId: threadId == null ? undefined : String(threadId),
          threadId: null,
        }),
      },
    });
    outboundMock.mockReset();
    outboundMock.mockResolvedValue([]);
    normalizerMock.mockReset();
    normalizerMock.mockImplementation(() => async (payload) => payload);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  registerAgentCommandReplyPolicyTests({
    deliverAgentCommandResultForTest: deliverForTest,
    deliverOutboundPayloadsMock: outboundMock,
    latestOutboundDeliveryArgs: outboundArgs,
    expectDeliveryStatusFields: expectStatus,
  });

  it("rechecks delivery ownership after asynchronous payload preparation", async () => {
    let deliveryCurrent = true;
    normalizerMock.mockImplementationOnce(
      () =>
        async (payload: ReplyPayload): Promise<ReplyPayload> => {
          deliveryCurrent = false;
          return payload;
        },
    );

    await expect(
      deliverForTest({
        workspace: true,
        opts: { replyTo: "#general" },
        payloads: [{ text: "result", mediaUrls: ["./out/photo.png"] }],
        assertDeliveryCurrent: () => {
          if (!deliveryCurrent) {
            throw new Error("stale lifecycle");
          }
        },
      }),
    ).rejects.toThrow("stale lifecycle");
    expect(outboundMock).not.toHaveBeenCalled();
  });

  it("does not cancel final delivery for an ordinary run timeout", async () => {
    const controller = new AbortController();
    const timeoutError = new Error("run timed out");
    timeoutError.name = "TimeoutError";
    controller.abort(timeoutError);

    await deliverMediaReplyForTest({ opts: { abortSignal: controller.signal } });

    const deliverySignal = outboundArgs().abortSignal;
    expect(deliverySignal).toBeInstanceOf(AbortSignal);
    expect(deliverySignal?.aborted).toBe(false);
  });

  it.each([false, true])("restart after durable intent=%s", async (hasIntent) => {
    const controller = new AbortController();
    let deliverySignal: AbortSignal | undefined;
    outboundMock.mockImplementationOnce(async (request) => {
      deliverySignal = request.abortSignal;
      if (hasIntent) {
        request.onDeliveryIntent?.({
          id: "intent-after-restart",
          channel: "discord",
          to: "channel:123",
          queuePolicy: "required",
        });
      }
      controller.abort(createAgentRunRestartAbortError());
      expect(deliverySignal?.aborted).toBe(!hasIntent);
      if (!hasIntent) {
        throw deliverySignal?.reason;
      }
      return [{ channel: "discord", messageId: "sent-after-restart" }];
    });
    const delivery = deliverMediaReplyForTest({ opts: { abortSignal: controller.signal } });
    if (hasIntent) {
      expect((await delivery).deliverySucceeded).toBe(true);
      expect(deliverySignal?.aborted).toBe(false);
    } else {
      await expect(delivery).rejects.toThrow("agent run aborted for restart");
      expect(deliverySignal?.reason).toBe(controller.signal.reason);
    }
  });

  it("carries the session key identity through durable final delivery", async () => {
    await deliverForTest({
      cfg: {
        agents: {
          entries: {
            main: { identity: { name: "Default" } },
            worker: { identity: { name: " Worker ", emoji: " :robot_face: " } },
          },
        },
      },
      opts: { sessionKey: "agent:worker:slack:channel:c123" },
      payloads: [{ text: "final answer" }],
    });
    expect(outboundArgs()).toMatchObject({
      identity: { name: "Worker", emoji: ":robot_face:" },
    });
  });

  it("keeps runtime error payloads out of a host-owned turn that delivers authored output only", async () => {
    outboundMock.mockResolvedValue(sentMessage);
    const timeout = {
      text: "Request timed out before a response was generated. Please try again.",
      isError: true,
    };

    await deliverForTest({ payloads: [timeout] });
    expectOutboundPayloads({ text: timeout.text });

    outboundMock.mockClear();
    await deliverForTest({
      opts: { internalDeliverySuppressErrors: true },
      payloads: [timeout],
    });
    expect(outboundMock).not.toHaveBeenCalled();

    await deliverForTest({
      opts: { internalDeliverySuppressErrors: true },
      payloads: [{ text: "Fixed scripts/sync.md." }, timeout],
    });
    expectOutboundPayloads({ text: "Fixed scripts/sync.md." });
  });

  it("normalizes reply-media paths before outbound delivery", async () => {
    const normalizerFn = vi.fn(async (payload: ReplyPayload): Promise<ReplyPayload> => ({
      ...payload,
      mediaUrl: "/tmp/agent-workspace/out/photo.png",
      mediaUrls: ["/tmp/agent-workspace/out/photo.png"],
    }));
    normalizerMock.mockReturnValue(normalizerFn);

    await deliverMediaReplyForTest({
      outboundSession: mediaSession,
      opts: { replyAccountId: "workspace-1", threadId: "thread-1", runId: "run-1" },
      sessionEntry: { sessionId: "session-1", updatedAt: 1 },
      payloads: [{ ...mediaPayload, text: "✅ New session started.", isStatusNotice: true }],
    });

    expect(normalizerMock.mock.lastCall![0]).toMatchObject({
      sessionKey: mediaSession.key,
      agentId: "tester",
      workspaceDir: "/tmp/agent-workspace",
      messageProvider: "slack",
    });

    expect(normalizerFn.mock.calls[0]?.[0].mediaUrls).toStrictEqual(["./out/photo.png"]);
    expect(outboundMock).toHaveBeenCalledTimes(1);
    const deliverArgs = outboundArgs();
    expect(deliverArgs.payloads[0]?.isStatusNotice).toBe(true);
    expect(deliverArgs.replyPayloadSendingHook).toEqual({
      kind: "final",
      channel: "slack",
      sessionKey: "agent:tester:slack:direct:alice",
      runId: "run-1",
      context: {
        channelId: "slack",
        accountId: "workspace-1",
        conversationId: "#general",
        sessionKey: "agent:tester:slack:direct:alice",
        runId: "run-1",
      },
    });
    expect(deliverArgs.payloads[0]?.mediaUrls).toStrictEqual([
      "/tmp/agent-workspace/out/photo.png",
    ]);
  });

  it("emits canonical text and media JSON and isolates the writer's payload array", async () => {
    const mediaUrl = "https://example.invalid/photo.png";
    const payloads = [{ text: "hello", mediaUrl }];
    const expectedPayloads = [{ text: "hello", mediaUrl, mediaUrls: [mediaUrl] }];
    const result = createResult();
    let serialized: string | undefined;
    let emittedPayloads: unknown[] | undefined;
    const runtime = {
      ...createRuntime(),
      writeJson: vi.fn((value: { payloads: unknown[]; meta?: unknown }) => {
        expect(Object.keys(value)).toEqual(["payloads", "meta"]);
        expect(value.meta).toBe(result.meta);
        serialized = JSON.stringify(value);
        emittedPayloads = value.payloads;
        value.payloads.splice(0);
      }),
    };

    const delivered = await deliverForTest({
      runtime: runtime as never,
      opts: { deliver: false, json: true },
      payloads,
      result,
    });

    expect(runtime.writeJson).toHaveBeenCalledOnce();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(outboundMock).not.toHaveBeenCalled();
    expect(serialized).toBe(
      JSON.stringify({ payloads: expectedPayloads, meta: { durationMs: 1 } }),
    );
    expect(emittedPayloads).not.toBe(delivered.payloads);
    expect(delivered.payloads).toEqual(expectedPayloads);
    expect(delivered.meta).toBe(result.meta);
    expect(delivered.deliveryStatus).toBeUndefined();
  });

  it.each(["session-1", "session-2"])("refreshes matching session: %s", async (sessionId) => {
    outboundMock.mockResolvedValue(sentMessage);
    const resolveFreshSessionEntryForDelivery = vi.fn(async () => ({
      sessionId,
      updatedAt: 2,
      delivery: normalizeSessionDeliveryState({
        context: { channel: "slack", to: "#fresh", accountId: "workspace-1" },
      }),
    }));
    const delivered = await deliverForTest({
      workspace: true,
      omitReplyTarget: true,
      opts: { bestEffortDeliver: true, sessionKey: "agent:tester:main" },
      outboundSession: { key: "agent:tester:main", agentId: "tester" },
      sessionEntry: { sessionId: "session-1", updatedAt: 1 },
      expectedSessionIdForFreshDelivery: "session-1",
      resolveFreshSessionEntryForDelivery,
      payloads: [{ text: "final answer" }],
    });
    expect(resolveFreshSessionEntryForDelivery).toHaveBeenCalledOnce();
    const refreshed = sessionId === "session-1";
    expect(outboundMock).toHaveBeenCalledTimes(Number(refreshed));
    expect(delivered.deliverySucceeded).toBe(refreshed);
    expectStatus(
      delivered,
      refreshed
        ? { status: "sent", resultCount: 1 }
        : { attempted: false, status: "failed", reason: "channel_resolved_to_internal" },
    );
    if (refreshed) {
      expect(outboundArgs()).toMatchObject({
        channel: "slack",
        to: "#fresh",
        accountId: "workspace-1",
      });
    }
  });

  it.each([false, true])("reports best-effort delivery failure (partial=%s)", async (partial) => {
    const message = partial ? "second chunk failed" : "send failed";
    outboundMock.mockImplementationOnce(async (params) => {
      const error = new Error(message);
      if (!partial) {
        params.onError?.(error, { text: "here you go", mediaUrls: [] });
      }
      params.onPayloadDeliveryOutcome?.({
        index: partial ? 1 : 0,
        status: "failed",
        error,
        sentBeforeError: partial,
        stage: "platform_send",
      });
      return partial ? sentMessage : [];
    });

    const runtime = { log: vi.fn(), error: vi.fn() };
    const delivered = await deliverMediaReplyForTest({
      outboundSession: mediaSession,
      opts: { bestEffortDeliver: true },
      runtime: runtime as never,
      payloads: partial ? [mediaPayload] : [{ text: "here you go" }],
    });

    expect(delivered.deliverySucceeded).toBe(false);
    const status = expectStatus(delivered, {
      status: partial ? "partial_failed" : "failed",
      succeeded: partial ? "partial" : false,
      error: true,
      ...(partial ? { resultCount: 1, sentBeforeError: true } : {}),
    });
    if (partial) {
      expect(String(status.errorMessage)).toContain(message);
      expect(status.payloadOutcomes).toHaveLength(1);
      expect(status.payloadOutcomes?.[0]).toMatchObject({
        index: 1,
        status: "failed",
        error: expect.stringContaining(message),
        sentBeforeError: true,
        stage: "platform_send",
      });
    } else {
      expect(runtime.error.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
        message,
      );
      expect(outboundArgs()).toMatchObject({ bestEffort: true, queuePolicy: "best_effort" });
    }
  });

  it.each(["isCommentary", "isStatusNotice"] as const)(
    "keeps native %s out of JSON",
    async (flag) => {
      const onDeliveryResult = vi.fn();
      const delivered = await deliverForTest({
        opts: { deliver: false, json: true },
        payloads: [{ text: "Still checking", [flag]: true }],
        onDeliveryResult,
      });
      const nativePayloads = onDeliveryResult.mock.lastCall?.[1];
      expect(nativePayloads).toEqual([expect.objectContaining({ [flag]: true })]);
      expect(delivered.payloads).toEqual([{ text: "Still checking", mediaUrl: null }]);
      expect(
        buildRestartRecoveryTerminalDeliveryEvidence({ ...delivered, payloads: nativePayloads }),
      ).toMatchObject({ payloads: [{ visible: false }] });
    },
  );

  it.each([
    { didSendDeterministicApprovalPrompt: true },
    {
      acceptedSessionSpawns: [{ runId: "child-run", childSessionKey: "agent:main:subagent:child" }],
    },
    { successfulCronAdds: 1 },
  ])("preserves restart-unsafe delivery evidence: %j", async (result) => {
    const onDeliveryResult = vi.fn();
    const delivered = await deliverForTest({
      omitReplyTarget: true,
      opts: { deliver: false },
      payloads: [],
      result: { ...result, requesterContinuationSettled: true },
      onDeliveryResult,
    });

    expect(delivered).toMatchObject({ ...result, requesterContinuationSettled: true });
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(delivered, expect.any(Array));
    expect(buildRestartRecoveryTerminalDeliveryEvidence(delivered)).toEqual({
      captured: true,
      requesterContinuationSettled: true,
      restartUnsafeSideEffectsDetected: true,
    });
  });

  it("preserves duplicate media needed for a delivery operation", async () => {
    outboundMock.mockResolvedValue(sentMessage);
    const delivery = { pin: { enabled: true, required: true } };

    const delivered = await deliverForTest({
      cfg: {
        agents: { entries: { main: { identity: { name: " Default ", emoji: " :robot_face: " } } } },
      },
      payloads: [{ mediaUrls: ["/tmp/generated-image.png"], delivery }] as never,
      sentTarget: { mediaUrls: ["/tmp/generated-image.png"] },
    });

    expect(outboundArgs().identity).toEqual({ name: "Default", emoji: ":robot_face:" });
    expect(delivered.deliverySucceeded).toBe(true);
    expectOutboundPayloads({ mediaUrls: ["/tmp/generated-image.png"], delivery });
  });

  it("dedupes delivered file media before normalization can add a failure warning", async () => {
    normalizerMock.mockImplementationOnce(
      () =>
        async (payload: ReplyPayload): Promise<ReplyPayload> => ({
          ...payload,
          text: `${payload.text ?? ""}\n⚠️ Media failed.`,
          mediaUrl: undefined,
          mediaUrls: undefined,
        }),
    );

    const delivered = await deliverForTest({
      opts: { threadId: "171.222" },
      payloads: [{ text: "The image is ready.", mediaUrls: ["file:///tmp/generated-image.png"] }],
      result: {
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["The image is ready."],
        messagingToolSentMediaUrls: ["file:///tmp/generated-image.png"],
      },
      sentTarget: {
        threadId: "171.222",
        text: "The image is ready.",
        mediaUrls: ["file:///tmp/generated-image.png"],
      },
    });

    expect(delivered.payloads).toEqual([]);
    expect(delivered.deliverySucceeded).toBe(true);
    expectStatus(delivered, {
      attempted: false,
      status: "suppressed",
      reason: "no_visible_payload",
    });
    expect(delivered.messagingToolSentMediaUrls).toEqual(["file:///tmp/generated-image.png"]);
    expect(normalizerMock).not.toHaveBeenCalled();
    expect(outboundMock).not.toHaveBeenCalled();
  });

  it("does not add unresolved dynamic prefixes to message-tool evidence", async () => {
    outboundMock.mockResolvedValue(sentMessage);

    const delivered = await deliverForTest({
      cfg: {
        channels: { slack: { responsePrefix: "[{modelFull}]" } },
      } as OpenClawConfig,
      payloads: [readyPayload],
      result: createResult({
        meta: {
          durationMs: 1,
          agentMeta: { provider: "openai", model: "gpt-5.4" },
        } as RunResult["meta"],
      }),
      sentTarget: { text: "Ready" },
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expectOutboundPayloads({ text: "[openai/gpt-5.4] Ready" });
  });

  it("keeps location content when only the matching text was already delivered", async () => {
    outboundMock.mockResolvedValue(sentMessage);
    const location = { latitude: 48.858844, longitude: 2.294351 };

    const delivered = await deliverForTest({
      payloads: [{ text: "The image is ready.", location }] as never,
      sentTarget: { text: "The image is ready." },
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expectOutboundPayloads({ text: "", location });
  });

  it.each(["default", "other"])("cross-account evidence is not deduped: %s", async (account) => {
    outboundMock.mockResolvedValue(sentMessage);
    const delivered = await deliverForTest({
      opts:
        account === "default"
          ? {}
          : {
              replyAccountId: account,
              runContext: {
                messageChannel: "slack",
                currentChannelId: "channel:C123",
                accountId: "work",
              },
            },
      payloads: [readyPayload],
      sentTarget: { text: "Ready", ...(account === "default" ? { accountId: "work" } : {}) },
    });
    expect(delivered.deliverySucceeded).toBe(true);
    expect(outboundMock).toHaveBeenCalledTimes(1);
    expect(outboundArgs().accountId).toBe(account);
  });

  it("surfaces hook cancellation as a suppressed terminal deliveryStatus", async () => {
    const outcome = {
      index: 0,
      status: "suppressed" as const,
      reason: "cancelled_by_message_sending_hook" as const,
      hookEffect: { cancelReason: "owned-by-other-agent" },
    };
    outboundMock.mockImplementationOnce(async (params) => {
      params.onPayloadDeliveryOutcome?.(structuredClone(outcome));
      return [];
    });

    const delivered = await deliverMediaReplyForTest({ outboundSession: mediaSession });

    expect(delivered.deliverySucceeded).toBe(true);
    const status = expectStatus(delivered, {
      status: "suppressed",
      reason: "cancelled_by_message_sending_hook",
    });
    expect(status.payloadOutcomes).toEqual([outcome]);
  });

  it.each([false, true])("transform veto with accepted payload=%s", async (accepted) => {
    setSlackPlugin({
      messaging: {
        transformReplyPayload: vi.fn(({ payload }) =>
          payload.text === "private reply" ? null : payload,
        ),
      },
    });
    outboundMock.mockResolvedValue(sentMessage);
    const delivered = await deliverForTest({
      payloads: [{ text: "private reply" }, ...(accepted ? [{ text: "public reply" }] : [])],
    });
    expect(delivered.deliverySucceeded).toBe(true);
    if (accepted) {
      expectOutboundPayloads({ text: "public reply" });
    } else {
      expect(delivered.payloads).toEqual([]);
      expectStatus(delivered, {
        attempted: false,
        status: "suppressed",
        reason: "channel_transform",
      });
      expect(outboundMock).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("JSON precedes strict failure (preflight=%s)", async (preflight) => {
    const error = preflight ? 'Unknown channel "not-installed"' : "Slack API timeout";
    if (!preflight) {
      outboundMock.mockRejectedValueOnce(new Error(error));
    }
    const events: string[] = [];
    const onDeliveryResult = vi.fn(() => events.push("captured"));
    const runtime = {
      ...createRuntime(),
      writeJson: vi.fn((_value: JsonOutput) => events.push("json")),
    };
    await expect(
      deliverMediaReplyForTest({
        outboundSession: {
          ...mediaSession,
          ...(preflight ? { key: "agent:tester:not-installed:direct:alice" } : {}),
        },
        opts: {
          json: true,
          bestEffortDeliver: false,
          replyChannel: preflight ? "not-installed" : "slack",
        },
        runtime: runtime as never,
        payloads: preflight ? [mediaPayload] : [{ text: "here you go" }],
        onDeliveryResult,
      }),
    ).rejects.toThrow(error);
    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const json = runtime.writeJson.mock.calls[0]![0] as JsonOutput;
    expect(Object.keys(json)).toEqual(["payloads", "meta", "deliveryStatus"]);
    expect(json).toMatchObject({
      payloads: [
        {
          text: "here you go",
          mediaUrl: null,
          ...(preflight ? { mediaUrls: mediaPayload.mediaUrls } : {}),
        },
      ],
      meta: { durationMs: 1 },
    });
    expect(events).toEqual(["json", "captured"]);
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryStatus: expect.objectContaining({ status: "failed" }) }),
      expect.any(Array),
    );
    const expectedStatus = {
      requested: true,
      attempted: !preflight,
      status: "failed",
      succeeded: false,
      error: true,
    };
    if (preflight) {
      expect(outboundMock).not.toHaveBeenCalled();
      expect(normalizerMock).not.toHaveBeenCalled();
      expect(json.deliveryStatus).toEqual({ ...expectedStatus, reason: "unknown_channel" });
    } else {
      expect(json.deliveryStatus).toMatchObject(expectedStatus);
      expect(String(json.deliveryStatus?.errorMessage)).toContain(error);
    }
  });
});
