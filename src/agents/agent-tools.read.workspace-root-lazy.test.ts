import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const rootSpy = vi.hoisted(() => vi.fn());

type WorkspaceFileOps = {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
};
const captured = vi.hoisted(() => ({
  write: undefined as WorkspaceFileOps | undefined,
  edit: undefined as WorkspaceFileOps | undefined,
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return { ...actual, root: rootSpy };
});

vi.mock("./sessions/tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sessions/tools/index.js")>();
  const stub = (name: string) => ({
    name,
    description: `test ${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  });
  return {
    ...actual,
    createWriteTool: (_cwd: string, options?: { operations?: WorkspaceFileOps }) => {
      captured.write = options?.operations;
      return stub("write");
    },
    createEditTool: (_cwd: string, options?: { operations?: WorkspaceFileOps }) => {
      captured.edit = options?.operations;
      return stub("edit");
    },
  };
});

const { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } =
  await import("./agent-tools.read.js");

function requireOps(ops: WorkspaceFileOps | undefined, label: string): WorkspaceFileOps {
  if (!ops) {
    throw new Error(`expected captured ${label} operations`);
  }
  return ops;
}

describe("workspace-scoped coding tools resolve their fs root lazily", () => {
  it("does not orphan a rejecting fs-safe root when a write/edit targets a missing root", async () => {
    rootSpy.mockReset().mockRejectedValue(new Error("root dir not found"));
    const missingWorkspace = "/openclaw-nonexistent-workspace-zzz/does/not/exist";
    const missingFile = path.join(missingWorkspace, "out.txt");

    createHostWorkspaceWriteTool(missingWorkspace, { workspaceOnly: true });
    createHostWorkspaceEditTool(missingWorkspace, { workspaceOnly: true });
    const writeOps = requireOps(captured.write, "write");
    const editOps = requireOps(captured.edit, "edit");

    expect(rootSpy).not.toHaveBeenCalled();
    await expect(writeOps.writeFile(missingFile, "x")).rejects.toThrow("root dir not found");
    await expect(editOps.writeFile(missingFile, "x")).rejects.toThrow("root dir not found");
    expect(rootSpy).toHaveBeenCalledTimes(2);
  });
});
