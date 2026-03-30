import { describe, expect, it, vi } from "vitest";
import {
  assertRequiredParams,
  CLAUDE_PARAM_GROUPS,
  normalizeToolParams,
  wrapToolParamNormalization,
} from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("edit tool edits[] multi-edit mode param validation", () => {
  describe("assertRequiredParams with CLAUDE_PARAM_GROUPS.edit", () => {
    it("rejects when top-level oldText/newText are missing and no edits[] present", () => {
      expect(() =>
        assertRequiredParams({ path: "/tmp/test.txt" }, CLAUDE_PARAM_GROUPS.edit, "edit"),
      ).toThrow(/Missing required parameters: oldText alias, newText alias/);
    });

    it("accepts top-level oldText/newText (single-edit mode)", () => {
      expect(() =>
        assertRequiredParams(
          { path: "/tmp/test.txt", oldText: "before", newText: "after" },
          CLAUDE_PARAM_GROUPS.edit,
          "edit",
        ),
      ).not.toThrow();
    });

    it("accepts top-level oldText with empty newText for deletion", () => {
      expect(() =>
        assertRequiredParams(
          { path: "/tmp/test.txt", oldText: "delete me", newText: "" },
          CLAUDE_PARAM_GROUPS.edit,
          "edit",
        ),
      ).not.toThrow();
    });
  });

  describe("wrapToolParamNormalization with edits[] mode", () => {
    function createMockEditTool(executeMock?: AnyAgentTool["execute"]): AnyAgentTool {
      return {
        name: "edit",
        description: "mock edit tool",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            edits: { type: "array" },
          },
        },
        execute:
          executeMock ??
          (async () => ({
            content: [{ type: "text" as const, text: "ok" }],
          })),
      } as unknown as AnyAgentTool;
    }

    it("accepts edits[] array mode without top-level oldText/newText", async () => {
      const executeMock = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const tool = wrapToolParamNormalization(
        createMockEditTool(executeMock as unknown as AnyAgentTool["execute"]),
        CLAUDE_PARAM_GROUPS.edit,
      );

      const params = {
        path: "/tmp/test.txt",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      };

      await expect(tool.execute("call-1", params, undefined)).resolves.not.toThrow();
      expect(executeMock).toHaveBeenCalledOnce();
    });

    it("still requires path even in edits[] mode", async () => {
      const tool = wrapToolParamNormalization(createMockEditTool(), CLAUDE_PARAM_GROUPS.edit);

      const params = {
        edits: [{ oldText: "alpha", newText: "ALPHA" }],
      };

      await expect(tool.execute("call-1", params, undefined)).rejects.toThrow(
        /Missing required parameter.*: path alias/,
      );
    });

    it("rejects empty edits[] array (falls back to top-level validation)", async () => {
      const tool = wrapToolParamNormalization(createMockEditTool(), CLAUDE_PARAM_GROUPS.edit);

      const params = {
        path: "/tmp/test.txt",
        edits: [],
      };

      // Empty edits[] is not valid multi-edit mode, so it falls through
      // to the top-level validation which requires oldText/newText
      await expect(tool.execute("call-1", params, undefined)).rejects.toThrow(
        /Missing required parameters: oldText alias, newText alias/,
      );
    });

    it("still validates top-level single-edit mode correctly", async () => {
      const executeMock = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const tool = wrapToolParamNormalization(
        createMockEditTool(executeMock as unknown as AnyAgentTool["execute"]),
        CLAUDE_PARAM_GROUPS.edit,
      );

      // Single-edit mode with top-level oldText/newText
      const params = {
        path: "/tmp/test.txt",
        oldText: "before",
        newText: "after",
      };

      await expect(tool.execute("call-1", params, undefined)).resolves.not.toThrow();
      expect(executeMock).toHaveBeenCalledOnce();
    });

    it("accepts edits[] with Claude-style aliases (old_string/new_string)", async () => {
      const executeMock = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const tool = wrapToolParamNormalization(
        createMockEditTool(executeMock as unknown as AnyAgentTool["execute"]),
        CLAUDE_PARAM_GROUPS.edit,
      );

      // Claude Code style: file_path + edits array
      const params = {
        file_path: "/tmp/test.txt",
        edits: [{ old_string: "alpha", new_string: "ALPHA" }],
      };

      await expect(tool.execute("call-1", params, undefined)).resolves.not.toThrow();
      expect(executeMock).toHaveBeenCalledOnce();
    });

    it("does not apply edits[] bypass to non-edit tools", async () => {
      const writeTool = {
        name: "write",
        description: "mock write tool",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
        execute: async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }),
      } as unknown as AnyAgentTool;

      const tool = wrapToolParamNormalization(writeTool, CLAUDE_PARAM_GROUPS.write);

      // Even with an edits[] property, the write tool should still check its own params
      const params = {
        path: "/tmp/test.txt",
        edits: [{ oldText: "a", newText: "b" }],
      };

      await expect(tool.execute("call-1", params, undefined)).rejects.toThrow(
        /Missing required parameter.*: content/,
      );
    });

    it("normalizes edits[] params correctly for the upstream tool", async () => {
      let receivedParams: unknown;
      const executeMock = vi.fn(async (_toolCallId: string, params: unknown) => {
        receivedParams = params;
        return { content: [{ type: "text" as const, text: "ok" }] };
      });
      const tool = wrapToolParamNormalization(
        createMockEditTool(executeMock as unknown as AnyAgentTool["execute"]),
        CLAUDE_PARAM_GROUPS.edit,
      );

      const params = {
        file_path: "/tmp/test.txt",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      };

      await tool.execute("call-1", params, undefined);
      expect(executeMock).toHaveBeenCalledOnce();

      // After normalization, file_path should be mapped to path
      const normalized = receivedParams as Record<string, unknown>;
      expect(normalized.path).toBe("/tmp/test.txt");
      expect(normalized.edits).toEqual([
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "gamma", newText: "GAMMA" },
      ]);
    });
  });

  describe("normalizeToolParams with edits[] mode", () => {
    it("normalizes Claude aliases in top-level but preserves edits[] array", () => {
      const result = normalizeToolParams({
        file_path: "/tmp/test.txt",
        edits: [
          { oldText: "alpha", newText: "ALPHA" },
          { oldText: "gamma", newText: "GAMMA" },
        ],
      });

      expect(result).toBeDefined();
      expect(result!.path).toBe("/tmp/test.txt");
      expect(result!.edits).toEqual([
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "gamma", newText: "GAMMA" },
      ]);
      // Alias should be removed
      expect(result!.file_path).toBeUndefined();
    });
  });
});
