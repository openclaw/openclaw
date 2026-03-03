import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillSnapshot } from "../skills.js";

const hoisted = vi.hoisted(() => ({
  loadWorkspaceSkillEntries: vi.fn(),
}));

vi.mock("../skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills.js")>();
  return {
    ...actual,
    loadWorkspaceSkillEntries: (...args: unknown[]) => hoisted.loadWorkspaceSkillEntries(...args),
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
});
