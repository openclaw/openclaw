import { describe, expect, it, vi } from "vitest";
import type { McpLoopbackClientGrantCloseReason } from "../../gateway/mcp-grant-store.js";
import { releasePreparedCliBackend } from "./backend-release.js";
import type { PreparedCliRunContext } from "./types.js";

describe("releasePreparedCliBackend", () => {
  const params = { runId: "run-1", sessionId: "session-1", oneShotCliRun: false } as const;
  const result = (meta: { aborted?: boolean; stopReason?: string }) => ({
    meta: { durationMs: 1, ...meta },
  });

  async function release(input: {
    runFailed: boolean;
    runError: unknown;
    runResult?: ReturnType<typeof result>;
    abortSignal?: AbortSignal;
  }): Promise<McpLoopbackClientGrantCloseReason | undefined> {
    const cleanup = vi.fn(async (_outcome: McpLoopbackClientGrantCloseReason) => {});
    const context = { preparedBackend: { cleanup } } as unknown as PreparedCliRunContext;
    const cleanupError = await releasePreparedCliBackend({
      context,
      params: { ...params, abortSignal: input.abortSignal },
      runFailed: input.runFailed,
      runError: input.runError,
      runResult: input.runResult,
    });
    expect(cleanupError).toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
    return cleanup.mock.calls[0]?.[0];
  }

  it("closes with completion only for a run that returned a settled result", async () => {
    expect(await release({ runFailed: false, runError: undefined })).toBe("completion");
    expect(
      await release({
        runFailed: false,
        runError: undefined,
        runResult: result({ stopReason: "end_turn" }),
      }),
    ).toBe("completion");
  });

  it.each([
    { name: "aborted meta", meta: { aborted: true }, outcome: "cancel" },
    { name: "aborted stop reason", meta: { stopReason: "aborted" }, outcome: "cancel" },
    { name: "timeout stop reason", meta: { stopReason: "timeout" }, outcome: "timeout" },
    { name: "delivered failure", meta: { stopReason: "error" }, outcome: "error" },
    { name: "blocked run", meta: { stopReason: "blocked" }, outcome: "error" },
  ] as const)("treats a delivered but interrupted result as $name", async ({ meta, outcome }) => {
    expect(await release({ runFailed: false, runError: undefined, runResult: result(meta) })).toBe(
      outcome,
    );
  });

  it("classifies thrown failures by abort, timeout, and everything else", async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await release({
        runFailed: true,
        runError: new Error("stopped"),
        abortSignal: aborted.signal,
      }),
    ).toBe("cancel");
    expect(
      await release({
        runFailed: true,
        runError: Object.assign(new Error("slow"), { reason: "timeout" }),
      }),
    ).toBe("timeout");
    expect(await release({ runFailed: true, runError: new Error("boom") })).toBe("error");
  });

  it("returns the cleanup failure instead of throwing", async () => {
    const context = {
      preparedBackend: {
        cleanup: vi.fn(async () => {
          throw new Error("close failed");
        }),
      },
    } as unknown as PreparedCliRunContext;
    const cleanupError = await releasePreparedCliBackend({
      context,
      params,
      runFailed: false,
      runError: undefined,
    });
    expect(cleanupError?.message).toBe("close failed");
  });
});
