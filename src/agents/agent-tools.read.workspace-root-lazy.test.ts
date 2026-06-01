import { describe, expect, it, vi } from "vitest";

// Regression guard: doctor's active-tool schema projection constructs the full
// coding toolset to inspect tool input schemas. Workspace-scoped edit/write
// tools used to resolve their fs-safe root eagerly at construction. When the
// agent's workspace dir does not exist yet (e.g. an unresolved `${ENV}`
// placeholder in the authored config), that orphaned a rejecting promise:
//   "[openclaw] Unhandled promise rejection: FsSafeError: root dir not found"
// The root must only be opened when a read/write/access operation actually runs.

const rootSpy = vi.hoisted(() => vi.fn());

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return { ...actual, root: rootSpy };
});

const { createHostWorkspaceEditTool, createHostWorkspaceWriteTool } =
  await import("./agent-tools.read.js");

describe("workspace-scoped coding tools resolve their fs root lazily", () => {
  it("does not open the fs-safe root while only constructing the tool", () => {
    // Resolve to a stub root handle so a lazy call would not reject, yet assert
    // construction never reaches it.
    rootSpy.mockReset().mockResolvedValue({
      read: vi.fn(),
      write: vi.fn(),
      open: vi.fn(),
    });
    const missingWorkspace = "/openclaw-nonexistent-workspace-zzz/does/not/exist";

    createHostWorkspaceEditTool(missingWorkspace, { workspaceOnly: true });
    createHostWorkspaceWriteTool(missingWorkspace, { workspaceOnly: true });

    expect(rootSpy).not.toHaveBeenCalled();
  });
});
