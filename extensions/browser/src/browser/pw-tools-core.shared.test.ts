// Browser tests cover pw tools core.shared plugin behavior.
import { describe, expect, it } from "vitest";
import { BrowserActionError, BrowserCdpEndpointBlockedError } from "./errors.js";
import { normalizeTimeoutMs, toAIFriendlyError } from "./pw-tools-core.shared.js";

describe("pw-tools-core shared timeout normalization", () => {
  it("uses the fallback for non-finite timeout values", () => {
    expect(normalizeTimeoutMs(Number.NaN, 20_000)).toBe(20_000);
    expect(normalizeTimeoutMs(Number.POSITIVE_INFINITY, 20_000)).toBe(20_000);
  });

  it("clamps and floors finite timeout values", () => {
    expect(normalizeTimeoutMs(499, 20_000)).toBe(500);
    expect(normalizeTimeoutMs(1_234.9, 20_000)).toBe(1_234);
    expect(normalizeTimeoutMs(999_999, 20_000)).toBe(120_000);
  });
});

describe("Playwright action diagnostics", () => {
  it.each([
    {
      headline:
        "locator.fill: Error: Element is not an <input>, <textarea>, <select> or [contenteditable]",
      terminal: "",
      expected: /not editable/,
    },
    {
      headline: "locator.fill: Error: Cannot type text into input[type=number]",
      terminal: "",
      expected: /numeric value/,
    },
    {
      headline: 'locator.fill: Error: Input of type "range" cannot be filled',
      terminal: "",
      expected: /input type that cannot be filled/,
    },
    {
      headline: "locator.fill: Error: Malformed value",
      terminal: "",
      expected: /value format/,
    },
    {
      headline: "locator.fill: Timeout 700ms exceeded.",
      terminal: "element is not editable",
      expected: /not editable/,
    },
    {
      headline: "locator.click: Timeout 700ms exceeded.",
      terminal: "element is not enabled",
      expected: /not enabled/,
    },
    {
      headline: "locator.click: Timeout 700ms exceeded.",
      terminal: '<div class="overlay">overlay</div> intercepts pointer events',
      expected: /covered; another element intercepts pointer events/,
    },
    {
      headline: "locator.click: Timeout 700ms exceeded.",
      terminal: "element is not stable",
      expected: /not stable/,
    },
  ])("preserves $expected after verbose progress logging", ({ headline, terminal, expected }) => {
    const original = new Error(
      `${headline}\nCall log:\n` +
        `  - waiting for locator('input')\n  - locator resolved to <input/>\n` +
        `  - fill("${"x".repeat(2_000)}")\n` +
        `  - waiting for element to be visible, enabled and editable\n` +
        `\u001b[2m    - ${terminal}\u001b[22m\n`,
    );
    const error = toAIFriendlyError(original, "e1");
    expect(error).toBeInstanceOf(BrowserActionError);
    expect(error.cause).toBe(original);
    expect(error.message).toMatch(expected);
    expect(error.message).not.toMatch(/not found or not visible|xxx/);
    expect(error.message.length).toBeLessThan(1_000);
  });

  it.each([
    new BrowserCdpEndpointBlockedError(),
    new Error("browserType.connectOverCDP: Timeout 30000ms exceeded. waiting for websocket"),
    new Error(
      "locator.fill: Target page, context or browser has been closed\nCall log:\n  - waiting for locator('input')\n  - locator resolved to <input readonly/>\n  - element is not editable",
    ),
    new Error(
      'locator.fill: Timeout 700ms exceeded.\nCall log:\n  - locator resolved to <input/>\n  - fill("element is not editable")',
    ),
  ])("preserves unclassified and policy failures: $message", (error) => {
    expect(toAIFriendlyError(error, "e1")).toBe(error);
  });
});
