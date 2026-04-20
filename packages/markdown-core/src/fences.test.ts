import { describe, expect, it } from "vitest";
import { parseFenceSpans } from "./fences.js";

describe("parseFenceSpans", () => {
  it("closes fence with only whitespace after marker", () => {
    const input = "```\ncode\n```   \noutside";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBeLessThan(input.length);
  });

  it("does not close fence when trailing text follows marker", () => {
    const input = "```\ncode\n``` not closed\noutside";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    // Fence should extend to EOF since closing line is invalid
    expect(spans[0].end).toBe(input.length);
  });

  it("closes fence with empty string after marker", () => {
    const input = "```\ncode\n```\noutside";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBeLessThan(input.length);
  });

  it("closes fence when closing marker is longer", () => {
    const input = "```\ncode\n`````\noutside";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBeLessThan(input.length);
  });

  it("does not close fence with different marker char", () => {
    const input = "```\ncode\n~~~";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBe(input.length);
  });

  it("does not close fence when closing marker is shorter", () => {
    const input = "````\ncode\n```";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBe(input.length);
  });

  it("handles tilde fence with trailing text correctly", () => {
    const input = "~~~\ncode\n~~~ text\noutside";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBe(input.length);
  });

  it("handles unclosed fence extending to EOF", () => {
    const input = "```\ncode\nmore code";
    const spans = parseFenceSpans(input);
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBe(input.length);
  });
});
