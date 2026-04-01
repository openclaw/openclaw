import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { normalizeToolParams, wrapToolParamNormalization } from "./pi-tools.params.js";

function createEditTool(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "edit",
    label: "edit",
    description: "test edit",
    parameters: Type.Object({
      path: Type.String(),
      oldText: Type.Optional(Type.String()),
      newText: Type.Optional(Type.String()),
      edits: Type.Optional(
        Type.Array(
          Type.Object({
            oldText: Type.String(),
            newText: Type.String(),
          }),
        ),
      ),
    }),
    execute,
  };
}

describe("pi-tools edit param normalization", () => {
  it("prefers edits mode when mixed single-replacement fields are present", () => {
    const normalized = normalizeToolParams({
      file_path: "demo.txt",
      old_string: "legacy-old",
      new_string: "legacy-new",
      edits: [
        {
          old_string: "one",
          new_string: "two",
        },
      ],
    });

    expect(normalized).toEqual({
      path: "demo.txt",
      edits: [{ oldText: "one", newText: "two" }],
    });
  });

  it("drops empty edits arrays when single replacement mode is otherwise valid", () => {
    const normalized = normalizeToolParams({
      path: "demo.txt",
      oldText: "before",
      newText: "",
      edits: [],
    });

    expect(normalized).toEqual({
      path: "demo.txt",
      oldText: "before",
      newText: "",
    });
  });

  it("allows edits-only mode through the wrapped edit tool", async () => {
    const execute = vi.fn(async (_toolCallId, args) => args);
    const wrapped = wrapToolParamNormalization(createEditTool(execute));

    await wrapped.execute("tool-1", {
      file_path: "demo.txt",
      edits: [
        {
          old_string: "before",
          new_string: "after",
        },
      ],
    });

    expect(execute).toHaveBeenCalledWith(
      "tool-1",
      {
        path: "demo.txt",
        edits: [{ oldText: "before", newText: "after" }],
      },
      undefined,
      undefined,
    );
  });

  it("rejects edit calls that provide no replacement payload at all", async () => {
    const execute = vi.fn(async (_toolCallId, args) => args);
    const wrapped = wrapToolParamNormalization(createEditTool(execute));

    await expect(wrapped.execute("tool-2", { path: "demo.txt" })).rejects.toThrow(
      /Missing required parameter: edit payload \(oldText\/newText or edits\)/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
