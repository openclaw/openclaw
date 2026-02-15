import type { Skill } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillEntry } from "./types.js";
import {
  buildCompactSkillIndex,
  buildLazySkillSnapshot,
  resolveLazySkillLoadingConfig,
  resolveSkillContent,
} from "./lazy-loading.js";

/** Map from filePath → content, used by the fs mock. */
const fileContents = new Map<string, string>();

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (path: string) => {
      const content = fileContents.get(path);
      if (content === undefined) throw new Error(`ENOENT: no such file ${path}`);
      return content;
    },
  },
}));

function makeSkillEntry(name: string, description: string, content = ""): SkillEntry {
  const filePath = `/skills/${name}/SKILL.md`;
  fileContents.set(filePath, content);
  return {
    skill: {
      name,
      description,
      filePath,
      baseDir: `/skills/${name}`,
      source: "test",
      disableModelInvocation: false,
    },
    frontmatter: {},
    metadata: {},
    invocation: {},
  };
}

beforeEach(() => {
  fileContents.clear();
});

describe("resolveLazySkillLoadingConfig", () => {
  it("defaults to disabled", () => {
    expect(resolveLazySkillLoadingConfig().enabled).toBe(false);
    expect(resolveLazySkillLoadingConfig({}).enabled).toBe(false);
  });

  it("respects explicit config", () => {
    expect(
      resolveLazySkillLoadingConfig({
        agents: { defaults: { skills: { lazyLoading: true } } },
      } as never).enabled,
    ).toBe(true);
  });
});

describe("buildCompactSkillIndex", () => {
  it("returns empty string for no skills", () => {
    expect(buildCompactSkillIndex([])).toBe("");
  });

  it("builds compact index with name and description", () => {
    const entries = [
      makeSkillEntry("weather", "Get weather forecasts"),
      makeSkillEntry("github", "Manage GitHub issues and PRs"),
    ];
    const result = buildCompactSkillIndex(entries);
    expect(result).toContain("**weather**: Get weather forecasts");
    expect(result).toContain("**github**: Manage GitHub issues and PRs");
    expect(result).toContain("load_skill");
  });

  it("is significantly smaller than full skill content", () => {
    const longContent = "x".repeat(5000);
    const entries = [
      makeSkillEntry("skill1", "Short description", longContent),
      makeSkillEntry("skill2", "Another skill", longContent),
      makeSkillEntry("skill3", "Third skill", longContent),
    ];
    const compactIndex = buildCompactSkillIndex(entries);
    const fullContentLength = longContent.length * 3;
    expect(compactIndex.length).toBeLessThan(fullContentLength * 0.1);
  });
});

describe("resolveSkillContent", () => {
  it("returns full content for matching skill", () => {
    const entries = [
      makeSkillEntry("weather", "Get weather"),
      makeSkillEntry("github", "GitHub integration"),
    ];
    fileContents.set("/skills/weather/SKILL.md", "Full weather skill content here...");
    fileContents.set("/skills/github/SKILL.md", "Full GitHub skill content here...");
    const skills = entries.map((e) => e.skill);

    const result = resolveSkillContent("weather", skills);
    expect(result.found).toBe(true);
    expect(result.content).toBe("Full weather skill content here...");
  });

  it("is case-insensitive", () => {
    const entries = [makeSkillEntry("weather", "Get weather")];
    fileContents.set("/skills/weather/SKILL.md", "weather content");
    const skills = entries.map((e) => e.skill);

    const result = resolveSkillContent("Weather", skills);
    expect(result.found).toBe(true);
  });

  it("returns error for unknown skill", () => {
    const entries = [
      makeSkillEntry("weather", "Get weather"),
      makeSkillEntry("github", "GitHub integration"),
    ];
    const skills = entries.map((e) => e.skill);

    const result = resolveSkillContent("unknown", skills);
    expect(result.found).toBe(false);
    expect(result.content).toContain("not found");
    expect(result.content).toContain("weather");
    expect(result.content).toContain("github");
  });

  it("returns error for empty skills", () => {
    const result = resolveSkillContent("test", []);
    expect(result.found).toBe(false);
  });
});

describe("buildLazySkillSnapshot", () => {
  it("creates snapshot with compact prompt", () => {
    const entries = [makeSkillEntry("weather", "Get weather")];
    const resolvedSkills = entries.map((e) => e.skill);
    const snapshot = buildLazySkillSnapshot({
      entries,
      resolvedSkills,
      snapshotVersion: 1,
    });

    expect(snapshot.prompt).toContain("weather");
    expect(snapshot.prompt).toContain("load_skill");
    expect(snapshot.resolvedSkills).toHaveLength(1);
    expect(snapshot.version).toBe(1);
  });
});
