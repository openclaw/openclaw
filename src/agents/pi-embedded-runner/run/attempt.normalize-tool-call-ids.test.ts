import { describe, expect, it } from "vitest";
import { normalizeToolCallIdsInMessage } from "./normalize-tool-call-ids.js";

describe("normalizeToolCallIdsInMessage", () => {
  it("keeps unique non-empty IDs unchanged", () => {
    const message = {
      content: [
        { type: "toolUse", id: "call_1", name: "exec" },
        { type: "toolUse", id: "call_2", name: "read" },
      ],
    };
    normalizeToolCallIdsInMessage(message);
    expect(message.content[0].id).toBe("call_1");
    expect(message.content[1].id).toBe("call_2");
  });

  it("assigns fallback IDs to empty tool call blocks", () => {
    const message = {
      content: [
        { type: "toolUse", id: "", name: "exec" },
        { type: "toolUse", id: "  ", name: "read" },
      ],
    };
    normalizeToolCallIdsInMessage(message);
    expect(message.content[0].id).toBe("call_auto_1");
    expect(message.content[1].id).toBe("call_auto_2");
  });

  it("deduplicates identical tool_call_ids within the same message", () => {
    // Regression test for #40897: clients like Cursor/Codex can generate
    // duplicate IDs (e.g. "edit:22") for multiple tool calls in one turn,
    // causing HTTP 400 from OpenAI-compatible backends.
    const message = {
      content: [
        { type: "toolUse", id: "edit:22", name: "edit" },
        { type: "toolUse", id: "edit:22", name: "edit" },
        { type: "toolUse", id: "edit:22", name: "edit" },
      ],
    };
    normalizeToolCallIdsInMessage(message);
    const ids = message.content.map((b) => b.id);
    // First occurrence keeps the original ID
    expect(ids[0]).toBe("edit:22");
    // Subsequent duplicates get unique fallback IDs
    expect(ids[1]).not.toBe("edit:22");
    expect(ids[2]).not.toBe("edit:22");
    // All IDs are unique
    expect(new Set(ids).size).toBe(3);
  });

  it("handles a mix of duplicates and empty IDs", () => {
    const message = {
      content: [
        { type: "toolUse", id: "abc", name: "exec" },
        { type: "toolUse", id: "", name: "read" },
        { type: "toolUse", id: "abc", name: "write" },
        { type: "toolUse", id: "xyz", name: "edit" },
        { type: "toolUse", id: "xyz", name: "edit" },
      ],
    };
    normalizeToolCallIdsInMessage(message);
    const ids = message.content.map((b) => b.id);
    expect(ids[0]).toBe("abc");
    expect(ids[3]).toBe("xyz");
    // All 5 IDs must be unique
    expect(new Set(ids).size).toBe(5);
  });

  it("is a no-op for non-tool-use content blocks", () => {
    const message = {
      content: [
        { type: "text", text: "hello" },
        { type: "toolUse", id: "call_1", name: "exec" },
      ],
    };
    normalizeToolCallIdsInMessage(message);
    expect(message.content[0]).toEqual({ type: "text", text: "hello" });
    expect(message.content[1].id).toBe("call_1");
  });

  it("handles null/undefined message gracefully", () => {
    expect(() => normalizeToolCallIdsInMessage(null)).not.toThrow();
    expect(() => normalizeToolCallIdsInMessage(undefined)).not.toThrow();
    expect(() => normalizeToolCallIdsInMessage({})).not.toThrow();
  });
});
