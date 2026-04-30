import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  readClaudeCliCredentialsForSetup,
  readClaudeCliCredentialsForSetupNonInteractive,
  ensureClaudeCliInstalled,
  runClaudeCliLogin,
} = vi.hoisted(() => ({
  readClaudeCliCredentialsForSetup: vi.fn(),
  readClaudeCliCredentialsForSetupNonInteractive: vi.fn(),
  ensureClaudeCliInstalled: vi.fn(async () => ({ ok: true as const })),
  runClaudeCliLogin: vi.fn(() => true),
}));

vi.mock("./cli-auth-seam.js", async (importActual) => {
  const actual = await importActual<typeof import("./cli-auth-seam.js")>();
  return {
    ...actual,
    readClaudeCliCredentialsForSetup,
    readClaudeCliCredentialsForSetupNonInteractive,
  };
});

vi.mock("./cli-install.js", async (importActual) => {
  const actual = await importActual<typeof import("./cli-install.js")>();
  return {
    ...actual,
    ensureClaudeCliInstalled,
    runClaudeCliLogin,
  };
});

const { buildAnthropicCliMigrationResult, hasClaudeCliAuth } = await import("./cli-migration.js");
const { createTestWizardPrompter, registerSingleProviderPlugin } =
  await import("openclaw/plugin-sdk/plugin-test-runtime");
const { default: anthropicPlugin } = await import("./index.js");

async function resolveAnthropicCliAuthMethod() {
  const provider = await registerSingleProviderPlugin(anthropicPlugin);
  const method = provider.auth.find((entry) => entry.id === "cli");
  if (!method) {
    throw new Error("anthropic cli auth method missing");
  }
  return method;
}

function createProviderAuthContext(
  config: ProviderAuthContext["config"] = {},
): ProviderAuthContext {
  return {
    config,
    opts: {},
    env: {},
    agentDir: "/tmp/openclaw/agents/main",
    workspaceDir: "/tmp/openclaw/workspace",
    prompter: createTestWizardPrompter(),
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    allowSecretRefPrompt: false,
    isRemote: false,
    openUrl: vi.fn(),
    oauth: {
      createVpsAwareHandlers: vi.fn(),
    },
  };
}

function createProviderAuthMethodNonInteractiveContext(
  config: ProviderAuthMethodNonInteractiveContext["config"] = {},
): ProviderAuthMethodNonInteractiveContext {
  return {
    authChoice: "anthropic-cli",
    config,
    baseConfig: config,
    opts: {},
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    agentDir: "/tmp/openclaw/agents/main",
    workspaceDir: "/tmp/openclaw/workspace",
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(() => null),
  };
}

