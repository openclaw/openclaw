import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundDeliveryError } from "../../../infra/outbound/deliver-types.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
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
  onDeliveryError?: Parameters<typeof deliverSubagentAnnouncement>[0]["onDeliveryError"];
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

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
  testing.setDepsForTest();
});

type MediaCase = {
  name: string;
  input: Parameters<typeof deliver>[0];
  expected: { content?: string; mediaUrls?: string[]; asVoice?: boolean } | null;
};
function mediaCase(
  name: string,
  event: Partial<AgentInternalEvent>,
  expected: MediaCase["expected"] = { content: "Image ready", mediaUrls: [image] },
): MediaCase {
  return { name, input: { event }, expected };
}

describe("subagent completion media after requester wake failure", () => {
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

  it.each<MediaCase>([
    mediaCase("structured media", { mediaUrls: [image] }),
    mediaCase(
      "captionless media",
      { result: "", mediaUrls: [image] },
      { content: "", mediaUrls: [image] },
    ),
    mediaCase("attachment metadata", { attachments: [{ type: "image", path: image }] }),
    mediaCase("visible directive beside hidden context", {
      result: `Image ready\nMEDIA:${image}\n${hidden}`,
    }),
    mediaCase(
      "voice directive",
      { result: "[[audio_as_voice]]\nMEDIA:/tmp/voice.ogg" },
      { content: "", mediaUrls: ["/tmp/voice.ogg"], asVoice: true },
    ),
    mediaCase(
      "hidden-only media",
      { result: `Image ready\n${hidden}` },
      { content: "Image ready" },
    ),
    mediaCase(
      "genuine placeholder-shaped result",
      { result: "(no output)" },
      { content: "(no output)" },
    ),
    {
      name: "requester voice payload",
      input: {
        payloads: [
          {
            text: `Voice ready\nMEDIA:/tmp/voice.ogg\n${hidden}`,
            mediaUrls: ["/tmp/voice.ogg"],
            audioAsVoice: true,
          },
        ],
      },
      expected: { content: "Voice ready", mediaUrls: ["/tmp/voice.ogg"], asVoice: true },
    },
    mediaCase("recorded absent result", { result: "(no output)", noVisibleResult: true }, null),
    mediaCase(
      "failed completion without its media",
      { status: "error", statusLabel: "failed", result: "(no output)", mediaUrls: [image] },
      {},
    ),
  ])("delivers only visible completed content: $name", async ({ input, expected }) => {
    const { result, sendMessage } = await deliver(input);
    if (expected === null) {
      expect(sendMessage).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ delivered: true, path: "direct" });
    expect(sendMessage).toHaveBeenCalledOnce();
    const payload = mockCallArg(sendMessage);
    if (expected.content !== undefined) {
      expect(payload.content).toBe(expected.content);
    }
    expect(payload.mediaUrls).toEqual(expected.mediaUrls);
    expect(payload.asVoice).toBe(expected.asVoice);
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
