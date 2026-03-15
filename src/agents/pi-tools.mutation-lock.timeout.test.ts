import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

const withWorkspaceLockMock = vi.fn(
  async (_path: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
);

vi.mock("../infra/workspace-lock-manager.js", () => ({
  withWorkspaceLock: withWorkspaceLockMock,
}));

describe("wrapToolMutationLock timeout policy", () => {
  it("uses contention-safe timeout for shared workspace mutation locks", async () => {
    const { wrapToolMutationLock } = await import("./pi-tools.read.js");

    const wrapped = wrapToolMutationLock(
      {
        name: "write",
        label: "write",
        description: "write",
        parameters: {},
        execute: async (): Promise<AgentToolResult<unknown>> => ({
          content: [{ type: "text", text: "ok" }],
          details: undefined,
        }),
      },
      process.cwd(),
    );

    await wrapped.execute("call-1", { path: "same.txt", content: "x" });

    expect(withWorkspaceLockMock).toHaveBeenCalled();
    const [, options] = withWorkspaceLockMock.mock.calls[0] as [
      string,
      { timeoutMs?: number },
      () => Promise<unknown>,
    ];
    expect(options.timeoutMs).toBeGreaterThanOrEqual(60_000);
  });
});
