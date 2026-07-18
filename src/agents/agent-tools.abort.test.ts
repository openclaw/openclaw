import { describe, expect, it } from "vitest";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

describe("wrapToolWithAbortSignal", () => {
  it("returns promptly on run abort while a non-cooperative tool settles later", async () => {
    const abort = new AbortController();
    let resolveTool: (() => void) | undefined;
    let receivedSignal: AbortSignal | undefined;
    const tool = {
      name: "slow-tool",
      description: "waits until released",
      parameters: {},
      execute: async (_toolCallId: string, _params: unknown, signal?: AbortSignal) => {
        receivedSignal = signal;
        await new Promise<void>((resolve) => {
          resolveTool = resolve;
        });
        return { content: [] };
      },
    } as unknown as AnyAgentTool;
    const execute = wrapToolWithAbortSignal(tool, abort.signal).execute;
    if (!execute) {
      throw new Error("Expected wrapped tool execute function");
    }

    const result = execute("tool-call", {}, undefined, undefined);
    abort.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
    expect(receivedSignal?.aborted).toBe(true);

    resolveTool?.();
  });
});
