import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillEntry, SkillSnapshot } from "../skills.js";

const hoisted = vi.hoisted(() => ({
  loadWorkspaceSkillEntries: vi.fn(
    (_workspaceDir: string, _options?: { config?: OpenClawConfig }) => [] as SkillEntry[],
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
});

// RI-030 Block 1.5 item #4 — cert_tier mandatory sandbox filter.
describe("resolveEmbeddedRunSkillEntries cert_tier filter", () => {
  const buildEntry = (
    name: string,
    certTier: "certified" | "verified" | "unverified" | undefined,
  ): SkillEntry => ({
    skill: {
      name,
      description: `${name} skill`,
      filePath: `/tmp/skills/${name}/SKILL.md`,
      baseDir: `/tmp/skills/${name}`,
      source: "workspace",
      disableModelInvocation: false,
    },
    frontmatter: {},
    metadata: certTier ? { certTier } : {},
  });

  beforeEach(() => {
    hoisted.loadWorkspaceSkillEntries.mockReset();
  });

  it("keeps every skill when the session is sandboxed (sandbox handles isolation)", () => {
    hoisted.loadWorkspaceSkillEntries.mockReturnValue([
      buildEntry("legacy-no-tier", undefined),
      buildEntry("certified-skill", "certified"),
      buildEntry("verified-skill", "verified"),
      buildEntry("unverified-skill", "unverified"),
    ]);

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      sandboxed: true,
    });

    expect(result.skillEntries.map((e) => e.skill.name)).toEqual([
      "legacy-no-tier",
      "certified-skill",
      "verified-skill",
      "unverified-skill",
    ]);
  });

  it("drops unverified skills when the session is NOT sandboxed", () => {
    hoisted.loadWorkspaceSkillEntries.mockReturnValue([
      buildEntry("certified-skill", "certified"),
      buildEntry("unverified-skill", "unverified"),
    ]);

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      sandboxed: false,
    });

    expect(result.skillEntries.map((e) => e.skill.name)).toEqual(["certified-skill"]);
  });

  it("preserves legacy skills without a cert_tier (backwards compatibility)", () => {
    hoisted.loadWorkspaceSkillEntries.mockReturnValue([
      buildEntry("legacy-no-tier", undefined),
      buildEntry("another-legacy", undefined),
    ]);

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      sandboxed: false,
    });

    expect(result.skillEntries).toHaveLength(2);
  });

  it("keeps only certified skills on an unsandboxed session (verified AND unverified require mandatory sandbox)", () => {
    hoisted.loadWorkspaceSkillEntries.mockReturnValue([
      buildEntry("certified-skill", "certified"),
      buildEntry("verified-skill", "verified"),
      buildEntry("unverified-skill", "unverified"),
    ]);

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      sandboxed: false,
    });

    expect(result.skillEntries.map((e) => e.skill.name)).toEqual(["certified-skill"]);
  });

  it("defaults to unsandboxed behavior when sandboxed flag is omitted", () => {
    hoisted.loadWorkspaceSkillEntries.mockReturnValue([buildEntry("unverified-skill", "unverified")]);

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
    });

    expect(result.skillEntries).toHaveLength(0);
  });
});
