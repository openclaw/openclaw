import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillSnapshot } from "../skills.js";

const hoisted = vi.hoisted(() => ({
  loadWorkspaceSkillEntries: vi.fn(
    (_workspaceDir: string, _options?: { config?: OpenClawConfig }) => [],
  ),
}));

vi.mock("../skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills.js")>();
  return {
    ...actual,
    loadWorkspaceSkillEntries: (workspaceDir: string, options?: { config?: OpenClawConfig }) =>
      hoisted.loadWorkspaceSkillEntries(workspaceDir, options),
  };
});

const { resolveEmbeddedRunSkillEntries } = await import("./skills-runtime.js");

describe("resolveEmbeddedRunSkillEntries", () => {
  beforeEach(() => {
    hoisted.loadWorkspaceSkillEntries.mockReset();
    hoisted.loadWorkspaceSkillEntries.mockReturnValue([]);
  });

  it("loads skill entries with config when no resolved snapshot skills exist", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          diffs: { enabled: true },
        },
      },
    };

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(hoisted.loadWorkspaceSkillEntries).toHaveBeenCalledTimes(1);
    expect(hoisted.loadWorkspaceSkillEntries).toHaveBeenCalledWith("/tmp/workspace", { config });
  });

  it("skips skill entry loading when resolved snapshot skills are present", () => {
    const snapshot: SkillSnapshot = {
      prompt: "skills prompt",
      skills: [{ name: "diffs" }],
      resolvedSkills: [],
    };

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      skillsSnapshot: snapshot,
    });

    expect(result).toEqual({
      shouldLoadSkillEntries: false,
      skillEntries: [],
    });
    expect(hoisted.loadWorkspaceSkillEntries).not.toHaveBeenCalled();
  });

  it("can force loading skill entries even when snapshot skills are present", () => {
    const snapshot: SkillSnapshot = {
      prompt: "host prompt",
      skills: [{ name: "demo" }],
      resolvedSkills: [],
    };

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/workspace",
      config: {},
      skillsSnapshot: snapshot,
      forceLoadEntries: true,
    });

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(hoisted.loadWorkspaceSkillEntries).toHaveBeenCalledTimes(1);
    expect(hoisted.loadWorkspaceSkillEntries).toHaveBeenCalledWith("/workspace", { config: {} });
  });
});
