import { describe, expect, it } from "vitest";
import {
  collectDeliveredMediaUrls,
  hasVisibleOutboundDeliveryEvidence,
} from "./delivery-evidence.js";

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

describe("collectDeliveredMediaUrls attachment recursion", () => {
  it("collects media URLs across nested attachments", () => {
    const urls = collectDeliveredMediaUrls({
      payloads: [
        {
          url: "https://example.com/root.png",
          attachments: [
            { mediaUrl: "https://example.com/child.png" },
            { attachments: [{ filePath: "/tmp/grandchild.jpg" }] },
          ],
        },
      ],
    });
    expect(urls.toSorted()).toEqual([
      "/tmp/grandchild.jpg",
      "https://example.com/child.png",
      "https://example.com/root.png",
    ]);
  });

  it("does not overflow the stack on a self-referential attachments cycle", () => {
    // Payloads arrive as in-process `unknown` objects; a malformed self-referential
    // attachments chain previously recursed until the stack overflowed.
    const cyclic: Record<string, unknown> = { url: "https://example.com/loop.png" };
    cyclic.attachments = [cyclic];

    let urls: string[] = [];
    expect(() => {
      urls = collectDeliveredMediaUrls({ payloads: [cyclic] });
    }).not.toThrow();
    expect(urls).toEqual(["https://example.com/loop.png"]);
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
