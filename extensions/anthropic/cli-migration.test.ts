import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";

const { probeClaudeCliAuthStatus, runUtf8CommandWithTimeout } = vi.hoisted(() => ({
  probeClaudeCliAuthStatus: vi.fn(),
  runUtf8CommandWithTimeout: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importActual) => ({
  ...(await importActual<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  runUtf8CommandWithTimeout,
}));

vi.mock("./cli-auth-seam.js", async (importActual) => ({
  ...(await importActual<typeof import("./cli-auth-seam.js")>()),
  probeClaudeCliAuthStatus,
}));

const { buildAnthropicCliMigrationResult } = await import("./cli-migration.js");
const { resolveKnownAnthropicModelRef } = await import("./claude-model-refs.js");
const { createTestWizardPrompter, registerSingleProviderPlugin } =
  await import("openclaw/plugin-sdk/plugin-test-runtime");
const { default: anthropicPlugin } = await import("./index.js");

beforeEach(() => {
  probeClaudeCliAuthStatus.mockReset();
  probeClaudeCliAuthStatus.mockReturnValue({ status: "available" });
  runUtf8CommandWithTimeout.mockReset();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.doUnmock("./cli-auth-seam.js");
  vi.doUnmock("openclaw/plugin-sdk/process-runtime");
  vi.resetModules();
});

describe("anthropic Claude model refs", () => {
  it.each(["toString"])("leaves unknown alias %s unchanged", (ref) => {
    expect(resolveKnownAnthropicModelRef(ref)).toBe(ref);
  });
  it.each([
    ["claude-opus-4-5", "claude-opus-5-5"],
    ["claude-opus-4-5@anthropic:work", "claude-opus-5-5@anthropic:work"],
    ["claude-sonnet-4-20250514", "claude-sonnet-4-6"],
    ["claude-3-5-haiku-20241022", "claude-sonnet-4-6"],
    ...[
      "claude-opus-5-0",
      "claude-opus-4-10",
      "claude-sonnet-4-7",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5-20260901",
      "claude-haiku-4-5",
      "claude-haiku-4.5",
      "claude-haiku-4-5@anthropic:work",
    ].map((ref) => [ref, ref]),
  ])("resolves Anthropic model %s to %s", (from, to) => {
    expect(resolveKnownAnthropicModelRef(`anthropic/${from}`)).toBe(`anthropic/${to}`);
  });
});

async function resolveAnthropicCliAuthMethod() {
  const provider = await registerSingleProviderPlugin(anthropicPlugin);
  const method = provider.auth.find((entry) => entry.id === "cli");
  if (!method) {
    throw new Error("anthropic cli auth method missing");
  }
  return method;
}

type Config = ProviderAuthContext["config"];
type Defaults = NonNullable<NonNullable<Config["agents"]>["defaults"]>;
function modelConfig(model: Defaults["model"], models: Defaults["models"]) {
  return { agents: { defaults: { model, models } } };
}
function migrate(model: Defaults["model"], models: Defaults["models"]) {
  return buildAnthropicCliMigrationResult(modelConfig(model, models));
}

function cliModel(alias?: string, id = "claude-cli") {
  return { ...(alias ? { alias } : {}), agentRuntime: { id } };
}

function commonContext(config: Config) {
  return {
    config,
    opts: {},
    runtime: createRuntimeSpies(),
    agentDir: "/tmp/openclaw/agents/main",
    workspaceDir: "/tmp/openclaw/workspace",
  };
}

function authContext(config: Config = {}): ProviderAuthContext {
  return {
    ...commonContext(config),
    env: {},
    prompter: createTestWizardPrompter(),
    allowSecretRefPrompt: false,
    isRemote: false,
    openUrl: vi.fn(),
    oauth: { createVpsAwareHandlers: vi.fn() },
  };
}

function nonInteractiveContext(config: Config = {}): ProviderAuthMethodNonInteractiveContext {
  return {
    authChoice: "anthropic-cli",
    ...commonContext(config),
    baseConfig: config,
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(() => null),
  };
}

async function runNonInteractive(config: Config = {}) {
  const method = await resolveAnthropicCliAuthMethod();
  return method.runNonInteractive!(nonInteractiveContext(config));
}

async function useRealAuthProbe(termination: "timeout" | "exit") {
  const actual = await vi.importActual<typeof import("./cli-auth-seam.js")>("./cli-auth-seam.js");
  probeClaudeCliAuthStatus.mockImplementation(actual.probeClaudeCliAuthStatus);
  runUtf8CommandWithTimeout.mockResolvedValue({
    code: termination === "timeout" ? null : 0,
    termination,
    stdout: JSON.stringify({ loggedIn: true }),
  });
}

describe("anthropic cli migration", () => {
  it("keeps unknown Anthropic refs raw while still selecting Claude CLI", () => {
    const ref = "anthropic/opus-5.0";
    const result = migrate({ primary: ref }, { [ref]: { alias: "Future Opus" } });
    expect(result.defaultModel).toBe(ref);
    const defaults = result.configPatch.agents.defaults;
    expect(defaults.model).toBeUndefined();
    expect(defaults.models[ref]).toEqual(cliModel("Future Opus"));
    expect(defaults.models["anthropic/claude-opus-5-0"]).toBeUndefined();
  });

  it("does not treat bare non-Claude model refs as Anthropic", () => {
    const result = migrate({ primary: "gpt-5.2" }, { "openai/gpt-5.2": {} });

    expect(result.defaultModel).toBe("anthropic/claude-opus-5-5");
    expect(result.configPatch?.agents?.defaults?.model).toBeUndefined();
    expect(result.configPatch?.agents?.defaults?.models?.["anthropic/gpt-5.2"]).toBeUndefined();
  });

  it("writes migrated refs as own entries without invoking an inherited setter", () => {
    const convertedRef = "anthropic/claude-opus-4-7";
    const setter = vi.fn();
    const priorDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, convertedRef);
    try {
      Reflect.defineProperty(Object.prototype, convertedRef, {
        configurable: true,
        set: setter,
      });

      const result = migrate(
        { primary: "claude-cli/claude-opus-4-7" },
        { "claude-cli/claude-opus-4-7": { alias: "Opus" } },
      );

      const models = result.configPatch?.agents?.defaults?.models ?? {};
      expect(models[convertedRef]).toEqual(cliModel("Opus"));
      expect(Object.hasOwn(models, convertedRef)).toBe(true);
      expect(setter).not.toHaveBeenCalled();
    } finally {
      if (priorDescriptor) {
        Reflect.defineProperty(Object.prototype, convertedRef, priorDescriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, convertedRef);
      }
    }
  });

  it("preserves explicit model runtime policy while filling missing Claude CLI policies", () => {
    const result = migrate(
      { primary: "anthropic/claude-opus-4-7", fallbacks: ["anthropic/claude-sonnet-4-6"] },
      {
        "anthropic/claude-opus-4-7": cliModel("Opus", "openclaw"),
        "anthropic/claude-sonnet-4-6": cliModel("Sonnet", "auto"),
        "anthropic/*": { agentRuntime: { id: "openclaw" } },
      },
    );

    const defaults = result.configPatch?.agents?.defaults;
    expect(defaults?.models).toEqual({
      "anthropic/claude-opus-4-7": cliModel("Opus", "openclaw"),
      "anthropic/claude-sonnet-4-6": cliModel("Sonnet"),
      "anthropic/*": { agentRuntime: { id: "openclaw" } },
    });
  });

  it("registered cli auth reports a timeout with a retry step, not a logout", async () => {
    await useRealAuthProbe("timeout");
    const method = await resolveAnthropicCliAuthMethod();
    await expect(method.run(authContext())).rejects.toThrow(
      "Could not verify the installed Claude CLI login within 10 s.\n" +
        "Run claude auth status --json, then retry this setup.",
    );
  });

  it.each(["string", "legacy-collision"] as const)(
    "preserves primary and fallback aliases (%s model)",
    async (shape) => {
      const method = await resolveAnthropicCliAuthMethod();
      const primary = "oPuS@anthropic:work";
      const fallbacks = ["anthropic/backup", "team/fast", "sonnet"];
      const canonicalAlias = shape === "legacy-collision" ? "Canonical" : "Opus";
      const config = modelConfig(shape === "string" ? primary : { primary, fallbacks }, {
        "anthropic/claude-opus-5": { alias: canonicalAlias },
        ...(shape === "legacy-collision" ? { "claude-cli/claude-opus-5": { alias: "Opus" } } : {}),
        "anthropic/claude-opus-4-8": { alias: "Backup" },
        "openai/gpt-5.2": { alias: "team/fast" },
      });
      const interactive = await method.run(authContext(config));
      expect(interactive.profiles).toEqual([]);
      const nonInteractive = await method.runNonInteractive!(nonInteractiveContext(config));
      expect(interactive.defaultModel).toBe("anthropic/claude-opus-5@anthropic:work");
      const expectedModel = {
        primary: "anthropic/claude-opus-5@anthropic:work",
        ...(shape !== "string"
          ? { fallbacks: ["anthropic/claude-opus-4-8", "team/fast", "anthropic/claude-sonnet-5-5"] }
          : {}),
      };
      expect(
        interactive.configPatch?.agents?.defaults?.model ?? config.agents.defaults.model,
      ).toEqual(shape === "string" ? expectedModel.primary : expectedModel);
      expect(nonInteractive?.agents?.defaults?.model).toEqual(expectedModel);
      for (const models of [
        interactive.configPatch?.agents?.defaults?.models,
        nonInteractive?.agents?.defaults?.models,
      ]) {
        expect(models).toEqual(
          expect.objectContaining({
            "anthropic/claude-opus-5": cliModel(canonicalAlias),
            "anthropic/claude-opus-4-8": cliModel("Backup"),
            "openai/gpt-5.2": { alias: "team/fast" },
          }),
        );
      }
    },
  );

  it.each(["setup", "gateway"] as const)(
    "probes %s login without inherited provider credentials",
    async (source) => {
      await useRealAuthProbe("exit");
      vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/gateway-claude-work");
      vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-gateway-key");
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-gateway-token");
      const method = await resolveAnthropicCliAuthMethod();
      if (source === "setup") {
        const ctx = authContext();
        ctx.env = {
          CLAUDE_CONFIG_DIR: "/tmp/claude-work",
          ANTHROPIC_API_KEY: "synthetic-setup-key",
          CLAUDE_CODE_OAUTH_TOKEN: "synthetic-setup-token",
        };
        await method.run(ctx);
      } else {
        await method.runNonInteractive!(nonInteractiveContext());
      }

      expect(runUtf8CommandWithTimeout).toHaveBeenCalledTimes(1);
      const [command, options] = runUtf8CommandWithTimeout.mock.calls[0]!;
      expect(command).toEqual(["claude", "auth", "status", "--json"]);
      expect(options.baseEnv.CLAUDE_CONFIG_DIR).toBe(
        source === "setup" ? "/tmp/claude-work" : "/tmp/gateway-claude-work",
      );
      expect(options.baseEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(options.baseEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    },
  );

  it("registered non-interactive cli auth keeps anthropic fallbacks and selects claude-cli runtime", async () => {
    const config = modelConfig(
      {
        primary: "anthropic/claude-opus-4-7",
        fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
      },
      {
        "anthropic/claude-opus-4-7": { alias: "Opus" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "openai/gpt-5.2": {},
      },
    );

    const defaults = (await runNonInteractive(config))?.agents?.defaults;
    expect(defaults?.model).toMatchObject({
      primary: "anthropic/claude-opus-4-7",
      fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
    });
    expect(defaults?.models).toEqual({
      "anthropic/claude-opus-4-7": cliModel("Opus"),
      "anthropic/claude-opus-4-6": cliModel("Opus"),
      "anthropic/claude-opus-5": undefined,
      "anthropic/*": cliModel(),
      "openai/gpt-5.2": {},
    });
  });

  it("registered cli sign-in keeps selected IDs without seeding a static menu", async () => {
    const deprecatedRef = "anthropic/claude-opus-4-8";

    expect((await runNonInteractive())?.agents?.defaults?.models).toEqual({
      "anthropic/*": cliModel(),
      "anthropic/claude-opus-5-5": cliModel(),
    });

    const existing = await runNonInteractive(
      modelConfig({ primary: deprecatedRef }, { [deprecatedRef]: { alias: "Opus 4.8" } }),
    );
    expect(existing?.agents?.defaults?.model).toEqual({ primary: "anthropic/claude-opus-4-8" });
    expect(existing?.agents?.defaults?.models?.["anthropic/claude-opus-4-8"]).toEqual(
      cliModel("Opus 4.8"),
    );
  });

  it.each([
    [
      "missing",
      "Claude CLI is not authenticated on this host.\nRun claude auth login first, then re-run this setup.",
    ],
    [
      "unreadable",
      "Could not verify the installed Claude CLI login.\nRun claude auth status --json, then retry this setup.",
    ],
  ])("registered non-interactive cli auth propagates %s auth", async (status, message) => {
    probeClaudeCliAuthStatus.mockReturnValue({ status });
    const method = await resolveAnthropicCliAuthMethod();
    const ctx = nonInteractiveContext();
    await expect(method.runNonInteractive!(ctx)).rejects.toThrow(message);
    expect(ctx.runtime.error).not.toHaveBeenCalled();
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
  });
});
