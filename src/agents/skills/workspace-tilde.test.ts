import { describe, expect, it, vi } from "vitest";

// Spy on resolveUserPath before importing the module under test.
// The replacement expands ~ to a fake home so the rest of the function
// can proceed without hitting the real filesystem.
const resolveUserPathSpy = vi.hoisted(() =>
  vi.fn((p: string) => p.replace(/^~/, "/tmp/fake-home")),
);

vi.mock("../../utils.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../utils.js")>();
  return { ...orig, resolveUserPath: resolveUserPathSpy };
});

import { loadWorkspaceSkillEntries } from "./workspace.js";

describe("loadWorkspaceSkillEntries", () => {
  it("expands tilde in workspace path via resolveUserPath (regression for #40518)", () => {
    // Before the fix, loadSkillEntries used the raw workspaceDir without
    // calling resolveUserPath, so ~ was treated as a literal directory name.
    loadWorkspaceSkillEntries("~/my-project");
    expect(resolveUserPathSpy).toHaveBeenCalledWith("~/my-project");
  });
});
