import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { loadConfig } from "../config/config.js";
import {
  createStructuredStateInjectionMessage,
  formatStructuredStateForContext,
  isStructuredStateEnabled,
  readStructuredState,
  resolveStructuredStateFilePath,
} from "./structured-state.js";

const mockLoadConfig = vi.mocked(loadConfig);

describe("structured-state", () => {
  const testDir = "/tmp/test-workspace";

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolveStructuredStateFilePath", () => {
    it("returns undefined when workspaceDir is not provided", () => {
      expect(resolveStructuredStateFilePath(undefined)).toBeUndefined();
    });

    it("uses default filename when not configured", () => {
      mockLoadConfig.mockReturnValue({});
      const result = resolveStructuredStateFilePath(testDir);
      expect(result).toBe(path.resolve(testDir, "structured_state.json"));
    });

    it("uses configured filename", () => {
      mockLoadConfig.mockReturnValue({
        agents: {
          defaults: {
            compaction: {
              structuredStateFile: "my-state.json",
            },
          },
        },
      });
      const result = resolveStructuredStateFilePath(testDir);
      expect(result).toBe(path.resolve(testDir, "my-state.json"));
    });

    it("handles absolute paths", () => {
      mockLoadConfig.mockReturnValue({
        agents: {
          defaults: {
            compaction: {
              structuredStateFile: "/absolute/path/state.json",
            },
          },
        },
      });
      const result = resolveStructuredStateFilePath(testDir);
      expect(result).toBe("/absolute/path/state.json");
    });
  });

  describe("readStructuredState", () => {
    it("returns error when file not found", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);

      const result = readStructuredState(testDir);
      expect(result.success).toBe(false);
      expect(result.error).toBe("File not found");
    });

    it("reads and parses valid JSON file", () => {
      const testData = { key: "value", count: 42 };
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(testData));

      const result = readStructuredState(testDir);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(testData);
    });

    it("returns error for invalid JSON", () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue("{ invalid json }");

      const result = readStructuredState(testDir);
      expect(result.success).toBe(false);
      // JSON parse errors vary by Node.js version, just check that there's an error
      expect(result.error).toBeTruthy();
      expect(result.error!.length).toBeGreaterThan(0);
    });

    it("returns error when structured state not configured", () => {
      const result = readStructuredState(undefined);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Structured state file not configured");
    });
  });

  describe("formatStructuredStateForContext", () => {
    it("formats data as markdown with JSON code block", () => {
      const data = { task: "test", priority: 1 };
      const result = formatStructuredStateForContext(data);

      expect(result).toContain("## Preserved Structured State");
      expect(result).toContain("```json");
      expect(result).toContain('"task": "test"');
      expect(result).toContain('"priority": 1');
      expect(result).toContain("```");
    });

    it("handles nested objects", () => {
      const data = { nested: { deep: { value: "found" } } };
      const result = formatStructuredStateForContext(data);

      expect(result).toContain('"nested"');
      expect(result).toContain('"deep"');
      expect(result).toContain('"value": "found"');
    });

    it("handles arrays", () => {
      const data = { items: [1, 2, 3] };
      const result = formatStructuredStateForContext(data);

      expect(result).toContain('"items"');
      expect(result).toContain("[");
      expect(result).toContain("1");
      expect(result).toContain("2");
      expect(result).toContain("3");
    });
  });

  describe("createStructuredStateInjectionMessage", () => {
    it("creates a user message with formatted state", () => {
      const data = { key: "value" };
      const message = createStructuredStateInjectionMessage(data);

      expect(message.role).toBe("user");
      expect(message.content).toContain("[SYSTEM: Structured state preserved from compaction]");
      expect(message.content).toContain('"key": "value"');
      expect(typeof message.timestamp).toBe("number");
    });

    it("includes timestamp close to now", () => {
      const before = Date.now();
      const message = createStructuredStateInjectionMessage({});
      const after = Date.now();

      expect(message.timestamp).toBeGreaterThanOrEqual(before);
      expect(message.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe("isStructuredStateEnabled", () => {
    it("returns false when not configured", () => {
      mockLoadConfig.mockReturnValue({});
      expect(isStructuredStateEnabled()).toBe(false);
    });

    it("returns false when empty string", () => {
      mockLoadConfig.mockReturnValue({
        agents: {
          defaults: {
            compaction: {
              structuredStateFile: "",
            },
          },
        },
      });
      expect(isStructuredStateEnabled()).toBe(false);
    });

    it("returns true when configured", () => {
      mockLoadConfig.mockReturnValue({
        agents: {
          defaults: {
            compaction: {
              structuredStateFile: "state.json",
            },
          },
        },
      });
      expect(isStructuredStateEnabled()).toBe(true);
    });
  });
});
