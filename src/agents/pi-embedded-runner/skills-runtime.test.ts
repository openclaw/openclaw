import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import * as skillsModule from "../skills.js";
import type { SkillSnapshot } from "../skills.js";

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
    expect(loadWorkspaceSkillEntriesSpy).not.toHaveBeenCalled();
  });
});
