import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import {
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
} from "./pi-tools.params.js";
import { cleanToolSchemaForGemini } from "./pi-tools.schema.js";

describe("createOpenClawCodingTools", () => {
  describe("Claude/Gemini alias support", () => {
    it("adds Claude-style aliases to schemas without dropping metadata", () => {
      const base: AgentTool = {
        name: "write",
        label: "write",
        description: "test",
        parameters: Type.Object({
          path: Type.String({ description: "Path" }),
          content: Type.String({ description: "Body" }),
        }),
        execute: vi.fn(),
      };

      const patched = patchToolSchemaForClaudeCompatibility(base);
      const params = patched.parameters as {
        additionalProperties?: unknown;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const props = params.properties ?? {};

      expect(props.file_path).toEqual(props.path);
      expect(params.additionalProperties).toBe(false);
      expect(params.required ?? []).not.toContain("path");
      expect(params.required ?? []).not.toContain("file_path");
    });

    it("normalizes file_path to path and enforces required groups at runtime", async () => {
      const execute = vi.fn(async (_id, args) => args);
      const tool: AgentTool = {
        name: "write",
        label: "write",
        description: "test",
        parameters: Type.Object({
          path: Type.String(),
          content: Type.String(),
        }),
        execute,
      };

      const wrapped = wrapToolParamNormalization(tool, [
        { keys: ["path", "file_path"], label: "path (path or file_path)" },
        { keys: ["content"], label: "content" },
      ]);

      await wrapped.execute("tool-1", { file_path: "foo.txt", content: "x" });
      expect(execute).toHaveBeenCalledWith(
        "tool-1",
        { path: "foo.txt", content: "x" },
        undefined,
        undefined,
      );

      await expect(wrapped.execute("tool-2", { content: "x" })).rejects.toThrow(
        /Missing required parameter/,
      );
      await expect(wrapped.execute("tool-2", { content: "x" })).rejects.toThrow(
        /Supply correct parameters before retrying\./,
      );
      await expect(wrapped.execute("tool-3", { file_path: "   ", content: "x" })).rejects.toThrow(
        /Missing required parameter/,
      );
      await expect(wrapped.execute("tool-3", { file_path: "   ", content: "x" })).rejects.toThrow(
        /Supply correct parameters before retrying\./,
      );
      await expect(wrapped.execute("tool-4", {})).rejects.toThrow(
        /Missing required parameters: path \(path or file_path\), content/,
      );
      await expect(wrapped.execute("tool-4", {})).rejects.toThrow(
        /Supply correct parameters before retrying\./,
      );
    });
  });

  it("inlines local $ref before removing unsupported keywords", () => {
    const cleaned = cleanToolSchemaForGemini({
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/Foo" },
      },
      $defs: {
        Foo: { type: "string", enum: ["a", "b"] },
      },
    }) as {
      $defs?: unknown;
      properties?: Record<string, unknown>;
    };

    expect(cleaned.$defs).toBeUndefined();
    expect(cleaned.properties).toBeDefined();
    expect(cleaned.properties?.foo).toMatchObject({
      type: "string",
      enum: ["a", "b"],
    });
  });

  it("cleans tuple items schemas", () => {
    const cleaned = cleanToolSchemaForGemini({
      type: "object",
      properties: {
        tuples: {
          type: "array",
          items: [
            { type: "string", format: "uuid" },
            { type: "number", minimum: 1 },
          ],
        },
      },
    }) as {
      properties?: Record<string, unknown>;
    };

    const tuples = cleaned.properties?.tuples as { items?: unknown } | undefined;
    const items = Array.isArray(tuples?.items) ? tuples?.items : [];
    const first = items[0] as { format?: unknown } | undefined;
    const second = items[1] as { minimum?: unknown } | undefined;

    expect(first?.format).toBeUndefined();
    expect(second?.minimum).toBeUndefined();
  });

  it("drops null-only union variants without flattening other unions", () => {
    const cleaned = cleanToolSchemaForGemini({
      type: "object",
      properties: {
        parentId: { anyOf: [{ type: "string" }, { type: "null" }] },
        count: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
    }) as {
      properties?: Record<string, unknown>;
    };

    const parentId = cleaned.properties?.parentId as
      | { type?: unknown; anyOf?: unknown; oneOf?: unknown }
      | undefined;
    const count = cleaned.properties?.count as
      | { type?: unknown; anyOf?: unknown; oneOf?: unknown }
      | undefined;

    expect(parentId?.type).toBe("string");
    expect(parentId?.anyOf).toBeUndefined();
    expect(count?.oneOf).toBeUndefined();
  });
});
