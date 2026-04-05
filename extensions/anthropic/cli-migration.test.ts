import { describe, expect, it, vi } from "vitest";

const readClaudeCliCredentialsForSetup = vi.hoisted(() => vi.fn());

vi.mock("./cli-auth-seam.js", async (importActual) => {
  const actual = await importActual<typeof import("./cli-auth-seam.js")>();
  return {
    ...actual,
    readClaudeCliCredentialsForSetup,
  };
});

const { buildAnthropicCliMigrationResult, buildClaudeCliRuntimeAuthProfile, hasClaudeCliAuth } =
  await import("./cli-migration.js");

describe("anthropic cli migration", () => {
  it("detects local Claude CLI auth", () => {
    readClaudeCliCredentialsForSetup.mockReturnValue({ type: "oauth" });

    expect(hasClaudeCliAuth()).toBe(true);
  });

  it("builds a claude-cli runtime auth profile from native setup credentials", () => {
    readClaudeCliCredentialsForSetup.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "setup-access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    expect(buildClaudeCliRuntimeAuthProfile()).toEqual({
      profileId: "claude-cli:default",
      credential: {
        type: "token",
        provider: "claude-cli",
        token: "setup-access-token",
      },
    });
  });

  it("rewrites anthropic defaults to claude-cli defaults", () => {
    const result = buildAnthropicCliMigrationResult({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4-6",
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            "anthropic/claude-opus-4-6": { alias: "Opus" },
            "openai/gpt-5.2": {},
          },
        },
      },
    });

    expect(result.profiles).toEqual([]);
    expect(result.defaultModel).toBe("claude-cli/claude-sonnet-4-6");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "claude-cli/claude-sonnet-4-6",
            fallbacks: ["claude-cli/claude-opus-4-6", "openai/gpt-5.2"],
          },
          models: {
            "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
            "claude-cli/claude-opus-4-6": { alias: "Opus" },
            "openai/gpt-5.2": {},
          },
        },
      },
    });
  });

  it("adds a Claude CLI default when no anthropic default is present", () => {
    const result = buildAnthropicCliMigrationResult({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.2" },
          models: {
            "openai/gpt-5.2": {},
          },
        },
      },
    });

    expect(result.defaultModel).toBe("claude-cli/claude-sonnet-4-6");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": {},
            "claude-cli/claude-sonnet-4-6": {},
          },
        },
      },
    });
  });
});
