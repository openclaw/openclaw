import { describe, expect, it } from "vitest";
import {
  collectTextContentBlocks,
  extractCodeExecutionResult,
  isAnthropicServerContentBlock,
  isProgrammaticToolCall,
} from "./content-blocks.js";

describe("isAnthropicServerContentBlock", () => {
  it("returns true for server_tool_use, web_search_tool_result, and code_execution_tool_result", () => {
    expect(isAnthropicServerContentBlock({ type: "server_tool_use" })).toBe(true);
    expect(isAnthropicServerContentBlock({ type: "web_search_tool_result" })).toBe(true);
    expect(isAnthropicServerContentBlock({ type: "code_execution_tool_result" })).toBe(true);
  });

  it("returns false for text, toolCall, and invalid blocks", () => {
    expect(isAnthropicServerContentBlock({ type: "text", text: "hi" })).toBe(false);
    expect(isAnthropicServerContentBlock({ type: "toolCall", id: "1", name: "read" })).toBe(false);
    expect(isAnthropicServerContentBlock(null)).toBe(false);
    expect(isAnthropicServerContentBlock({})).toBe(false);
  });
});

describe("collectTextContentBlocks", () => {
  it("collects text content blocks in order", () => {
    const blocks = [
      { type: "text", text: "first" },
      { type: "image", data: "abc" },
      { type: "text", text: "second" },
    ];

    expect(collectTextContentBlocks(blocks)).toEqual(["first", "second"]);
  });

  it("ignores invalid entries and non-arrays", () => {
    expect(collectTextContentBlocks(null)).toEqual([]);
    expect(collectTextContentBlocks([{ type: "text", text: 1 }, undefined, "x"])).toEqual([]);
  });
});

describe("isProgrammaticToolCall", () => {
  it("returns true for tool_use with code_execution caller", () => {
    expect(
      isProgrammaticToolCall({
        type: "tool_use",
        id: "tu_1",
        name: "exec",
        input: { command: "ls" },
        caller: { type: "code_execution_20260120", id: "ce_1" },
      }),
    ).toBe(true);
  });

  it("returns true for any code_execution_ version in caller", () => {
    expect(
      isProgrammaticToolCall({
        type: "tool_use",
        id: "tu_2",
        name: "web_search",
        input: {},
        caller: { type: "code_execution_20260209", id: "ce_2" },
      }),
    ).toBe(true);
  });

  it("returns false for regular tool_use without caller", () => {
    expect(
      isProgrammaticToolCall({
        type: "tool_use",
        id: "tu_3",
        name: "exec",
        input: {},
      }),
    ).toBe(false);
  });

  it("returns false for non-tool_use blocks", () => {
    expect(isProgrammaticToolCall({ type: "text", text: "hello" })).toBe(false);
    expect(isProgrammaticToolCall({ type: "server_tool_use" })).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(isProgrammaticToolCall(null)).toBe(false);
    expect(isProgrammaticToolCall(undefined)).toBe(false);
    expect(isProgrammaticToolCall({})).toBe(false);
  });
});

describe("extractCodeExecutionResult", () => {
  it("extracts stdout, stderr, and return_code from valid block", () => {
    const result = extractCodeExecutionResult({
      type: "code_execution_tool_result",
      content: {
        type: "code_execution_result",
        stdout: "hello world\n",
        stderr: "",
        return_code: 0,
      },
    });
    expect(result).toEqual({
      stdout: "hello world\n",
      stderr: "",
      returnCode: 0,
    });
  });

  it("handles non-zero return codes and stderr", () => {
    const result = extractCodeExecutionResult({
      type: "code_execution_tool_result",
      content: {
        type: "code_execution_result",
        stdout: "",
        stderr: "Error: file not found\n",
        return_code: 1,
      },
    });
    expect(result).toEqual({
      stdout: "",
      stderr: "Error: file not found\n",
      returnCode: 1,
    });
  });

  it("defaults missing fields to empty/zero", () => {
    const result = extractCodeExecutionResult({
      type: "code_execution_tool_result",
      content: {
        type: "code_execution_result",
      },
    });
    expect(result).toEqual({
      stdout: "",
      stderr: "",
      returnCode: 0,
    });
  });

  it("returns null for wrong block type", () => {
    expect(extractCodeExecutionResult({ type: "text", text: "hi" })).toBeNull();
    expect(extractCodeExecutionResult({ type: "tool_use" })).toBeNull();
  });

  it("returns null for wrong content type", () => {
    expect(
      extractCodeExecutionResult({
        type: "code_execution_tool_result",
        content: { type: "other" },
      }),
    ).toBeNull();
  });

  it("returns null for null/undefined/empty", () => {
    expect(extractCodeExecutionResult(null)).toBeNull();
    expect(extractCodeExecutionResult(undefined)).toBeNull();
    expect(extractCodeExecutionResult({})).toBeNull();
  });
});
