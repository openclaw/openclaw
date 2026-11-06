import { describe, expect, it } from "vitest";
import {
  hasCompletedSourceReplyDeliveryEvidence,
  getAutomaticDeliveryEvidence,
  getGatewayAgentResult,
  hasUnaccountedMessagingToolAggregateEvidence,
  hasVisibleOutboundDeliveryEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "./delivery-evidence.js";
import { hasVisibleAgentPayload } from "./message-visibility.js";

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

describe("hasVisibleAgentPayload attachment recursion", () => {
  it("finds nested media while rejecting blank and malformed attachments", () => {
    const invalidAttachments = [
      null,
      42,
      { mediaUrl: " ", mediaUrls: [null, 42, "\t"], path: "", url: "\n", filePath: " " },
      Object.assign([], { url: "https://example.com/ignored-array.png" }),
      Object.assign([], { mediaUrl: "/tmp/ignored-array.png" }),
    ];
    expect(hasVisibleAgentPayload({ payloads: [{ attachments: invalidAttachments }] })).toBe(false);
    for (const attachment of [
      { mediaUrl: "https://example.com/child.png" },
      { attachments: [{ filePath: "/tmp/grandchild.jpg" }] },
    ]) {
      expect(
        hasVisibleAgentPayload({
          payloads: [{ attachments: [...invalidAttachments, attachment] }],
        }),
      ).toBe(true);
    }
  });

  it("does not overflow on a mutual attachments cycle", () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    a.attachments = [b];
    b.attachments = [a];

    const result = { payloads: [{ attachments: [a] }] };
    expect(hasVisibleAgentPayload(result)).toBe(false);
    b.mediaUrl = "https://example.com/b.png";
    expect(hasVisibleAgentPayload(result)).toBe(true);
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
