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

  it("locks each apply_patch target file using absolute workspace paths", async () => {
    withWorkspaceLockMock.mockClear();
    const { wrapApplyPatchMutationLock } = await import("./pi-tools.read.js");

    const wrapped = wrapApplyPatchMutationLock(
      {
        name: "apply_patch",
        label: "apply_patch",
        description: "apply_patch",
        parameters: {},
        execute: async (): Promise<AgentToolResult<unknown>> => ({
          content: [{ type: "text", text: "ok" }],
          details: undefined,
        }),
      },
      "/tmp/workspace",
    );

    await wrapped.execute("call-2", {
      input:
        "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+export {}\n*** End Patch",
    });

    expect(withWorkspaceLockMock).toHaveBeenCalledTimes(2);
    expect(withWorkspaceLockMock.mock.calls[0]?.[0]).toBe("/tmp/workspace/src/a.ts");
    expect(withWorkspaceLockMock.mock.calls[0]?.[1]).toMatchObject({ kind: "file" });
    expect(withWorkspaceLockMock.mock.calls[1]?.[0]).toBe("/tmp/workspace/src/b.ts");
    expect(withWorkspaceLockMock.mock.calls[1]?.[1]).toMatchObject({ kind: "file" });
  });
});
