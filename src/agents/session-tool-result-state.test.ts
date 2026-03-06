import { beforeEach, describe, expect, it } from "vitest";
import {
  createPendingToolCallState,
  extractToolNameFromId,
  type PendingToolCallState,
} from "./session-tool-result-state.js";

describe("extractToolNameFromId", () => {
  it("should extract tool name from standard Anthropic format", () => {
    expect(extractToolNameFromId("functions.read:0")).toBe("read");
    expect(extractToolNameFromId("functions.write:1")).toBe("write");
    expect(extractToolNameFromId("functions.exec:2")).toBe("exec");
  });

  it("should extract tool name from format without colon", () => {
    expect(extractToolNameFromId("functions.read1")).toBe("read");
    expect(extractToolNameFromId("functions.write1")).toBe("write");
    expect(extractToolNameFromId("functions.exec2")).toBe("exec");
  });

  it("should extract tool name from format without any separator", () => {
    expect(extractToolNameFromId("functionsread3")).toBe("read");
    expect(extractToolNameFromId("functionswrite4")).toBe("write");
    expect(extractToolNameFromId("functionsread0")).toBe("read");
  });

  it("should handle toolCall_ prefix", () => {
    // Note: trailing digits are currently stripped due to existing regex behavior
    expect(extractToolNameFromId("toolCall_abc123")).toBe("abc");
    expect(extractToolNameFromId("toolCall_read0")).toBe("read");
  });

  it("should handle toolUse_ prefix", () => {
    expect(extractToolNameFromId("toolUse_write1")).toBe("write");
  });

  it("should handle functionCall_ prefix", () => {
    expect(extractToolNameFromId("functionCall_exec2")).toBe("exec");
  });

  it("should handle empty or invalid input", () => {
    expect(extractToolNameFromId("")).toBeUndefined();
    expect(extractToolNameFromId("   ")).toBeUndefined();
    expect(extractToolNameFromId(undefined as unknown as string)).toBeUndefined();
    expect(extractToolNameFromId(null as unknown as string)).toBeUndefined();
  });
});

describe("PendingToolCallState", () => {
  let state: PendingToolCallState;

  beforeEach(() => {
    state = createPendingToolCallState();
  });

  describe("getToolName", () => {
    it("should return stored name for exact match", () => {
      state.trackToolCalls([{ id: "functions.read:0", name: "read" }]);
      expect(state.getToolName("functions.read:0")).toBe("read");
    });

    it("should return undefined for non-existent ID", () => {
      expect(state.getToolName("nonexistent")).toBeUndefined();
    });

    it("should handle format without colon when stored with colon (fuzzy match)", () => {
      // Stored: functions.read:0, lookup: functions.read1
      state.trackToolCalls([{ id: "functions.read:0", name: "read" }]);
      expect(state.getToolName("functions.read1")).toBe("read");
    });

    it("should handle format without separator when stored with separator", () => {
      // Stored: functions.read:0, lookup: functionsread3
      state.trackToolCalls([{ id: "functions.read:0", name: "read" }]);
      expect(state.getToolName("functionsread3")).toBe("read");
    });

    it("should handle format with only prefix, no separator or index", () => {
      // Stored: functions.write:1, lookup: functionswrite4
      state.trackToolCalls([{ id: "functions.write:1", name: "write" }]);
      expect(state.getToolName("functionswrite4")).toBe("write");
    });

    it("should derive tool name from stored ID when stored name is undefined", () => {
      // This is the key bug fix: when name is undefined but ID contains tool name
      state.trackToolCalls([{ id: "functions.read:0" }]); // no name provided
      expect(state.getToolName("functionsread3")).toBe("read");
    });

    it("should derive tool name from stored ID when stored ID has different format", () => {
      // Stored with name that differs from what comes back
      state.trackToolCalls([{ id: "functions.exec:2", name: "exec" }]);
      // Lookup with completely different format
      expect(state.getToolName("functionsExec5")).toBe("exec");
    });

    it("should handle toolCall_ prefix format", () => {
      state.trackToolCalls([{ id: "toolCall_abc123", name: "abc123" }]);
      expect(state.getToolName("toolcall_abc123")).toBe("abc123");
    });
  });

  describe("delete", () => {
    it("should delete by exact match", () => {
      state.trackToolCalls([{ id: "functions.read:0", name: "read" }]);
      expect(state.size()).toBe(1);
      state.delete("functions.read:0");
      expect(state.size()).toBe(0);
    });

    it("should delete by fuzzy match", () => {
      state.trackToolCalls([{ id: "functions.read:0", name: "read" }]);
      expect(state.size()).toBe(1);
      state.delete("functionsread3");
      expect(state.size()).toBe(0);
    });

    it("should delete when stored name is undefined but ID contains tool name", () => {
      state.trackToolCalls([{ id: "functions.read:0" }]); // no name
      expect(state.size()).toBe(1);
      state.delete("functionsread3");
      expect(state.size()).toBe(0);
    });
  });

  describe("getPendingIds", () => {
    it("should return all pending IDs", () => {
      state.trackToolCalls([
        { id: "functions.read:0", name: "read" },
        { id: "functions.write:1", name: "write" },
      ]);
      const ids = state.getPendingIds();
      expect(ids).toContain("functions.read:0");
      expect(ids).toContain("functions.write:1");
    });
  });

  describe("shouldFlushForSanitizedDrop", () => {
    it("should return false when no pending calls", () => {
      expect(state.shouldFlushForSanitizedDrop()).toBe(false);
    });

    it("should return true when there are pending calls", () => {
      state.trackToolCalls([{ id: "functions.read:0" }]);
      expect(state.shouldFlushForSanitizedDrop()).toBe(true);
    });
  });
});
