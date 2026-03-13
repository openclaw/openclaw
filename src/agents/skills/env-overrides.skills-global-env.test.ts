import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { applySkillEnvOverrides, applySkillEnvOverridesFromSnapshot } from "./env-overrides.js";
import type { SkillEntry } from "./types.js";

function makeSkillEntry(name: string): SkillEntry {
  return {
    skill: { name, source: "workspace", path: `/skills/${name}` },
    metadata: { primaryEnv: undefined, requires: undefined, always: false },
  } as unknown as SkillEntry;
}

function makeConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return overrides as OpenClawConfig;
}

describe("skills global env", () => {
  beforeEach(() => {
    delete process.env["GLOBAL_API_KEY"];
    delete process.env["SKILL_API_KEY"];
    delete process.env["SHARED_KEY"];
    delete process.env["SNAPSHOT_KEY"];
  });

  afterEach(() => {
    delete process.env["GLOBAL_API_KEY"];
    delete process.env["SKILL_API_KEY"];
    delete process.env["SHARED_KEY"];
    delete process.env["SNAPSHOT_KEY"];
  });

  it("injects global env vars into process.env for all skills", () => {
    const config = makeConfig({
      skills: {
        env: { GLOBAL_API_KEY: "global-value" },
        entries: { "my-skill": {} },
      },
    });

    const revert = applySkillEnvOverrides({
      skills: [makeSkillEntry("my-skill")],
      config,
    });

    expect(process.env["GLOBAL_API_KEY"]).toBe("global-value");
    revert();
    expect(process.env["GLOBAL_API_KEY"]).toBeUndefined();
  });

  it("skill-level env overrides global env for the same key", () => {
    const config = makeConfig({
      skills: {
        env: { SHARED_KEY: "global-value" },
        entries: {
          "my-skill": { env: { SHARED_KEY: "skill-value" } },
        },
      },
    });

    const revert = applySkillEnvOverrides({
      skills: [makeSkillEntry("my-skill")],
      config,
    });

    expect(process.env["SHARED_KEY"]).toBe("skill-value");
    revert();
    expect(process.env["SHARED_KEY"]).toBeUndefined();
  });

  it("global env is injected even when skill has no entries config", () => {
    const config = makeConfig({
      skills: {
        env: { GLOBAL_API_KEY: "global-value" },
      },
    });

    const revert = applySkillEnvOverrides({
      skills: [makeSkillEntry("unknown-skill")],
      config,
    });

    expect(process.env["GLOBAL_API_KEY"]).toBe("global-value");
    revert();
    expect(process.env["GLOBAL_API_KEY"]).toBeUndefined();
  });

  it("global env does not override existing process.env values", () => {
    process.env["GLOBAL_API_KEY"] = "existing-value";

    const config = makeConfig({
      skills: {
        env: { GLOBAL_API_KEY: "global-value" },
        entries: { "my-skill": {} },
      },
    });

    const revert = applySkillEnvOverrides({
      skills: [makeSkillEntry("my-skill")],
      config,
    });

    expect(process.env["GLOBAL_API_KEY"]).toBe("existing-value");
    revert();
    expect(process.env["GLOBAL_API_KEY"]).toBe("existing-value");
  });

  it("reverts global env after skill deactivation", () => {
    const config = makeConfig({
      skills: {
        env: { GLOBAL_API_KEY: "global-value" },
        entries: { "my-skill": {} },
      },
    });

    const revert = applySkillEnvOverrides({
      skills: [makeSkillEntry("my-skill")],
      config,
    });

    expect(process.env["GLOBAL_API_KEY"]).toBe("global-value");
    revert();
    expect(process.env["GLOBAL_API_KEY"]).toBeUndefined();
  });

  it("skill-level apiKey takes precedence over global env for the same primary env key", () => {
    const config = makeConfig({
      skills: {
        env: { SKILL_API_KEY: "global-fallback" },
        entries: {
          "my-skill": { apiKey: "skill-apikey-value" },
        },
      },
    });

    const entry = {
      ...makeSkillEntry("my-skill"),
      metadata: { primaryEnv: "SKILL_API_KEY", requires: undefined, always: false },
    } as unknown as import("./types.js").SkillEntry;

    const revert = applySkillEnvOverrides({ skills: [entry], config });

    expect(process.env["SKILL_API_KEY"]).toBe("skill-apikey-value");
    revert();
    expect(process.env["SKILL_API_KEY"]).toBeUndefined();
  });

  it("applySkillEnvOverridesFromSnapshot injects global env for a skill with no entries config", () => {
    const config = makeConfig({
      skills: {
        env: { SNAPSHOT_KEY: "snapshot-global-value" },
      },
    });

    const snapshot = {
      skills: [
        {
          name: "snapshot-skill",
          primaryEnv: undefined,
          requiredEnv: [],
        },
      ],
    } as unknown as import("./types.js").SkillSnapshot;

    const revert = applySkillEnvOverridesFromSnapshot({ snapshot, config });

    expect(process.env["SNAPSHOT_KEY"]).toBe("snapshot-global-value");
    revert();
    expect(process.env["SNAPSHOT_KEY"]).toBeUndefined();
  });
});
