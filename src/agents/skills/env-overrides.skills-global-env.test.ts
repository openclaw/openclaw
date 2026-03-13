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

  it("skill-level env wins over global env when the global pass ran first (concurrent sessions)", () => {
    // Simulate session A running its global pass before session B runs its per-skill pass.
    // Session A: only has a global env, no per-skill override for SHARED_KEY.
    const configA = makeConfig({
      skills: {
        env: { SHARED_KEY: "global-value" },
      },
    });
    const revertA = applySkillEnvOverrides({
      skills: [makeSkillEntry("skill-a")],
      config: configA,
    });

    // After session A's passes, SHARED_KEY should be "global-value".
    expect(process.env["SHARED_KEY"]).toBe("global-value");

    // Session B: has an explicit per-skill override for SHARED_KEY.
    // Even though the global pass already acquired SHARED_KEY, session B's
    // skill-level override must take precedence.
    const configB = makeConfig({
      skills: {
        env: { SHARED_KEY: "global-value" },
        entries: { "skill-b": { env: { SHARED_KEY: "skill-b-value" } } },
      },
    });
    const revertB = applySkillEnvOverrides({
      skills: [makeSkillEntry("skill-b")],
      config: configB,
    });

    expect(process.env["SHARED_KEY"]).toBe("skill-b-value");

    // Reverting B: A still holds the key (refcount > 0), so the key persists.
    // The stored value reflects the last skill-level upgrade; the important
    // invariant is that the key is not prematurely deleted.
    revertB();
    expect(process.env["SHARED_KEY"]).toBeDefined();

    // Reverting A: no more owners, key should be gone.
    revertA();
    expect(process.env["SHARED_KEY"]).toBeUndefined();
  });

  it("restores global value after last skill override releases (concurrent sessions)", () => {
    // Session A: holds SHARED_KEY via global env only.
    const configA = makeConfig({
      skills: { env: { SHARED_KEY: "global-value" } },
    });
    const revertA = applySkillEnvOverrides({
      skills: [makeSkillEntry("skill-a")],
      config: configA,
    });
    expect(process.env["SHARED_KEY"]).toBe("global-value");

    // Session B: overrides SHARED_KEY with a per-skill value.
    const configB = makeConfig({
      skills: {
        env: { SHARED_KEY: "global-value" },
        entries: { "skill-b": { env: { SHARED_KEY: "skill-b-value" } } },
      },
    });
    const revertB = applySkillEnvOverrides({
      skills: [makeSkillEntry("skill-b")],
      config: configB,
    });
    expect(process.env["SHARED_KEY"]).toBe("skill-b-value");

    // B reverts: A still holds a global reference, so the key must revert to
    // "global-value" rather than staying as "skill-b-value".
    revertB();
    expect(process.env["SHARED_KEY"]).toBe("global-value");

    // A reverts: no more owners, key must be cleaned up entirely.
    revertA();
    expect(process.env["SHARED_KEY"]).toBeUndefined();
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
