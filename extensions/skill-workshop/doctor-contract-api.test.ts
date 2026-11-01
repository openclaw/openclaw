import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

const marker = { migrations: { skillWorkshopPlugin: true } };
const normalize = (cfg: unknown) => normalizeCompatibilityConfig({ cfg: cfg as OpenClawConfig });

describe("Skill Workshop config move", () => {
  it("flags the retired core key before strict validation", () => {
    expect(legacyConfigRules.map((rule) => rule.path)).toEqual([["skills", "workshop"]]);
    expect(legacyConfigRules[0]?.message).toContain('Run "openclaw doctor --fix"');
  });

  it("moves every setting into the plugin config and records the migration", () => {
    const result = normalize({
      skills: {
        workshop: { autonomous: { mode: "propose", channelNotices: true }, maxSkillBytes: 8000 },
      },
    });

    expect(result.config).toEqual({
      plugins: {
        entries: {
          "skill-workshop": {
            config: { autonomous: { mode: "propose", channelNotices: true }, maxSkillBytes: 8000 },
          },
        },
      },
      meta: marker,
    });
    expect(result.changes).toEqual([
      "Moved skills.workshop to plugins.entries.skill-workshop.config.",
    ]);
  });

  it("keeps other skills and plugin settings, and lets existing plugin settings win", () => {
    const result = normalize({
      skills: {
        load: { watch: false },
        workshop: { autonomous: { mode: "off", channelNotices: true } },
      },
      plugins: {
        allow: ["skill-workshop"],
        entries: {
          "skill-workshop": { enabled: true, config: { autonomous: { mode: "propose" } } },
          other: { enabled: false },
        },
      },
      meta: { lastTouchedVersion: "2026.10.9", ...marker },
    });

    expect(result.config).toEqual({
      skills: { load: { watch: false } },
      plugins: {
        allow: ["skill-workshop"],
        entries: {
          "skill-workshop": {
            enabled: true,
            config: { autonomous: { mode: "propose", channelNotices: true } },
          },
          other: { enabled: false },
        },
      },
      meta: { lastTouchedVersion: "2026.10.9", ...marker },
    });
  });

  it("waits for core Doctor to repair an unmarked plugin entry first", () => {
    // Policy written while Workshop was built in may be stale; core repairs it in the same pass.
    const cfg = {
      skills: { workshop: { autonomous: { mode: "off" } } },
      plugins: { entries: { "skill-workshop": { enabled: false } } },
    };

    const result = normalize(cfg);

    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });

  it("drops anything under the retired key that the plugin does not own", () => {
    const result = normalize({ skills: { workshop: { approvalPolicy: "pending" } } });

    expect(result.config).toEqual({
      plugins: { entries: { "skill-workshop": { config: {} } } },
      meta: marker,
    });
  });

  it("leaves configs without the retired key untouched", () => {
    const cfg = { skills: { load: { watch: false } } };

    expect(normalize(cfg)).toEqual({ config: cfg, changes: [] });
  });
});
