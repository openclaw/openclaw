import { describe, expect, it } from "vitest";
import {
  isSkillAllowedByPolicy,
  matchesSkillPolicySnapshot,
  resolveEffectiveSkillPolicy,
} from "./policy.js";
import type { SkillEntry, SkillSnapshot } from "./types.js";

function makeSkillEntry(params: { name: string; skillKey?: string }): SkillEntry {
  return {
    skill: {
      name: params.name,
      description: params.name,
      filePath: `/tmp/${params.name}/SKILL.md`,
      baseDir: `/tmp/${params.name}`,
      source: "openclaw-workspace",
      disableModelInvocation: false,
    },
    frontmatter: {},
    metadata: params.skillKey ? { skillKey: params.skillKey } : undefined,
  };
}

describe("skills policy resolution", () => {
  it("returns undefined when no policy is configured", () => {
    expect(resolveEffectiveSkillPolicy({}, "ops")).toBeUndefined();
  });

  it("resolves effective set as (global - disabled) U enabled", () => {
    const resolved = resolveEffectiveSkillPolicy(
      {
        skills: {
          policy: {
            globalEnabled: ["alpha", "beta"],
            agentOverrides: {
              ops: {
                enabled: ["gamma"],
                disabled: ["beta"],
              },
            },
          },
        },
      },
      "ops",
    );

    expect(resolved).toMatchObject({
      agentId: "ops",
      globalEnabled: ["alpha", "beta"],
      agentEnabled: ["gamma"],
      agentDisabled: ["beta"],
      effective: ["alpha", "gamma"],
    });
  });

  it("treats dotted and dashed names as the same skill when disabling", () => {
    const resolved = resolveEffectiveSkillPolicy(
      {
        skills: {
          policy: {
            globalEnabled: ["web.search", "weather"],
            agentOverrides: {
              ops: {
                disabled: ["web-search"],
              },
            },
          },
        },
      },
      "ops",
    );

    expect(resolved).toMatchObject({
      agentId: "ops",
      globalEnabled: ["weather", "web.search"],
      agentDisabled: ["web-search"],
      effective: ["weather"],
    });
  });

  it("matches entries by skillKey or skill name", () => {
    const resolved = resolveEffectiveSkillPolicy(
      {
        skills: {
          policy: {
            globalEnabled: ["web.search", "weather"],
          },
        },
      },
      "main",
    );
    expect(resolved).toBeDefined();
    if (!resolved) {
      return;
    }

    const keyEntry = makeSkillEntry({ name: "web-search", skillKey: "web.search" });
    const nameEntry = makeSkillEntry({ name: "weather" });
    const blockedEntry = makeSkillEntry({ name: "slack-send" });

    expect(isSkillAllowedByPolicy(keyEntry, resolved)).toBe(true);
    expect(isSkillAllowedByPolicy(nameEntry, resolved)).toBe(true);
    expect(isSkillAllowedByPolicy(blockedEntry, resolved)).toBe(false);
  });
});

describe("matchesSkillPolicySnapshot", () => {
  it("treats snapshots with equivalent values as equal", () => {
    const cached: SkillSnapshot["policy"] = {
      agentId: "ops",
      globalEnabled: ["alpha", "beta"],
      agentEnabled: ["gamma"],
      agentDisabled: ["beta"],
      effective: ["alpha", "gamma"],
    };
    const next: SkillSnapshot["policy"] = {
      agentId: "ops",
      globalEnabled: ["beta", "alpha"],
      agentEnabled: ["gamma"],
      agentDisabled: ["beta"],
      effective: ["gamma", "alpha"],
    };
    expect(matchesSkillPolicySnapshot(cached, next)).toBe(true);
  });

  it("detects changed policy values", () => {
    const cached: SkillSnapshot["policy"] = {
      agentId: "ops",
      globalEnabled: ["alpha"],
      agentEnabled: [],
      agentDisabled: [],
      effective: ["alpha"],
    };
    const next: SkillSnapshot["policy"] = {
      agentId: "ops",
      globalEnabled: ["alpha", "beta"],
      agentEnabled: [],
      agentDisabled: [],
      effective: ["alpha", "beta"],
    };
    expect(matchesSkillPolicySnapshot(cached, next)).toBe(false);
  });
});
