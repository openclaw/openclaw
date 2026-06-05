import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

function createPoisonedTool(): AnyAgentTool & { poison?: unknown } {
  const tool: AnyAgentTool & { poison?: unknown } = {
    name: "safe_tool",
    label: "Safe Tool",
    description: "A healthy tool with one hostile non-contract field.",
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: { ok: true },
    })),
  };
  Object.defineProperty(tool, "poison", {
    enumerable: true,
    get() {
      throw new Error("non-contract tool field getter exploded");
    },
  });
  return tool;
}

describe("agent tool wrappers", () => {
  it("does not read non-contract tool fields when adding before-tool-call hooks", () => {
    const wrapped = wrapToolWithBeforeToolCallHook(createPoisonedTool());

    expect(wrapped.name).toBe("safe_tool");
    expect(wrapped.description).toBe("A healthy tool with one hostile non-contract field.");
  });

  it("does not read non-contract tool fields when adding abort signals", async () => {
    const wrapped = wrapToolWithAbortSignal(createPoisonedTool(), new AbortController().signal);

    await expect(wrapped.execute("call-1", {})).resolves.toMatchObject({
      details: { ok: true },
    });
  });

  it("ignores unreadable optional wrapper metadata", () => {
    const tool = createPoisonedTool();
    Object.defineProperty(tool, "displaySummary", {
      enumerable: true,
      get() {
        throw new Error("display summary getter exploded");
      },
    });

    const wrapped = wrapToolWithAbortSignal(tool, new AbortController().signal);

    expect(wrapped.displaySummary).toBeUndefined();
    expect(wrapped.name).toBe("safe_tool");
  });
});
