import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnsureGeminiCliReadyResult } from "./cli-install.js";

const {
  readGeminiCliCredentialsForSetup,
  readGeminiCliCredentialsForSetupNonInteractive,
  ensureGeminiCliInstalled,
  runGeminiCliLogin,
} = vi.hoisted(() => ({
  readGeminiCliCredentialsForSetup: vi.fn(),
  readGeminiCliCredentialsForSetupNonInteractive: vi.fn(),
  ensureGeminiCliInstalled: vi.fn(
    async (): Promise<EnsureGeminiCliReadyResult> => ({ ok: true }),
  ),
  runGeminiCliLogin: vi.fn(() => true),
}));

vi.mock("./cli-auth-seam.js", async (importActual) => {
  const actual = await importActual<typeof import("./cli-auth-seam.js")>();
  return {
    ...actual,
    readGeminiCliCredentialsForSetup,
    readGeminiCliCredentialsForSetupNonInteractive,
  };
});

vi.mock("./cli-install.js", async (importActual) => {
  const actual = await importActual<typeof import("./cli-install.js")>();
  return {
    ...actual,
    ensureGeminiCliInstalled,
    runGeminiCliLogin,
  };
});

const { buildGoogleGeminiCliMigrationResult, hasGeminiCliAuth } = await import(
  "./cli-migration.js"
);
const { createTestWizardPrompter, registerProviderPlugin, requireRegisteredProvider } =
  await import("openclaw/plugin-sdk/plugin-test-runtime");
const { default: googlePlugin } = await import("./index.js");

async function resolveGoogleGeminiCliAuthMethod() {
  const { providers } = await registerProviderPlugin({
    plugin: googlePlugin,
    id: "google",
    name: "Google Provider",
  });
  const provider = requireRegisteredProvider(providers, "google-gemini-cli");
  const method = provider.auth.find((entry) => entry.id === "cli");
  if (!method) {
    throw new Error("google-gemini-cli `cli` auth method missing");
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
    authChoice: "google-gemini-subscription",
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

describe("google gemini cli migration", () => {
  beforeEach(() => {
    ensureGeminiCliInstalled.mockReset();
    ensureGeminiCliInstalled.mockResolvedValue({ ok: true });
    runGeminiCliLogin.mockReset();
    runGeminiCliLogin.mockReturnValue(true);
    readGeminiCliCredentialsForSetup.mockReset();
    readGeminiCliCredentialsForSetupNonInteractive.mockReset();
  });

  it("detects local Gemini CLI auth", () => {
    readGeminiCliCredentialsForSetup.mockReturnValue({ type: "oauth" });

    expect(hasGeminiCliAuth()).toBe(true);
  });

  it("seeds the Gemini CLI allowlist and selects the runtime", () => {
    const result = buildGoogleGeminiCliMigrationResult({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.2" },
          models: { "openai/gpt-5.2": {} },
        },
      },
    });

    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
    expect(result.configPatch).toMatchObject({
      agents: {
        defaults: {
          agentRuntime: { id: "google-gemini-cli" },
          models: {
            "openai/gpt-5.2": {},
            "google/gemini-3.1-pro-preview": {},
            "google/gemini-3.1-flash-preview": {},
            "google/gemini-3.1-flash-lite-preview": {},
            "google/gemini-3-pro-preview": {},
            "google/gemini-3-flash-preview": {},
          },
        },
      },
    });
  });

  it("blocks setup when Gemini CLI install was declined", async () => {
    readGeminiCliCredentialsForSetup.mockReturnValue(null);
    ensureGeminiCliInstalled.mockResolvedValueOnce({
      ok: false,
      reason: "Gemini CLI install was declined.",
    });
    const method = await resolveGoogleGeminiCliAuthMethod();

    await expect(method.run(createProviderAuthContext())).rejects.toThrow(
      "Gemini CLI install was declined.",
    );
  });

  it("offers to launch the gemini sign-in flow when CLI is installed but signed out", async () => {
    readGeminiCliCredentialsForSetup.mockReturnValueOnce(null);
    readGeminiCliCredentialsForSetup.mockReturnValueOnce({
      type: "oauth",
      provider: "google-gemini-cli",
      access: "after-login-access",
      refresh: "after-login-refresh",
      expires: Date.now() + 60_000,
    });
    ensureGeminiCliInstalled.mockResolvedValueOnce({ ok: true });
    runGeminiCliLogin.mockReturnValueOnce(true);
    const method = await resolveGoogleGeminiCliAuthMethod();
    const ctx = createProviderAuthContext();
    ctx.prompter = createTestWizardPrompter({ confirm: vi.fn(async () => true) });

    const result = await method.run(ctx);

    expect(runGeminiCliLogin).toHaveBeenCalledTimes(1);
    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
  });

  it("fails clearly when sign-in is declined", async () => {
    readGeminiCliCredentialsForSetup.mockReturnValue(null);
    ensureGeminiCliInstalled.mockResolvedValueOnce({ ok: true });
    const method = await resolveGoogleGeminiCliAuthMethod();
    const ctx = createProviderAuthContext();
    ctx.prompter = createTestWizardPrompter({ confirm: vi.fn(async () => false) });

    await expect(method.run(ctx)).rejects.toThrow(/Gemini CLI sign-in was declined/);
    expect(runGeminiCliLogin).not.toHaveBeenCalled();
  });

  it("non-interactive auth reports missing local auth and exits cleanly", async () => {
    readGeminiCliCredentialsForSetupNonInteractive.mockReturnValue(null);
    const method = await resolveGoogleGeminiCliAuthMethod();
    const ctx = createProviderAuthMethodNonInteractiveContext();

    await expect(method.runNonInteractive?.(ctx)).resolves.toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("requires Gemini CLI installed and signed in"),
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });
});