describe("anthropic cli migration", () => {
  beforeEach(() => {
    ensureClaudeCliInstalled.mockReset();
    ensureClaudeCliInstalled.mockResolvedValue({ ok: true });
    runClaudeCliLogin.mockReset();
    runClaudeCliLogin.mockReturnValue(true);
    readClaudeCliCredentialsForSetup.mockReset();
    readClaudeCliCredentialsForSetupNonInteractive.mockReset();
  });

  it("detects local Claude CLI auth", () => {
    readClaudeCliCredentialsForSetup.mockReturnValue({ type: "oauth" });

    expect(hasClaudeCliAuth()).toBe(true);
  });

  it("uses the non-interactive Claude auth probe without keychain prompts", () => {
    readClaudeCliCredentialsForSetup.mockReset();
    readClaudeCliCredentialsForSetupNonInteractive.mockReset();
    readClaudeCliCredentialsForSetup.mockReturnValue(null);
    readClaudeCliCredentialsForSetupNonInteractive.mockReturnValue({ type: "oauth" });

    expect(hasClaudeCliAuth({ allowKeychainPrompt: false })).toBe(true);
    expect(readClaudeCliCredentialsForSetup).not.toHaveBeenCalled();
    expect(readClaudeCliCredentialsForSetupNonInteractive).toHaveBeenCalledTimes(1);
  });

  it("keeps anthropic defaults and selects the claude-cli runtime", () => {
    const result = buildAnthropicCliMigrationResult({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-opus-4-7": { alias: "Opus" },
            "anthropic/claude-opus-4-6": { alias: "Opus" },
            "openai/gpt-5.2": {},
          },
        },
      },
    });

    expect(result.profiles).toEqual([]);
    expect(result.defaultModel).toBe("anthropic/claude-opus-4-7");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
          },
          agentRuntime: { id: "claude-cli" },
          models: {
            "anthropic/claude-opus-4-7": { alias: "Opus" },
            "anthropic/claude-sonnet-4-6": {},
            "anthropic/claude-opus-4-6": { alias: "Opus" },
            "anthropic/claude-opus-4-5": {},
            "anthropic/claude-sonnet-4-5": {},
            "anthropic/claude-haiku-4-5": {},
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

    expect(result.defaultModel).toBe("anthropic/claude-opus-4-7");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          agentRuntime: { id: "claude-cli" },
          models: {
            "openai/gpt-5.2": {},
            "anthropic/claude-opus-4-7": {},
            "anthropic/claude-sonnet-4-6": {},
            "anthropic/claude-opus-4-6": {},
            "anthropic/claude-opus-4-5": {},
            "anthropic/claude-sonnet-4-5": {},
            "anthropic/claude-haiku-4-5": {},
          },
        },
      },
    });
  });

  it("backfills the Claude CLI allowlist when older configs only stored sonnet", () => {
    const result = buildAnthropicCliMigrationResult({
      agents: {
        defaults: {
          model: { primary: "claude-cli/claude-opus-4-7" },
          models: {
            "claude-cli/claude-opus-4-7": {},
          },
        },
      },
    });

    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          agentRuntime: { id: "claude-cli" },
          models: {
            "anthropic/claude-opus-4-7": {},
            "anthropic/claude-sonnet-4-6": {},
            "anthropic/claude-opus-4-6": {},
            "anthropic/claude-opus-4-5": {},
            "anthropic/claude-sonnet-4-5": {},
            "anthropic/claude-haiku-4-5": {},
          },
        },
      },
    });
  });

  it("registered cli auth blocks setup when Claude CLI install was declined", async () => {
    readClaudeCliCredentialsForSetup.mockReturnValue(null);
    ensureClaudeCliInstalled.mockResolvedValueOnce({
      ok: false,
      reason: "Claude CLI install was declined.",
    });
    const method = await resolveAnthropicCliAuthMethod();

    await expect(method.run(createProviderAuthContext())).rejects.toThrow(
      "Claude CLI install was declined.",
    );
  });

  it("registered cli auth offers to run claude /login when CLI is installed but signed out", async () => {
    readClaudeCliCredentialsForSetup.mockReturnValueOnce(null);
    readClaudeCliCredentialsForSetup.mockReturnValueOnce({
      type: "oauth",
      provider: "anthropic",
      access: "after-login-access",
      refresh: "after-login-refresh",
      expires: Date.now() + 60_000,
    });
    ensureClaudeCliInstalled.mockResolvedValueOnce({ ok: true });
    runClaudeCliLogin.mockReturnValueOnce(true);
    const method = await resolveAnthropicCliAuthMethod();
    const ctx = createProviderAuthContext();
    ctx.prompter = createTestWizardPrompter({ confirm: vi.fn(async () => true) });

    const result = await method.run(ctx);

    expect(runClaudeCliLogin).toHaveBeenCalledTimes(1);
    expect(result.profiles?.[0]?.credential).toMatchObject({
      type: "oauth",
      access: "after-login-access",
    });
  });

  it("registered cli auth fails clearly when sign-in is declined", async () => {
    readClaudeCliCredentialsForSetup.mockReturnValue(null);
    ensureClaudeCliInstalled.mockResolvedValueOnce({ ok: true });
    const method = await resolveAnthropicCliAuthMethod();
    const ctx = createProviderAuthContext();
    ctx.prompter = createTestWizardPrompter({ confirm: vi.fn(async () => false) });

    await expect(method.run(ctx)).rejects.toThrow(/Claude CLI sign-in was declined/);
    expect(runClaudeCliLogin).not.toHaveBeenCalled();
  });

  it("registered cli auth returns the same migration result as the builder", async () => {
    const credential = {
      type: "oauth",
      provider: "anthropic",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    } as const;
    readClaudeCliCredentialsForSetup.mockReturnValue(credential);
    const method = await resolveAnthropicCliAuthMethod();
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-opus-4-7": { alias: "Opus" },
            "anthropic/claude-opus-4-6": { alias: "Opus" },
            "openai/gpt-5.2": {},
          },
        },
      },
    };

    await expect(method.run(createProviderAuthContext(config))).resolves.toEqual(
      buildAnthropicCliMigrationResult(config, credential),
    );
  });

  it("stores a claude-cli oauth profile when Claude CLI credentials are available", () => {
    const result = buildAnthropicCliMigrationResult(
      {},
      {
        type: "oauth",
        provider: "anthropic",
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
      },
    );

    expect(result.profiles).toEqual([
      {
        profileId: "anthropic:claude-cli",
        credential: {
          type: "oauth",
          provider: "claude-cli",
          access: "access-token",
          refresh: "refresh-token",
          expires: 123,
        },
      },
    ]);
  });

  it("stores a claude-cli token profile when Claude CLI only exposes a bearer token", () => {
    const result = buildAnthropicCliMigrationResult(
      {},
      {
        type: "token",
        provider: "anthropic",
        token: "bearer-token",
        expires: 123,
      },
    );

    expect(result.profiles).toEqual([
      {
        profileId: "anthropic:claude-cli",
        credential: {
          type: "token",
          provider: "claude-cli",
          token: "bearer-token",
          expires: 123,
        },
      },
    ]);
  });

  it("registered non-interactive cli auth keeps anthropic fallbacks and selects claude-cli runtime", async () => {
    readClaudeCliCredentialsForSetupNonInteractive.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    const method = await resolveAnthropicCliAuthMethod();
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-opus-4-7": { alias: "Opus" },
            "anthropic/claude-opus-4-6": { alias: "Opus" },
            "openai/gpt-5.2": {},
          },
        },
      },
    };

    await expect(
      method.runNonInteractive?.(createProviderAuthMethodNonInteractiveContext(config)),
    ).resolves.toMatchObject({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
          },
          agentRuntime: { id: "claude-cli" },
          models: {
            "anthropic/claude-opus-4-7": { alias: "Opus" },
            "anthropic/claude-opus-4-6": { alias: "Opus" },
            "openai/gpt-5.2": {},
          },
        },
      },
    });
  });

  it("registered non-interactive cli auth reports missing local auth and exits cleanly", async () => {
    readClaudeCliCredentialsForSetupNonInteractive.mockReturnValue(null);
    const method = await resolveAnthropicCliAuthMethod();
    const ctx = createProviderAuthMethodNonInteractiveContext();

    await expect(method.runNonInteractive?.(ctx)).resolves.toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      [
        'Auth choice "anthropic-cli" requires Claude CLI installed and signed in on this host.',
        "Install Claude CLI: npm install -g @anthropic-ai/claude-code",
        "Then sign in: claude /login",
      ].join("\n"),
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });
});
