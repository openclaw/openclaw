import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAppSkillsAllowlist } from "./agent-scope.js";

const cfg = (agents: unknown): OpenClawConfig => ({ agents }) as unknown as OpenClawConfig;

describe("resolveAppSkillsAllowlist", () => {
  it("defaults-only config (life shape: no agents.list) uses agents.defaults.appSkills", () => {
    // life's real config is `{ agents: { defaults: { ... } } }` with no list — the defaults
    // fallback is load-bearing (resolveAgentConfig returns undefined for it).
    const c = cfg({ defaults: { appSkills: ["personal-vision-exercise"] } });
    expect(resolveAppSkillsAllowlist(c, "life")).toEqual(["personal-vision-exercise"]);
  });

  it("unset → undefined (catalog unchanged; other app agents unaffected)", () => {
    expect(resolveAppSkillsAllowlist(cfg({ defaults: {} }), "life")).toBeUndefined();
    expect(resolveAppSkillsAllowlist(cfg(undefined), "life")).toBeUndefined();
  });

  it("per-agent entry overrides defaults; an agent without its own falls back to defaults", () => {
    const c = cfg({
      defaults: { appSkills: ["base"] },
      list: [{ id: "alpha", appSkills: ["alpha-only"] }, { id: "beta" }],
    });
    expect(resolveAppSkillsAllowlist(c, "alpha")).toEqual(["alpha-only"]);
    expect(resolveAppSkillsAllowlist(c, "beta")).toEqual(["base"]);
  });

  it("explicit empty entry array is honored as 'no app skills'", () => {
    const c = cfg({ defaults: { appSkills: ["base"] }, list: [{ id: "alpha", appSkills: [] }] });
    expect(resolveAppSkillsAllowlist(c, "alpha")).toEqual([]);
  });

  it("isolation: each agent resolves its own allowlist (never global)", () => {
    const c = cfg({
      list: [
        { id: "alpha", appSkills: ["a"] },
        { id: "beta", appSkills: ["b"] },
      ],
    });
    expect(resolveAppSkillsAllowlist(c, "alpha")).toEqual(["a"]);
    expect(resolveAppSkillsAllowlist(c, "beta")).toEqual(["b"]);
  });
});
