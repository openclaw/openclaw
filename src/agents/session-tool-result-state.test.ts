import { describe, expect, it } from "vitest";
import { createPendingToolCallState, extractToolNameFromId } from "./session-tool-result-state.js";

describe("extractToolNameFromId", () => {
  it.each([
    // Standard formats with separator (Anthropic format)
    ["functions.read:0", "read"],
    ["functions.write:1", "write"],
    ["functions.exec:2", "exec"],

    // Formats with dot but no colon (Kimi format variant)
    ["functions.read0", "read"],
    ["functions.write1", "write"],
    ["functions.exec2", "exec"],

    // Formats without any separator - THE BUG CASE
    ["functionsread3", "read"],
    ["functionswrite4", "write"],
    ["functionsread1", "read"],
    ["functionswrite", "write"],

    // Other prefix formats (trailing digits stripped)
    ["toolCall_abc", "abc"],
    ["toolUse_xyz", "xyz"],
    ["functionCall_test", "test"],

    // Edge cases - no prefix
    ["read", "read"],

    // Empty/invalid
    ["", undefined],
    ["   ", undefined],
  ])("extractToolNameFromId('%s') should return '%s'", (input, expected) => {
    expect(extractToolNameFromId(input)).toBe(expected);
  });
});

describe("createPendingToolCallState - fuzzy matching", () => {
  it("should find tool by exact ID match", () => {
    const state = createPendingToolCallState();
    state.trackToolCalls([{ id: "functions.read:0", name: "read" }]);

    expect(state.getToolName("functions.read:0")).toBe("read");
  });

  it("should find tool when incoming ID format differs from stored ID", () => {
    const state = createPendingToolCallState();
    // Store with standard format
    state.trackToolCalls([{ id: "functions.read:0", name: "read" }]);

    // Lookup with different format (missing separator)
    expect(state.getToolName("functionsread3")).toBe("read");
  });

  it("should find tool when incoming ID is functions.read1 format", () => {
    const state = createPendingToolCallState();
    state.trackToolCalls([{ id: "functions.read:0", name: "read" }]);

    expect(state.getToolName("functions.read1")).toBe("read");
  });

  it("should return undefined for unknown tool ID", () => {
    const state = createPendingToolCallState();
    state.trackToolCalls([{ id: "functions.read:0", name: "read" }]);

    expect(state.getToolName("unknowntool")).toBeUndefined();
  });

  it("should delete tool by fuzzy matching", () => {
    const state = createPendingToolCallState();
    state.trackToolCalls([{ id: "functions.read:0", name: "read" }]);

    expect(state.size()).toBe(1);

    state.delete("functionsread3");

    expect(state.size()).toBe(0);
  });

  it("should handle multiple tools with different names", () => {
    const state = createPendingToolCallState();
    state.trackToolCalls([
      { id: "functions.read:0", name: "read" },
      { id: "functions.write:1", name: "write" },
      { id: "functions.exec:2", name: "exec" },
    ]);

    expect(state.getToolName("functionsread3")).toBe("read");
    expect(state.getToolName("functionswrite4")).toBe("write");
    expect(state.getToolName("functions.exec:2")).toBe("exec");
  });
});
