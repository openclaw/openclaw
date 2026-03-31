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

    it("normalizes Claude-style aliases inside edits[] entries (old_string → oldText)", async () => {
      let receivedParams: unknown;
      const executeMock = vi.fn(async (_toolCallId: string, params: unknown) => {
        receivedParams = params;
        return { content: [{ type: "text" as const, text: "ok" }] };
      });
      const tool = wrapToolParamNormalization(
        createMockEditTool(executeMock as unknown as AnyAgentTool["execute"]),
        CLAUDE_PARAM_GROUPS.edit,
      );

      // Claude Code style: file_path + edits array with old_string/new_string
      const params = {
        file_path: "/tmp/test.txt",
        edits: [{ old_string: "alpha", new_string: "ALPHA" }],
      };

      await expect(tool.execute("call-1", params, undefined)).resolves.not.toThrow();
      expect(executeMock).toHaveBeenCalledOnce();

      // After normalization, aliases inside edits[] should be mapped to canonical keys
      const normalized = receivedParams as Record<string, unknown>;
      expect(normalized.path).toBe("/tmp/test.txt");
      expect(normalized.edits).toEqual([{ oldText: "alpha", newText: "ALPHA" }]);
    });

    it("skips oldText/newText validation in edits[] mode even when labels are renamed", async () => {
      // Regression guard: the filtering must be based on group.keys overlap
      // with the known edit-text key set, NOT on group.label strings.
      // Here we supply custom groups whose labels do NOT mention "oldText"
      // or "newText" — the filter must still recognise them via their keys.
      const customGroups = [
        { keys: ["path", "file_path", "filePath", "file"], label: "file location" },
        { keys: ["oldText", "old_string", "old_text", "oldString"], label: "search text" },
        {
          keys: ["newText", "new_string", "new_text", "newString"],
          label: "replacement text",
          allowEmpty: true,
        },
      ] as const;

      const executeMock = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const tool = wrapToolParamNormalization(
        createMockEditTool(executeMock as unknown as AnyAgentTool["execute"]),
        customGroups,
      );

      // edits[] mode — should NOT require top-level oldText/newText
      const params = {
        path: "/tmp/test.txt",
        edits: [{ oldText: "alpha", newText: "ALPHA" }],
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

    it("normalizes edits[] aliases before bypassing old/new validation (end-to-end)", async () => {
      // Regression guard for the review comment: when edits[] contains only
      // alias keys (old_string / new_string), normalization must rewrite them
      // to canonical keys *before* the params reach the upstream tool.
      // Without the edits[] normalization in normalizeToolParams, the upstream
      // tool would receive { old_string, new_string } and silently fail.
      let receivedParams: unknown;
      const executeMock = vi.fn(async (_toolCallId: string, params: unknown) => {
        receivedParams = params;
        return { content: [{ type: "text" as const, text: "ok" }] };
      });
      const tool = wrapToolParamNormalization(
        createMockEditTool(executeMock as unknown as AnyAgentTool["execute"]),
        CLAUDE_PARAM_GROUPS.edit,
      );

      // Payload with ONLY alias keys — no canonical oldText/newText anywhere.
      const params = {
        file_path: "/tmp/test.txt",
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_text: "gamma", new_text: "GAMMA" },
        ],
      };

      await expect(tool.execute("call-1", params, undefined)).resolves.not.toThrow();
      expect(executeMock).toHaveBeenCalledOnce();

      // The upstream tool must see canonical keys in every edits[] entry.
      const normalized = receivedParams as Record<string, unknown>;
      expect(normalized.path).toBe("/tmp/test.txt");
      expect(normalized.edits).toEqual([
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "gamma", newText: "GAMMA" },
      ]);
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

    it("normalizes Claude-style aliases inside edits[] entries", () => {
      const result = normalizeToolParams({
        file_path: "/tmp/test.txt",
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_text: "gamma", new_text: "GAMMA" },
        ],
      });

      expect(result).toBeDefined();
      expect(result!.path).toBe("/tmp/test.txt");
      expect(result!.edits).toEqual([
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "gamma", newText: "GAMMA" },
      ]);
    });

    it("does not clobber canonical keys in edits[] when aliases are also present", () => {
      const result = normalizeToolParams({
        path: "/tmp/test.txt",
        edits: [
          {
            oldText: "correct",
            old_string: "ignored",
            newText: "also correct",
            new_string: "ignored",
          },
        ],
      });

      expect(result).toBeDefined();
      expect(result!.edits).toEqual([{ oldText: "correct", newText: "also correct" }]);
    });
  });
});
