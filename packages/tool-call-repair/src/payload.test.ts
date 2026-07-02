import { describe, expect, it } from "vitest";
import {
  parseStandalonePlainTextToolCallBlocks,
  stripPlainTextToolCallBlocks,
} from "./payload.js";

describe("parseStandalonePlainTextToolCallBlocks", () => {
  it("parses a single bracket-style tool call", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[get_weather]\n{"city":"NYC"}\n[END_TOOL_REQUEST]',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.name).toBe("get_weather");
    expect(result![0]!.arguments).toEqual({ city: "NYC" });
  });

  it("parses multiple bracket-style tool calls", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[get_weather]\n{"city":"NYC"}\n[END_TOOL_REQUEST]\n[search]\n{"q":"hello"}\n[/search]',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]!.name).toBe("get_weather");
    expect(result![1]!.name).toBe("search");
  });

  it("parses tool: prefix bracket opening (no newline or closing marker required)", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[tool:get_weather]{"city":"NYC"}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.name).toBe("get_weather");
    expect(result![0]!.arguments).toEqual({ city: "NYC" });
  });

  it("parses harmony-style tool call with channel marker", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '<|channel|>commentary to=get_weather code {"city":"NYC"}<|call|>',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.name).toBe("get_weather");
  });

  it("parses harmony-style tool call without channel marker", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      'analysis to=search code {"q":"test"}<|call|>',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.name).toBe("search");
  });

  it("parses harmony-style with optional message marker", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      'final to=summarize code <|message|> {"text":"hello"}<|call|>',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]!.name).toBe("summarize");
  });

  it("respects allowedToolNames filter", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[get_weather]\n{"city":"NYC"}\n[END_TOOL_REQUEST]',
      { allowedToolNames: ["get_weather"] },
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
  });

  it("rejects tool calls with names not in allowedToolNames", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[get_weather]\n{"city":"NYC"}\n[END_TOOL_REQUEST]',
      { allowedToolNames: ["search"] },
    );
    expect(result).toBeNull();
  });

  it("rejects text that is not a tool call", () => {
    const result = parseStandalonePlainTextToolCallBlocks("hello world");
    expect(result).toBeNull();
  });

  it("returns null for empty input", () => {
    const result = parseStandalonePlainTextToolCallBlocks("");
    expect(result).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    const result = parseStandalonePlainTextToolCallBlocks("  \n  ");
    expect(result).toBeNull();
  });

  it("rejects input with mixed text and tool calls", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      'some text [get_weather]\n{"city":"NYC"}\n[END_TOOL_REQUEST]',
    );
    expect(result).toBeNull();
  });

  it("rejects tool call with invalid JSON", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[get_weather]\n{invalid}\n[END_TOOL_REQUEST]',
    );
    expect(result).toBeNull();
  });

  it("rejects tool call where JSON is an array", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[get_weather]\n[1,2,3]\n[END_TOOL_REQUEST]',
    );
    expect(result).toBeNull();
  });

  it("rejects tool call with missing closing marker for bracket style", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[get_weather]\n{"city":"NYC"}',
    );
    expect(result).toBeNull();
  });

  it("rejects tool call with mismatched closing marker", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[get_weather]\n{"city":"NYC"}\n[/wrong_name]',
    );
    expect(result).toBeNull();
  });

  it("honors maxPayloadBytes limit", () => {
    const largePayload = `{"data":"${"x".repeat(100)}"}`;
    const result = parseStandalonePlainTextToolCallBlocks(
      `[get_weather]\n${largePayload}\n[END_TOOL_REQUEST]`,
      { maxPayloadBytes: 10 },
    );
    expect(result).toBeNull();
  });

  it("handles tool: prefix with optional xmlish close (no close needed)", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[tool:get_weather]{"city":"NYC"}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
  });

  it("handles consecutive tool: calls without closers", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[tool:search]{"q":"hello"}[tool:weather]{"city":"NYC"}',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0]!.name).toBe("search");
    expect(result![1]!.name).toBe("weather");
  });

  it("rejects bracket style missing newline before JSON", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[get_weather]{"city":"NYC"}\n[END_TOOL_REQUEST]',
    );
    expect(result).toBeNull();
  });

  it("parses with \\r\\n line endings", () => {
    const result = parseStandalonePlainTextToolCallBlocks(
      '[get_weather]\r\n{"city":"NYC"}\r\n[END_TOOL_REQUEST]',
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
  });

  it("records raw and offsets correctly", () => {
    const text = '[get_weather]\n{"city":"NYC"}\n[END_TOOL_REQUEST]';
    const result = parseStandalonePlainTextToolCallBlocks(text);
    expect(result).not.toBeNull();
    expect(result![0]!.start).toBe(0);
    expect(result![0]!.end).toBe(text.length);
    expect(result![0]!.raw).toBe(text);
  });
});

describe("stripPlainTextToolCallBlocks", () => {
  it("removes a bracket-style tool call from text", () => {
    const result = stripPlainTextToolCallBlocks(
      'some text\n[get_weather]\n{"city":"NYC"}\n[END_TOOL_REQUEST]\nmore text',
    );
    expect(result).toBe("some text\nmore text");
  });

  it("returns text unchanged when no tool call present", () => {
    const result = stripPlainTextToolCallBlocks("hello world");
    expect(result).toBe("hello world");
  });

  it("returns empty string for empty input", () => {
    expect(stripPlainTextToolCallBlocks("")).toBe("");
  });

  it("removes tool call at the start of text", () => {
    const result = stripPlainTextToolCallBlocks(
      '[get_weather]\n{"city":"NYC"}\n[END_TOOL_REQUEST]\nremaining',
    );
    expect(result).toBe("remaining");
  });

  it("removes tool call at the end of text", () => {
    const result = stripPlainTextToolCallBlocks(
      'prefix\n[get_weather]\n{"city":"NYC"}\n[END_TOOL_REQUEST]',
    );
    expect(result).toBe("prefix\n");
  });

  it("removes multiple tool call blocks", () => {
    const result = stripPlainTextToolCallBlocks(
      'start\n[get_weather]\n{"city":"NYC"}\n[END_TOOL_REQUEST]\nmid\n[search]\n{"q":"x"}\n[/search]\nend',
    );
    expect(result).toBe("start\nmid\nend");
  });

  it("removes tool: prefix tool call at line start", () => {
    const result = stripPlainTextToolCallBlocks(
      'before\n[tool:get_weather]{"city":"NYC"}\nafter',
    );
    expect(result).toBe("before\nafter");
  });
});
