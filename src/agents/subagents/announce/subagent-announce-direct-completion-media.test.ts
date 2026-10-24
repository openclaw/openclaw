import { afterEach, expect, it, vi } from "vitest";
import { OutboundDeliveryError } from "../../../infra/outbound/deliver-types.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../internal-runtime-context.js";
import { mockCallArg, taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";
import type { SubagentAnnounceDeliveryTestDeps } from "./subagent-announce-overrides.test-support.js";

type SendMessage = SubagentAnnounceDeliveryTestDeps["sendMessage"];
type DeliveryParams = Parameters<typeof deliverSubagentAnnouncement>[0];
const image = "/tmp/generated.png";
const voice = "/tmp/voice.ogg";
const imageEvent = { mediaUrls: [image] };
const hidden = `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nMEDIA:/tmp/hidden.png\n${INTERNAL_RUNTIME_CONTEXT_END}`;
const sent = { channel: "discord", to: "dm:U123", via: "direct" as const, mediaUrl: null };
const delivered = { delivered: true, path: "direct" } as const;

async function deliver(params: {
  event?: Partial<AgentInternalEvent>;
  payloads?: Record<string, unknown>[];
  sendMessage?: SendMessage;
  onDeliveryResult?: DeliveryParams["onDeliveryResult"];
  onDeliveryError?: DeliveryParams["onDeliveryError"];
}) {
  const sendMessage = params.sendMessage ?? vi.fn<SendMessage>(async () => sent);
  testing.setDepsForTest({
    callGateway: vi.fn(async () => {
      if (params.event?.status === "error") {
        throw new Error("provider rejected requester synthesis");
      }
      return { result: { payloads: params.payloads ?? [] } };
    }),
    getRequesterSessionActivity: (sessionKey, requester) => ({
      sessionId: "requester-session",
      isActive: true,
      target: captureSessionTarget({
        storeScope: requester.storePath ?? "/synthetic/completion-media/sessions.json",
        sessionKey: requester.canonicalKey,
        aliases: [sessionKey],
        agentId: requester.agentId,
        incarnation: "requester-session",
      }),
    }),
    getRuntimeConfig: () => ({}),
    sendMessage,
  });
  const origin = { channel: "discord", to: "dm:U123", accountId: "acct-1" };
  const childSessionKey = "agent:worker:subagent:media-child";
  const result = await deliverSubagentAnnouncement({
    requesterSessionKey: "agent:main:discord:dm:U123",
    targetRequesterSessionKey: "agent:main:discord:dm:U123",
    triggerMessage: "child done",
    requesterSessionOrigin: origin,
    completionDirectOrigin: origin,
    directOrigin: origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: "announce-media-fallback",
    internalEvents: taskCompletionEvents({
      childSessionKey,
      childSessionId: "child-session",
      result: "Image ready",
      ...params.event,
    }),
    sourceRunId: "run-media",
    sourceSessionKey: childSessionKey,
    sourceTool: "subagent_announce",
    onDeliveryResult: params.onDeliveryResult,
    onDeliveryError: params.onDeliveryError,
  });
  return { result, sendMessage: vi.mocked(sendMessage) };
}

afterEach(() => testing.setDepsForTest());

it("retains the original failed text fallback error", async () => {
  const failure = Object.assign(new Error("synthetic channel failure"), { code: "ECONNRESET" });
  const onDeliveryError = vi.fn();
  const sendMessage = vi.fn<SendMessage>().mockRejectedValue(failure);
  const { result } = await deliver({ sendMessage, onDeliveryError });
  expect(onDeliveryError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(result).toMatchObject({
    delivered: false,
    path: "direct",
    error: "text completion direct delivery failed: synthetic channel failure",
  });
  expect(sendMessage).toHaveBeenCalledOnce();
});

it.each<
  [
    name: string,
    event: Partial<AgentInternalEvent>,
    expected?: [content?: string, mediaUrls?: string[], asVoice?: boolean] | null,
    payloads?: Record<string, unknown>[],
  ]
>([
  ["structured media", imageEvent],
  ["captionless media", { result: "", mediaUrls: [image] }, ["", [image]]],
  ["attachment metadata", { attachments: [{ type: "image", path: image }] }],
  ["visible beside hidden", { result: `Image ready\nMEDIA:${image}\n${hidden}` }],
  ["voice directive", { result: `[[audio_as_voice]]\nMEDIA:${voice}` }, ["", [voice], true]],
  ["hidden-only media", { result: `Image ready\n${hidden}` }, ["Image ready"]],
  ["literal (no output)", { result: "(no output)" }, ["(no output)"]],
  [
    "requester voice payload",
    {},
    ["Voice ready", [voice], true],
    [
      {
        text: `Voice ready\nMEDIA:${voice}\n${hidden}`,
        mediaUrls: [voice],
        audioAsVoice: true,
      },
    ],
  ],
  ["recorded absent result", { result: "(no output)", noVisibleResult: true }, null],
  [
    "failed completion without its media",
    { status: "error", statusLabel: "failed", result: "(no output)", mediaUrls: [image] },
    [],
  ],
])("delivers only visible completed content: %s", async (_name, event, rawExpected, payloads) => {
  const expected = rawExpected === undefined ? (["Image ready", [image]] as const) : rawExpected;
  const { result, sendMessage } = await deliver({ event, payloads });
  if (expected === null) {
    expect(sendMessage).not.toHaveBeenCalled();
    return;
  }
  expect(result).toMatchObject(delivered);
  expect(sendMessage).toHaveBeenCalledOnce();
  const payload = mockCallArg(sendMessage);
  const [content, mediaUrls, asVoice] = expected;
  if (content !== undefined) {
    expect(payload.content).toBe(content);
  }
  expect(payload.mediaUrls).toEqual(mediaUrls);
  expect(payload.asVoice).toBe(asVoice);
});

it("does not settle or retry a partially sent media batch", async () => {
  const onDeliveryResult = vi.fn();
  const sendMessage = vi.fn<SendMessage>(async (params) => {
    await params.onDeliveryResult?.({ channel: "discord", messageId: "msg-1" });
    throw new OutboundDeliveryError("second attachment failed", {
      cause: new Error("platform rejected media"),
      results: [{ channel: "discord", messageId: "msg-1" }],
    });
  });
  const { result } = await deliver({ event: imageEvent, sendMessage, onDeliveryResult });
  expect(result).toMatchObject({
    delivered: false,
    terminal: true,
    disposition: "permanent_failure",
  });
  expect(sendMessage).toHaveBeenCalledOnce();
  expect(onDeliveryResult).not.toHaveBeenCalled();
});

it("settles the full batch before mirroring, retaining delivery if bookkeeping fails", async () => {
  const mirror = createDeferredCore();
  const settled = createDeferredCore();
  const onDeliveryResult = vi.fn(() => settled.resolve());
  const sendMessage = vi.fn<SendMessage>(async (params) => {
    await params.onDeliveryResult?.({ channel: "discord", messageId: "msg-1" });
    expect(onDeliveryResult).not.toHaveBeenCalled();
    params.onDeliveredPayload?.({ text: "Image ready", mediaUrls: [image] });
    await mirror.promise;
    throw new Error("post-send bookkeeping failed");
  });
  const delivery = deliver({ event: imageEvent, sendMessage, onDeliveryResult });
  try {
    await settled.promise;
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...delivered, deliveredAt: expect.any(Number) }),
    );
  } finally {
    mirror.resolve();
  }
  expect((await delivery).result).toMatchObject(delivered);
  expect(onDeliveryResult).toHaveBeenCalledOnce();
});
