import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { estimateMessageCharsCached, getToolResultText } from "./tool-result-char-estimator.js";

const estimate = (message: AgentMessage) => estimateMessageCharsCached(message, new WeakMap());
const tool = (content: unknown) =>
  castAgentMessage({ role: "toolResult", toolName: "read", content, timestamp: 0 });
const textBlock = (text: string) => ({ type: "text" as const, text });
const bash = (output: string, excludeFromContext = false) =>
  castAgentMessage({
    role: "bashExecution",
    command: "npm run build",
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
    excludeFromContext,
  });

describe("tool-result-char-estimator", () => {
  // #34979: plugin results without text must use the unknown-block fallback, not crash.
  it.each([
    ["missing text", [{ type: "text" }], 30],
    ["null entry", [null, textBlock("ok")], 12],
    ["ASCII", [textBlock("hello world")], 22],
    ["CJK weighting without multiplying the ASCII floor", [textBlock("你好")], 8],
  ] as const)("estimates %s", (_name, content, expected) => {
    expect(estimate(tool(content))).toBe(expected);
  });

  it("getToolResultText skips malformed text blocks", () => {
    expect(getToolResultText(tool([{ type: "text" }, textBlock("valid")]))).toBe("valid");
  });

  it("uses current text when a tool-result block is reused across guard passes", () => {
    const block = textBlock("");
    for (const [text, expected] of [
      ["a".repeat(16_000), 32_000],
      ["你".repeat(16_000), 64_000],
      ["𠀀".repeat(8_000), 128_000],
      ["😀".repeat(8_000), 32_000],
      ["\ud800".repeat(16_000), 32_000],
      ["ok", 4],
      ["", 0],
    ] as const) {
      block.text = text;
      for (let pass = 0; pass < 2; pass += 1) {
        expect(estimate(tool([block]))).toBe(expected);
      }
    }
  });

  it("estimates a large bashExecution near its rendered size", () => {
    expect(estimate(bash("build log line\n".repeat(60000)))).toBeGreaterThan(500_000);
  });

  it.each([
    ["bashExecution", bash("huge output ".repeat(50000), true)],
    [
      "custom",
      castAgentMessage({
        role: "custom",
        customType: "display-note",
        content: "huge output ".repeat(50000),
        display: true,
        excludeFromContext: true,
        timestamp: 1,
      }),
    ],
  ] as const)("returns 0 for excluded %s messages", (_role, message) => {
    expect(estimate(message)).toBe(0);
  });

  it.each([
    ["compactionSummary", "recap ".repeat(20000)],
    ["branchSummary", "branch recap ".repeat(10000)],
  ])("estimates %s with prefix/suffix", (role, summary) => {
    const chars = estimate(castAgentMessage({ role, summary, tokensBefore: 0, timestamp: 1 }));
    expect(chars).toBeGreaterThan(summary.length);
    expect(chars).toBeGreaterThan(256);
  });

  it.each([true, false])("estimates custom message with display=%s", (display) => {
    const content = "custom data ".repeat(5000);
    expect(
      estimate(
        castAgentMessage({
          role: "custom",
          customType: "test",
          content,
          display,
          timestamp: 1,
        }),
      ),
    ).toBe(content.length);
  });
});
