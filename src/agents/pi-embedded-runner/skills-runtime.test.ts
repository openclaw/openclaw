import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import * as skillsModule from "../skills.js";
import type { SkillEntry, SkillSnapshot } from "../skills.js";
import { createCanonicalFixtureSkill } from "../skills.test-helpers.js";

const { resolveEmbeddedRunSkillEntries } = await import("./skills-runtime.js");

describe("resolveEmbeddedRunSkillEntries", () => {
  const loadWorkspaceSkillEntriesSpy = vi.spyOn(skillsModule, "loadWorkspaceSkillEntries");

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    loadWorkspaceSkillEntriesSpy.mockReset();
    loadWorkspaceSkillEntriesSpy.mockReturnValue([]);
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
    expect(loadWorkspaceSkillEntriesSpy).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceSkillEntriesSpy).toHaveBeenCalledWith("/tmp/workspace", { config });
  });

  it("threads agentId through live skill loading", () => {
    resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      agentId: "writer",
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(loadWorkspaceSkillEntriesSpy).toHaveBeenCalledWith("/tmp/workspace", {
      config: {},
      agentId: "writer",
    });
  });

  it("prefers the active runtime snapshot when caller config still contains SecretRefs", () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: {
              source: "file",
              provider: "default",
              id: "/skills/entries/diffs/apiKey",
            },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: "resolved-key",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: sourceConfig,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(loadWorkspaceSkillEntriesSpy).toHaveBeenCalledWith("/tmp/workspace", {
      config: runtimeConfig,
    });
  });

  it("prefers caller config when the active runtime snapshot still contains raw skill SecretRefs", () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: {
              source: "file",
              provider: "default",
              id: "/skills/entries/diffs/apiKey",
            },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = structuredClone(sourceConfig);
    const callerConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: "resolved-key",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: callerConfig,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(loadWorkspaceSkillEntriesSpy).toHaveBeenCalledWith("/tmp/workspace", {
      config: callerConfig,
    });
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
      promptSkillEntries: [],
    });
    expect(loadWorkspaceSkillEntriesSpy).not.toHaveBeenCalled();
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
    expect(loadWorkspaceSkillEntriesSpy).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceSkillEntriesSpy).toHaveBeenCalledWith("/workspace", { config: {} });
    expect(result.promptSkillEntries).toEqual([]);
  });

  it("returns the same config-eligible live entries used for prompt rebuilding", () => {
    const enabled = createSkillEntry("enabled-skill");
    const disabled = createSkillEntry("disabled-skill");
    loadWorkspaceSkillEntriesSpy.mockReturnValue([enabled, disabled]);

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/workspace",
      config: {
        skills: {
          entries: {
            "disabled-skill": { enabled: false },
          },
        },
      },
      skillsSnapshot: {
        prompt: "host prompt",
        skills: [{ name: "enabled-skill" }, { name: "disabled-skill" }],
        resolvedSkills: [],
      },
      forceLoadEntries: true,
    });

    expect(result.skillEntries).toEqual([enabled]);
    expect(result.promptSkillEntries).toEqual([enabled]);
  });

  it("keeps env override entries aligned with the prompt-visible live entries", () => {
    const visible = createSkillEntry("visible-skill");
    const hidden = createSkillEntry("hidden-skill", { disableModelInvocation: true });
    loadWorkspaceSkillEntriesSpy.mockReturnValue([visible, hidden]);

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/workspace",
      config: {},
      skillsSnapshot: {
        prompt: "host prompt",
        skills: [{ name: "visible-skill" }, { name: "hidden-skill" }],
        resolvedSkills: [],
      },
      forceLoadEntries: true,
    });

    expect(result.skillEntries).toEqual([visible, hidden]);
    expect(result.promptSkillEntries).toEqual([visible]);
  });

  it("preserves snapshot skill filter when force loading entries", () => {
    const snapshot: SkillSnapshot = {
      prompt: "host prompt",
      skills: [{ name: "github" }],
      skillFilter: ["github"],
      resolvedSkills: [],
    };

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/workspace",
      config: {},
      agentId: "writer",
      skillsSnapshot: snapshot,
      forceLoadEntries: true,
    });

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(loadWorkspaceSkillEntriesSpy).toHaveBeenCalledWith("/workspace", {
      config: {},
      agentId: "writer",
      skillFilter: ["github"],
    });
  });

  it("threads eligibility through live skill loading", () => {
    const eligibility = {
      remote: {
        platforms: ["darwin"],
        hasBin: () => true,
        hasAnyBin: () => true,
        note: "Remote macOS node available.",
      },
    };

    resolveEmbeddedRunSkillEntries({
      workspaceDir: "/workspace",
      config: {},
      agentId: "writer",
      skillsSnapshot: {
        prompt: "host prompt",
        skills: [{ name: "remote-only" }],
        skillFilter: ["remote-only"],
        resolvedSkills: [],
      },
      forceLoadEntries: true,
      eligibility,
    });

    expect(loadWorkspaceSkillEntriesSpy).toHaveBeenCalledWith("/workspace", {
      config: {},
      agentId: "writer",
      skillFilter: ["remote-only"],
      eligibility,
    });
  });
});

function createSkillEntry(name: string, opts?: { disableModelInvocation?: boolean }): SkillEntry {
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: name,
      filePath: `/workspace/skills/${name}/SKILL.md`,
      baseDir: `/workspace/skills/${name}`,
      source: "openclaw-workspace",
      disableModelInvocation: opts?.disableModelInvocation,
    }),
    frontmatter: {},
  };
}
