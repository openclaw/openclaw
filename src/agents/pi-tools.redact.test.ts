import { describe, expect, it, vi } from "vitest";
import { redactToolResult, wrapToolWithResultRedaction } from "./pi-tools.redact.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("redactToolResult", () => {
  it("redacts nested sensitive strings", () => {
    const secret = "Bearer testtok_abcdefghijklmnopqrstuvwxyz1234";
    const input = {
      content: [{ type: "text", text: `token=${secret}` }],
      details: { nested: { token: secret } },
    };
    const output = redactToolResult(input);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("…");
  });
});

describe("wrapToolWithResultRedaction", () => {
  it("redacts execute results and partial updates", async () => {
    const secret = "Bearer testtok_abcdefghijklmnopqrstuvwxyz1234";
    const updates: unknown[] = [];
    const baseTool = {
      name: "test_tool",
      label: "test_tool",
      description: "test",
      parameters: { type: "object", properties: {} },
      execute: async (
        _toolCallId: string,
        _params: unknown,
        _signal?: AbortSignal,
        onUpdate?: (partial: unknown) => void,
      ) => {
        onUpdate?.({
          content: [{ type: "text", text: `update secret=${secret}` }],
          details: { raw: secret },
        });
        return {
          content: [{ type: "text", text: `result secret=${secret}` }],
          details: { token: secret },
        };
      },
    } as unknown as AnyAgentTool;

    const wrapped = wrapToolWithResultRedaction(baseTool);
    const result = await wrapped.execute?.("call_1", {}, undefined, (partial) => {
      updates.push(partial);
    });

    const updatesSerialized = JSON.stringify(updates);
    const resultSerialized = JSON.stringify(result);
    expect(updatesSerialized).not.toContain(secret);
    expect(resultSerialized).not.toContain(secret);
    expect(updatesSerialized).toContain("…");
    expect(resultSerialized).toContain("…");
  });

  it("passes through tools without execute", () => {
    const tool = { name: "noop" } as unknown as AnyAgentTool;
    const wrapped = wrapToolWithResultRedaction(tool);
    expect(wrapped).toBe(tool);
  });

  it("keeps execute behavior shape intact", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      details: { attempts: 1 },
    });
    const tool = {
      name: "echo",
      label: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      execute,
    } as unknown as AnyAgentTool;
    const wrapped = wrapToolWithResultRedaction(tool);
    const result = await wrapped.execute?.("call_2", { foo: "bar" }, undefined, undefined);
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      details: { attempts: 1 },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
