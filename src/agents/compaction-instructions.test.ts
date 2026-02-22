import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  DEFAULT_COMPACTION_INSTRUCTIONS,
  resolveCompactionInstructions,
} from "./compaction-instructions.js";

describe("resolveCompactionInstructions", () => {
  it("returns default when config is undefined", () => {
    expect(resolveCompactionInstructions(undefined)).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
  });

  it("returns default when config.agents is undefined", () => {
    const config = {} as OpenClawConfig;
    expect(resolveCompactionInstructions(config)).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
  });

  it("returns default when config.agents.defaults is undefined", () => {
    const config = { agents: {} } as OpenClawConfig;
    expect(resolveCompactionInstructions(config)).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
  });

  it("returns default when config.agents.defaults.compaction is undefined", () => {
    const config = { agents: { defaults: {} } } as OpenClawConfig;
    expect(resolveCompactionInstructions(config)).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
  });

  it("returns default when customInstructions is undefined", () => {
    const config = { agents: { defaults: { compaction: {} } } } as OpenClawConfig;
    expect(resolveCompactionInstructions(config)).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
  });

  it("returns default when customInstructions is empty string", () => {
    const config = {
      agents: { defaults: { compaction: { customInstructions: "" } } },
    } as OpenClawConfig;
    expect(resolveCompactionInstructions(config)).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
  });

  it("returns default when customInstructions is whitespace only", () => {
    const config = {
      agents: { defaults: { compaction: { customInstructions: "   \n\t  " } } },
    } as OpenClawConfig;
    expect(resolveCompactionInstructions(config)).toBe(DEFAULT_COMPACTION_INSTRUCTIONS);
  });

  it("returns config value when customInstructions is set", () => {
    const custom = "Keep all UUIDs and IPs intact.";
    const config = {
      agents: { defaults: { compaction: { customInstructions: custom } } },
    } as OpenClawConfig;
    expect(resolveCompactionInstructions(config)).toBe(custom);
  });
});
