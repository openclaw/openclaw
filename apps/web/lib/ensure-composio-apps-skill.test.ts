import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const seedSkill = vi.fn();

vi.mock("@/lib/project-root", () => ({
  resolveDenchPackageRoot: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => "/tmp/mock-openclaw-state"),
}));

vi.mock("@/lib/workspace-seed", () => ({
  discoverWorkspaceDirs: vi.fn(),
  MANAGED_SKILLS: [{ name: "composio-apps" }],
  seedSkill,
}));

const { resolveDenchPackageRoot } = await import("@/lib/project-root");
const { discoverWorkspaceDirs } = await import("@/lib/workspace-seed");
const { ensureComposioAppsSkillInWorkspaces } = await import("./ensure-composio-apps-skill");

describe("ensureComposioAppsSkillInWorkspaces", () => {
  let packageRoot: string;
  let workspaceDir: string;

  beforeEach(() => {
    seedSkill.mockReset();
    packageRoot = path.join(os.tmpdir(), `dench-package-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspaceDir = path.join(os.tmpdir(), `dench-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(packageRoot, "skills", "composio-apps"), { recursive: true });
    mkdirSync(path.join(workspaceDir, "skills", "composio-apps"), { recursive: true });
    vi.mocked(resolveDenchPackageRoot).mockReturnValue(packageRoot);
    vi.mocked(discoverWorkspaceDirs).mockReturnValue([workspaceDir]);
  });

  afterEach(() => {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("re-seeds the skill when the bundled SKILL.md hash changes", () => {
    writeFileSync(
      path.join(packageRoot, "skills", "composio-apps", "SKILL.md"),
      "# bundled skill\nUse Composio.\n",
      "utf-8",
    );
    writeFileSync(
      path.join(workspaceDir, "skills", "composio-apps", "SKILL.md"),
      "# stale skill\nUse gog.\n",
      "utf-8",
    );

    ensureComposioAppsSkillInWorkspaces();

    expect(seedSkill).toHaveBeenCalledWith(
      { workspaceDir, packageRoot },
      { name: "composio-apps" },
    );
  });

  it("does not rewrite the skill when the bundled hash matches", () => {
    const content = "# bundled skill\nUse Composio.\n";
    writeFileSync(path.join(packageRoot, "skills", "composio-apps", "SKILL.md"), content, "utf-8");
    writeFileSync(path.join(workspaceDir, "skills", "composio-apps", "SKILL.md"), content, "utf-8");

    ensureComposioAppsSkillInWorkspaces();

    expect(seedSkill).not.toHaveBeenCalled();
  });
});
