import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const execFileMock = vi.fn();
  return { execFileMock };
});

vi.mock("node:child_process", () => ({
  execFile: hoisted.execFileMock,
}));

// Must import after vi.mock so the mock is in place.
const { verifyAcpWorktreeDiff } = await import("./acp-verification-gate.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyAcpWorktreeDiff", () => {
  it("returns hasChanges: true when git diff --stat produces output", async () => {
    hoisted.execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, { stdout: " src/foo.ts | 3 +++\n 1 file changed, 3 insertions(+)\n" });
      },
    );

    const result = await verifyAcpWorktreeDiff("/tmp/test-worktree");

    expect(result.hasChanges).toBe(true);
    expect(result.stat).toContain("src/foo.ts");
    expect(hoisted.execFileMock).toHaveBeenCalledWith(
      "git",
      ["diff", "--stat", "HEAD"],
      expect.objectContaining({ cwd: "/tmp/test-worktree", timeout: 10_000 }),
      expect.any(Function),
    );
  });

  it("returns hasChanges: false when git diff --stat produces empty output", async () => {
    hoisted.execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, { stdout: "" });
      },
    );

    const result = await verifyAcpWorktreeDiff("/tmp/clean-worktree");

    expect(result.hasChanges).toBe(false);
    expect(result.stat).toBe("");
  });

  it("returns hasChanges: false (fail-closed) when git command fails", async () => {
    hoisted.execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error("fatal: not a git repository"));
      },
    );

    const result = await verifyAcpWorktreeDiff("/tmp/not-a-repo");

    expect(result.hasChanges).toBe(false);
    expect(result.stat).toBe("");
  });

  it("returns hasChanges: false when whitespace-only output is returned", async () => {
    hoisted.execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, { stdout: "   \n  \n" });
      },
    );

    const result = await verifyAcpWorktreeDiff("/tmp/whitespace-worktree");

    expect(result.hasChanges).toBe(false);
    expect(result.stat).toBe("");
  });
});
