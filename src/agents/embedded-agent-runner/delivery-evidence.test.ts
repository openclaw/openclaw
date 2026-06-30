import { describe, expect, it } from "vitest";
import {
  collectDeliveredMediaUrls,
  collectNestedVisibleText,
  hasVisibleAgentPayload,
} from "./delivery-evidence.js";

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

describe("hasVisibleAgentPayload nested text", () => {
  it("detects visible text only at the top level by default", () => {
    const result = { payloads: [{ content: "hello from a wrapped child reply" }] };
    expect(hasVisibleAgentPayload(result)).toBe(false);
    expect(hasVisibleAgentPayload(result, { includeNestedText: true })).toBe(true);
  });

  it("finds visible text nested under content/result/output when opted in", () => {
    const result = {
      payloads: [{ result: { output: [{ content: "deeply nested reply text" }] } }],
    };
    expect(hasVisibleAgentPayload(result, { includeNestedText: true })).toBe(true);
  });

  it("skips error, reasoning, and thinking branches", () => {
    expect(
      hasVisibleAgentPayload(
        { payloads: [{ isError: true, content: "boom" }] },
        { includeNestedText: true },
      ),
    ).toBe(false);
    expect(
      hasVisibleAgentPayload(
        { payloads: [{ content: [{ type: "thinking", text: "internal monologue" }] }] },
        { includeNestedText: true },
      ),
    ).toBe(false);
  });

  it("preserves existing top-level detection without the opt-in", () => {
    expect(hasVisibleAgentPayload({ payloads: [{ text: "plain visible reply" }] })).toBe(true);
  });

  it("does not overflow the stack on a self-referential nested payload", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.content = cyclic;
    expect(() =>
      hasVisibleAgentPayload({ payloads: [cyclic] }, { includeNestedText: true }),
    ).not.toThrow();
  });
});

describe("collectNestedVisibleText", () => {
  it("collects trimmed text from nested wrapper keys", () => {
    expect(
      collectNestedVisibleText({ result: { output: [{ content: "  nested answer  " }] } }),
    ).toEqual(["nested answer"]);
  });

  it("skips error, reasoning, and thinking branches", () => {
    expect(collectNestedVisibleText({ isError: true, content: "boom" })).toEqual([]);
    expect(collectNestedVisibleText({ isReasoning: true, text: "scratch" })).toEqual([]);
    expect(collectNestedVisibleText({ type: "thinking", text: "monologue" })).toEqual([]);
  });

  it("returns every visible string so callers can filter (e.g. silent tokens)", () => {
    expect(collectNestedVisibleText({ content: ["NO_REPLY", { result: "real answer" }] })).toEqual([
      "NO_REPLY",
      "real answer",
    ]);
  });

  it("does not overflow on a self-referential payload", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.content = cyclic;
    expect(() => collectNestedVisibleText(cyclic)).not.toThrow();
    expect(collectNestedVisibleText(cyclic)).toEqual([]);
  });
});
