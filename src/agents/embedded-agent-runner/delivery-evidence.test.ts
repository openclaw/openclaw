import { describe, expect, it } from "vitest";
import {
  collectDeliveredMediaUrls,
  hasCompletedSourceReplyDeliveryEvidence,
  getAutomaticDeliveryEvidence,
  getGatewayAgentResult,
  hasUnaccountedMessagingToolAggregateEvidence,
  hasVisibleOutboundDeliveryEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "./delivery-evidence.js";
import {
  isMeaningfulTranscriptMessage,
  isTerminalSilentAssistantMessage,
} from "./message-visibility.js";

describe("explicit final source-reply delivery evidence", () => {
  it("distinguishes progress from a delivered final reply", () => {
    expect(
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSentTargets: [{ sourceReplyFinal: false }],
      }),
    ).toBe(false);
    expect(
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSentTargets: [{ sourceReplyFinal: false }, { sourceReplyFinal: true }],
      }),
    ).toBe(true);
    expect(
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSourceReplyPayloads: [{ sourceReplyFinal: true }],
      }),
    ).toBe(true);
  });

  it("returns undefined for legacy telemetry without final markers", () => {
    expect(
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSourceReplyPayloads: [{ text: "legacy reply" }],
      }),
    ).toBeUndefined();
  });

  it.each([
    { name: "legacy", final: undefined, state: undefined, delivered: true },
    { name: "explicit progress", final: false, state: undefined, delivered: false },
    { name: "explicit final", final: true, state: undefined, delivered: true },
    { name: "earlier input", final: true, state: "missing", delivered: false },
  ] as const)("honors $name evidence over coarse send flags", ({ final, state, delivered }) => {
    expect(
      hasCompletedSourceReplyDeliveryEvidence({
        sourceReplyDelivered: true,
        didDeliverSourceReplyViaMessageTool: true,
        sourceReplyDeliveryState: state,
        messagingToolSentTargets: final === undefined ? [] : [{ sourceReplyFinal: final }],
      }),
    ).toBe(delivered);
  });
});

describe("visible messaging-tool delivery evidence", () => {
  it("keeps the coarse flag when detailed delivery metadata is unavailable", () => {
    expect(hasVisibleOutboundDeliveryEvidence({ didSendViaMessagingTool: true })).toBe(true);
  });

  it("lets detailed metadata disprove a coarse send flag", () => {
    expect(
      hasVisibleOutboundDeliveryEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["  "],
        messagingToolSentMediaUrls: ["\t"],
        messagingToolSentTargets: [{ text: "\n" }],
      }),
    ).toBe(false);
  });

  it("keeps rich delivery evidence when accompanying text is blank", () => {
    expect(
      hasVisibleOutboundDeliveryEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [{ text: "  ", hasRichContent: true }],
      }),
    ).toBe(true);
  });
});

describe("route-checkable messaging-tool aggregate evidence", () => {
  it("accepts aggregate evidence fully represented by target records", () => {
    expect(
      hasUnaccountedMessagingToolAggregateEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["ready"],
        messagingToolSentMediaUrls: ["/tmp/one.png"],
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "channel:123",
            text: "ready",
            mediaUrls: ["/tmp/one.png"],
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects aggregate sends missing from mixed target records", () => {
    expect(
      hasUnaccountedMessagingToolAggregateEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: ["/tmp/one.png", "/tmp/two.png"],
        messagingToolSentTargets: [
          {
            provider: "discord",
            to: "channel:123",
            mediaUrls: ["/tmp/one.png"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("accounts for duplicate aggregate sends by multiplicity", () => {
    expect(
      hasUnaccountedMessagingToolAggregateEvidence({
        messagingToolSentMediaUrls: ["/tmp/proof.png", "/tmp/proof.png"],
        messagingToolSentTargets: [
          { provider: "discord", to: "channel:123", mediaUrls: ["/tmp/proof.png"] },
        ],
      }),
    ).toBe(true);
  });
});

describe("collectDeliveredMediaUrls attachment recursion", () => {
  it("collects unique media URLs in payload, aggregate, and target order", () => {
    const urls = collectDeliveredMediaUrls({
      payloads: [
        Object.assign([], { url: "https://example.com/ignored-array.png" }),
        {
          url: "https://example.com/root.png",
          attachments: [
            { mediaUrl: "https://example.com/child.png" },
            { attachments: [{ filePath: "/tmp/grandchild.jpg" }] },
          ],
        },
      ],
      messagingToolSentMediaUrls: ["https://example.com/root.png", "/tmp/aggregate.png"],
      messagingToolSentTargets: [
        Object.assign([], { mediaUrl: "/tmp/ignored-target.png" }),
        { mediaUrls: ["/tmp/aggregate.png", "/tmp/target.png"] },
      ],
    });
    expect(urls).toEqual([
      "https://example.com/root.png",
      "https://example.com/child.png",
      "/tmp/grandchild.jpg",
      "/tmp/aggregate.png",
      "/tmp/target.png",
    ]);
  });

  it("does not overflow on a mutual attachments cycle", () => {
    const a: Record<string, unknown> = { mediaUrl: "https://example.com/a.png" };
    const b: Record<string, unknown> = { mediaUrl: "https://example.com/b.png" };
    a.attachments = [b];
    b.attachments = [a];

    const urls = collectDeliveredMediaUrls({ payloads: [a] });
    expect(urls.toSorted()).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
  });
});

describe("queued delivery evidence", () => {
  it("retains array-backed result/status metadata", () => {
    const payloads = [{ mediaUrl: "/tmp/proof.png" }];
    const payloadOutcomes: unknown[] = [Object.assign([], { index: 0, status: "sent" })];
    const result = Object.assign([], {
      payloads,
      deliveryStatus: Object.assign([], { status: "sent", payloadOutcomes }),
    });
    expect(getGatewayAgentResult(result)).toBe(result);
    expect(getGatewayAgentResult({ result })).toBe(result);
  });

  it("treats a payload that failed after sending as a possible send", () => {
    const partial = {
      deliveryStatus: {
        status: "partial_failed",
        payloadOutcomes: [
          { index: 0, status: "sent" },
          { index: 1, status: "failed", sentBeforeError: true },
        ],
      },
    };
    expect(getAutomaticDeliveryEvidence(partial).mayHaveSent).toBe(true);
  });
});

describe("agent reply visibility", () => {
  it("classifies terminal silent transcript messages and meaningful tails", () => {
    expect(
      isTerminalSilentAssistantMessage({
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", text: "internal" },
          { type: "text", text: "NO_REPLY" },
        ],
      }),
    ).toBe(true);
    expect(isMeaningfulTranscriptMessage({ role: "system" })).toBe(false);
    expect(isMeaningfulTranscriptMessage({ role: "toolResult" })).toBe(true);
  });
});
