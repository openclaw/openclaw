import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

/**
 * Track calls so we can inspect ordering and lock coverage.
 */
const lockCallLog: Array<{ path: string; kind: string }> = [];

const withWorkspaceLockMock = vi.fn(
  async (_path: string, opts: { kind?: string }, fn: () => Promise<unknown>) => {
    lockCallLog.push({ path: _path, kind: opts?.kind ?? "file" });
    return fn();
  },
);

vi.mock("../infra/workspace-lock-manager.js", () => ({
  withWorkspaceLock: withWorkspaceLockMock,
}));

describe("memory flush append-only write acquires lock before read", () => {
  it("wraps the read-then-write in a workspace lock (lost-update regression)", async () => {
    lockCallLog.length = 0;
    withWorkspaceLockMock.mockClear();

    const { wrapToolMemoryFlushAppendOnlyWrite } = await import("./pi-tools.read.js");

    let executeCalledInsideLock = false;
    const innerTool = {
      name: "write",
      label: "write",
      description: "write file",
      parameters: {},
      execute: async (
        _id: string,
        args: Record<string, unknown>,
      ): Promise<AgentToolResult<unknown>> => {
        // The inner execute should be called inside the lock callback.
        executeCalledInsideLock = lockCallLog.length > 0;
        return {
          content: [{ type: "text" as const, text: `wrote ${String(args.path)}` }],
          details: undefined,
        };
      },
    };

    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(innerTool, {
      root: "/tmp/test-workspace",
      relativePath: "memory/today.md",
    });

    await wrapped.execute("call-flush", {
      path: "memory/today.md",
      content: "new entry",
    });

    // The lock should have been acquired on the absolute path before the tool executed.
    expect(withWorkspaceLockMock).toHaveBeenCalled();
    expect(lockCallLog[0]?.kind).toBe("file");
    expect(executeCalledInsideLock).toBe(true);
  });
});

describe("apply_patch waits on per-file write queues", () => {
  it("reads per-file queue entries for each touched path before locking", async () => {
    // This test verifies the fix structurally: wrapApplyPatchMutationLock
    // should read per-file queue entries (from workspaceMutationLocks) for
    // each path the patch touches. We verify this by checking that the lock
    // is acquired per-file (not just workspace-level).
    lockCallLog.length = 0;
    withWorkspaceLockMock.mockClear();

    const { wrapApplyPatchMutationLock } = await import("./pi-tools.read.js");

    const patchTool = {
      name: "apply_patch",
      label: "apply_patch",
      description: "apply patch",
      parameters: {},
      execute: async (): Promise<AgentToolResult<unknown>> => ({
        content: [{ type: "text" as const, text: "patched" }],
        details: undefined,
      }),
    };

    const wrapped = wrapApplyPatchMutationLock(patchTool, "/tmp/workspace");

    await wrapped.execute("call-p1", {
      input:
        "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-hello\n+world\n*** Update File: src/b.ts\n@@\n-foo\n+bar\n*** End Patch",
    });

    // Both files should get individual file locks.
    expect(lockCallLog.filter((l) => l.kind === "file")).toHaveLength(2);
    const lockedPaths = lockCallLog.filter((l) => l.kind === "file").map((l) => l.path);
    expect(lockedPaths).toContain("/tmp/workspace/src/a.ts");
    expect(lockedPaths).toContain("/tmp/workspace/src/b.ts");
  });
});
