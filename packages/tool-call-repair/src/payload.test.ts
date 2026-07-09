// Tests for plain-text tool call payload parsing.
import { describe, expect, test } from "vitest";
import { parseStandalonePlainTextToolCallBlocks, stripPlainTextToolCallBlocks } from "./payload.js";

describe("parseStandalonePlainTextToolCallBlocks", () => {
  test("parses a function call with zero parameters", () => {
    const blocks = parseStandalonePlainTextToolCallBlocks("<function=get_system_info></function>");
    expect(blocks).not.toBeNull();
    expect(blocks).toHaveLength(1);
    expect(blocks![0]).toMatchObject({
      name: "get_system_info",
      arguments: {},
    });
  });

  test("parses a function call with parameters", () => {
    const blocks = parseStandalonePlainTextToolCallBlocks(
      "<function=get_weather><parameter=city>Tokyo</parameter></function>",
    );
    expect(blocks).not.toBeNull();
    expect(blocks).toHaveLength(1);
    expect(blocks![0]).toMatchObject({
      name: "get_weather",
      arguments: { city: "Tokyo" },
    });
  });

  test("parses multiple zero-parameter function calls", () => {
    const blocks = parseStandalonePlainTextToolCallBlocks(
      "<function=get_info></function>\n<function=get_status></function>",
    );
    expect(blocks).not.toBeNull();
    expect(blocks).toHaveLength(2);
    expect(blocks![0]).toMatchObject({ name: "get_info", arguments: {} });
    expect(blocks![1]).toMatchObject({ name: "get_status", arguments: {} });
  });

  test("parses mixed parameter and zero-parameter calls", () => {
    const blocks = parseStandalonePlainTextToolCallBlocks(
      "<function=get_info></function>\n<function=get_weather><parameter=city>Tokyo</parameter></function>",
    );
    expect(blocks).not.toBeNull();
    expect(blocks).toHaveLength(2);
    expect(blocks![0]).toMatchObject({ name: "get_info", arguments: {} });
    expect(blocks![1]).toMatchObject({ name: "get_weather", arguments: { city: "Tokyo" } });
  });

  test("returns null for non-tool-call text", () => {
    const blocks = parseStandalonePlainTextToolCallBlocks("hello world");
    expect(blocks).toBeNull();
  });
});

describe("bracket-only marker rejection", () => {
  test("rejects bare [tool:name] bracket markers without JSON body", () => {
    const blocks = parseStandalonePlainTextToolCallBlocks("[tool:exec]\n");
    expect(blocks).toBeNull();
  });

  test("rejects bare [name] bracket markers without JSON body", () => {
    const blocks = parseStandalonePlainTextToolCallBlocks("[exec]");
    expect(blocks).toBeNull();
  });

  test("rejects bracket marker with function close tag suffix", () => {
    // [name] bracket openings set requiresClosing:true; a stray </function>
    // close tag must not promote the bracket to an empty-argument tool call.
    const blocks = parseStandalonePlainTextToolCallBlocks("[exec]\n</function>");
    expect(blocks).toBeNull();
  });

  test("preserves bracket markers when stripping visible text", () => {
    const result = stripPlainTextToolCallBlocks("[tool:exec]\n");
    expect(result).toBe("[tool:exec]\n");
  });

  test("strips zero-parameter XML function calls from visible text", () => {
    const result = stripPlainTextToolCallBlocks("<function=get_info></function>");
    expect(result).toBe("");
  });
});
