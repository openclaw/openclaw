import { describe, expect, it } from "vitest";
import { DEFAULT_IDENTITY_LINE, resolveIdentityLine } from "./identity-line.js";

describe("resolveIdentityLine", () => {
  it("returns the default line when no config is provided", () => {
    expect(resolveIdentityLine({})).toBe(DEFAULT_IDENTITY_LINE);
  });

  it("returns the default line when identityMode is not set", () => {
    expect(
      resolveIdentityLine({
        config: { agents: { defaults: {}, list: [{ id: "main" }] } },
        agentId: "main",
      }),
    ).toBe(DEFAULT_IDENTITY_LINE);
  });

  it("returns null when identityMode is 'none'", () => {
    expect(
      resolveIdentityLine({
        config: { agents: { defaults: { identityMode: "none" } } },
      }),
    ).toBeNull();
  });

  it("uses the custom identityLine from defaults", () => {
    expect(
      resolveIdentityLine({
        config: {
          agents: {
            defaults: {
              identityMode: "custom",
              identityLine: "You are a custom assistant.",
            },
          },
        },
      }),
    ).toBe("You are a custom assistant.");
  });

  it("per-agent identityMode overrides defaults", () => {
    expect(
      resolveIdentityLine({
        config: {
          agents: {
            defaults: { identityMode: "default" },
            list: [{ id: "special", identityMode: "none" }],
          },
        },
        agentId: "special",
      }),
    ).toBeNull();
  });

  it("per-agent identityLine overrides defaults identityLine", () => {
    expect(
      resolveIdentityLine({
        config: {
          agents: {
            defaults: {
              identityMode: "custom",
              identityLine: "default custom line",
            },
            list: [{ id: "special", identityLine: "agent custom line" }],
          },
        },
        agentId: "special",
      }),
    ).toBe("agent custom line");
  });

  it("falls back to defaults identityLine when per-agent identityLine is not set", () => {
    expect(
      resolveIdentityLine({
        config: {
          agents: {
            defaults: {
              identityMode: "custom",
              identityLine: "default custom line",
            },
            list: [{ id: "main" }],
          },
        },
        agentId: "main",
      }),
    ).toBe("default custom line");
  });

  it("falls back to default line when custom mode has no identityLine", () => {
    expect(
      resolveIdentityLine({
        config: { agents: { defaults: { identityMode: "custom" } } },
      }),
    ).toBe(DEFAULT_IDENTITY_LINE);
  });

  it("trims whitespace from identityLine", () => {
    expect(
      resolveIdentityLine({
        config: {
          agents: {
            defaults: {
              identityMode: "custom",
              identityLine: "  trimmed line  ",
            },
          },
        },
      }),
    ).toBe("trimmed line");
  });

  it("treats blank identityLine as missing", () => {
    expect(
      resolveIdentityLine({
        config: {
          agents: {
            defaults: {
              identityMode: "custom",
              identityLine: "   ",
            },
          },
        },
      }),
    ).toBe(DEFAULT_IDENTITY_LINE);
  });
});
