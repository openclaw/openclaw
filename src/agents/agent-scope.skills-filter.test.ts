import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentSkillsFilter } from "./agent-scope.js";

describe("resolveAgentSkillsFilter", () => {
  it("returns undefined when agent has no skills allowlist", () => {
    const cfg = {
      agents: {
        list: [{ id: "test-agent" }],
      },
    } as OpenClawConfig;

    expect(resolveAgentSkillsFilter(cfg, "test-agent")).toBeUndefined();
  });

  it("returns the normalized skills allowlist for a configured agent", () => {
    const cfg = {
      agents: {
        list: [{ id: "my-agent", skills: ["github", " weather ", "calculator"] }],
      },
    } as OpenClawConfig;

    const filter = resolveAgentSkillsFilter(cfg, "my-agent");
    expect(filter).toEqual(["github", "weather", "calculator"]);
  });

  it("returns empty array when skills is an empty array (disables all skills)", () => {
    const cfg = {
      agents: {
        list: [{ id: "locked-agent", skills: [] }],
      },
    } as OpenClawConfig;

    const filter = resolveAgentSkillsFilter(cfg, "locked-agent");
    expect(filter).toEqual([]);
  });

  it("returns undefined for an unknown agent", () => {
    const cfg = {
      agents: {
        list: [{ id: "known-agent", skills: ["github"] }],
      },
    } as OpenClawConfig;

    expect(resolveAgentSkillsFilter(cfg, "unknown-agent")).toBeUndefined();
  });

  it("filters out whitespace-only entries", () => {
    const cfg = {
      agents: {
        list: [{ id: "test-agent", skills: ["github", "  ", "", "weather"] }],
      },
    } as OpenClawConfig;

    const filter = resolveAgentSkillsFilter(cfg, "test-agent");
    expect(filter).toEqual(["github", "weather"]);
  });
});
