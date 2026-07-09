// Tests for plain-text tool call payload parsing.
import { describe, expect, test } from "vitest";
import { parseStandalonePlainTextToolCallBlocks } from "./payload.js";

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
