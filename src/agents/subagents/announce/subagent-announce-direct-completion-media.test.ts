import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundDeliveryError } from "../../../infra/outbound/deliver-types.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../internal-runtime-context.js";
import { mockCallArg, taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";
import type { SubagentAnnounceDeliveryTestDeps } from "./subagent-announce-overrides.test-support.js";

type SendMessage = SubagentAnnounceDeliveryTestDeps["sendMessage"];
const image = "/tmp/generated.png";
const hidden = [
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  "This context is runtime-generated, not user-authored. Keep internal details private.",
  "MEDIA:/tmp/hidden.png",
  INTERNAL_RUNTIME_CONTEXT_END,
].join("\n");
const sent = {
  channel: "discord",
  to: "dm:U123",
  via: "direct" as const,
  mediaUrl: null,
  result: { messageId: "msg-1" },
};

async function deliver(params: {
  event?: Partial<AgentInternalEvent>;
  payloads?: Record<string, unknown>[];
  sendMessage?: SendMessage;
  onDeliveryResult?: Parameters<typeof deliverSubagentAnnouncement>[0]["onDeliveryResult"];
}) {
  const sendMessage = params.sendMessage ?? vi.fn<SendMessage>(async () => sent);
  const queue = vi.fn((sessionId: string) => ({
    queued: false as const,
    reason: "no_active_run" as const,
    gatewayHealth: "live" as const,
    sessionId,
  }));
  testing.setDepsForTest({
    callGateway: vi.fn(async () => {
      if (params.event?.status === "error") {
        throw new Error("provider rejected requester synthesis");
      }
      return { result: { payloads: params.payloads ?? [] } };
    }),
    getRequesterSessionActivity: () => ({ sessionId: "requester-session", isActive: true }),
    queueEmbeddedAgentMessageWithOutcome: queue,
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
  });
  expect(queue).toHaveBeenCalled();
  return { result, sendMessage: vi.mocked(sendMessage) };
}

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
  testing.setDepsForTest();
});

describe("subagent completion media after requester wake failure", () => {
  it.each<{
    name: string;
    event?: Partial<AgentInternalEvent>;
    payloads?: Record<string, unknown>[];
    content?: string;
    absent?: boolean;
    media?: string[];
    asVoice?: boolean;
  }>([
    {
      name: "structured media",
      event: { mediaUrls: [image] },
      content: "Image ready",
      media: [image],
    },
    {
      name: "captionless media",
      event: { result: "", mediaUrls: [image] },
      content: "",
      media: [image],
    },
    {
      name: "attachment metadata",
      event: { attachments: [{ type: "image" as const, path: image }] },
      content: "Image ready",
      media: [image],
    },
    {
      name: "visible directive beside hidden context",
      event: { result: `Image ready\nMEDIA:${image}\n${hidden}` },
      content: "Image ready",
      media: [image],
    },
    {
      name: "voice directive",
      event: { result: "[[audio_as_voice]]\nMEDIA:/tmp/voice.ogg" },
      content: "",
      media: ["/tmp/voice.ogg"],
      asVoice: true,
    },
    {
      name: "hidden-only media",
      event: { result: `Image ready\n${hidden}` },
      content: "Image ready",
      media: undefined,
    },
    {
      name: "genuine placeholder-shaped result",
      event: { result: "(no output)" },
      content: "(no output)",
      media: undefined,
    },
    {
      name: "requester voice payload",
      payloads: [
        {
          text: `Voice ready\nMEDIA:/tmp/voice.ogg\n${hidden}`,
          mediaUrls: ["/tmp/voice.ogg"],
          audioAsVoice: true,
        },
      ],
      content: "Voice ready",
      media: ["/tmp/voice.ogg"],
      asVoice: true,
    },
    {
      name: "recorded absent result",
      event: { result: "(no output)", noVisibleResult: true },
      absent: true,
    },
    {
      name: "failed completion without its media",
      event: { status: "error", statusLabel: "failed", result: "(no output)", mediaUrls: [image] },
    },
  ])(
    "delivers only visible completed content: $name",
    async ({ event, payloads, content, media, asVoice, absent }) => {
      const { result, sendMessage } = await deliver({ event, payloads });
      if (absent) {
        expect(sendMessage).not.toHaveBeenCalled();
        return;
      }
      expect(result).toMatchObject({ delivered: true, path: "direct" });
      expect(sendMessage).toHaveBeenCalledOnce();
      const payload = mockCallArg(sendMessage);
      if (content !== undefined) {
        expect(payload.content).toBe(content);
      }
      expect(payload.mediaUrls).toEqual(media);
      expect(payload.asVoice).toBe(asVoice);
    },
  );

  it("does not settle or retry a partially sent media batch", async () => {
    const onDeliveryResult = vi.fn();
    const sendMessage = vi.fn<SendMessage>(async (params) => {
      await params.onDeliveryResult?.({ channel: "discord", messageId: "msg-1" });
      throw new OutboundDeliveryError("second attachment failed", {
        cause: new Error("platform rejected media"),
        results: [{ channel: "discord", messageId: "msg-1" }],
      });
    });
    const { result } = await deliver({
      event: { mediaUrls: [image] },
      sendMessage,
      onDeliveryResult,
    });
    expect(result).toMatchObject({
      delivered: false,
      terminal: true,
      disposition: "permanent_failure",
      missingMediaUrls: [image],
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
    const delivery = deliver({ event: { mediaUrls: [image] }, sendMessage, onDeliveryResult });
    try {
      await settled.promise;
      expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          delivered: true,
          path: "direct",
          deliveredAt: expect.any(Number),
        }),
      );
    } finally {
      mirror.resolve();
    }
    expect((await delivery).result).toMatchObject({ delivered: true, path: "direct" });
    expect(onDeliveryResult).toHaveBeenCalledOnce();
  });
});
