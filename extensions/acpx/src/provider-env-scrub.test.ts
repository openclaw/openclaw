import { describe, expect, it } from "vitest";
import {
  ACP_HARNESS_PROVIDER_AUTH_ENV_VARS,
  resolveAcpProviderEnvScrubKeys,
} from "./provider-env-scrub.js";

describe("resolveAcpProviderEnvScrubKeys", () => {
  it("strips Anthropic creds for the claude harness", () => {
    expect(resolveAcpProviderEnvScrubKeys("claude")).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ]);
  });

  it("strips OpenAI creds for the codex harness", () => {
    expect(resolveAcpProviderEnvScrubKeys("codex")).toEqual([
      "OPENAI_API_KEY",
      "OPENAI_AUTH_TOKEN",
    ]);
  });

  it("strips Google creds for the gemini harness", () => {
    expect(resolveAcpProviderEnvScrubKeys("gemini")).toEqual([
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_AUTH_TOKEN",
    ]);
  });

  it("normalizes case and whitespace on the agent id", () => {
    expect(resolveAcpProviderEnvScrubKeys("  Claude ")).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ]);
  });

  it("never strips anything for the openclaw bridge runtime", () => {
    expect(resolveAcpProviderEnvScrubKeys("openclaw")).toEqual([]);
  });

  it("returns nothing when scrubbing is disabled", () => {
    expect(resolveAcpProviderEnvScrubKeys("claude", { scrubProviderEnv: false })).toEqual([]);
  });

  it("strips every known provider credential for an unrecognized harness (defense in depth)", () => {
    const keys = resolveAcpProviderEnvScrubKeys("some-future-harness");
    expect(keys).toContain("ANTHROPIC_API_KEY");
    expect(keys).toContain("OPENAI_API_KEY");
    expect(keys).toContain("GEMINI_API_KEY");
    // de-duplicated, never empty
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(0);
  });

  it("returns a fresh array (callers may mutate it safely)", () => {
    const a = resolveAcpProviderEnvScrubKeys("claude");
    a.push("MUTATED");
    expect(resolveAcpProviderEnvScrubKeys("claude")).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ]);
  });

  it("exposes a table-driven, additive mapping", () => {
    expect(ACP_HARNESS_PROVIDER_AUTH_ENV_VARS.claude).toContain("ANTHROPIC_API_KEY");
    expect(ACP_HARNESS_PROVIDER_AUTH_ENV_VARS.openclaw).toEqual([]);
  });
});
