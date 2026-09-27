// Anthropic tests cover cli migration plugin behavior.
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

vi.mock("./cli-auth-seam.js", async (importActual) => {
  const actual = await importActual<typeof import("./cli-auth-seam.js")>();
  return {
    ...actual,
    probeClaudeCliAuthStatus,
  };
});

const { buildAnthropicCliMigrationResult } = await import("./cli-migration.js");
const { resolveKnownAnthropicModelRef } = await import("./claude-model-refs.js");
const { createTestWizardPrompter, registerSingleProviderPlugin } =
  await import("openclaw/plugin-sdk/plugin-test-runtime");
const { default: anthropicPlugin } = await import("./index.js");

beforeEach(() => {
  probeClaudeCliAuthStatus.mockReset();
  runUtf8CommandWithTimeout.mockReset();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.doUnmock("./cli-auth-seam.js");
  vi.doUnmock("openclaw/plugin-sdk/process-runtime");
  vi.resetModules();
});

describe("anthropic Claude model refs", () => {
  it.each(["constructor", "__proto__", "toString"])("leaves unknown alias %s unchanged", (ref) => {
    expect(resolveKnownAnthropicModelRef(ref)).toBe(ref);
  });
  it("upgrades retired refs without rewriting future canonical refs", () => {
    expect(resolveKnownAnthropicModelRef("anthropic/claude-opus-4-5")).toBe(
      "anthropic/claude-opus-5-5",
    );
    expect(resolveKnownAnthropicModelRef("anthropic/claude-opus-4-5@anthropic:work")).toBe(
      "anthropic/claude-opus-5-5@anthropic:work",
    );
    expect(resolveKnownAnthropicModelRef("anthropic/claude-sonnet-4-20250514")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(resolveKnownAnthropicModelRef("anthropic/claude-opus-5-0")).toBe(
      "anthropic/claude-opus-5-0",
    );
    expect(resolveKnownAnthropicModelRef("anthropic/claude-opus-4-10")).toBe(
      "anthropic/claude-opus-4-10",
    );
    expect(resolveKnownAnthropicModelRef("anthropic/claude-sonnet-4-7")).toBe(
      "anthropic/claude-sonnet-4-7",
    );
    expect(resolveKnownAnthropicModelRef("anthropic/claude-haiku-4-5")).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("resolves the bare opus family alias to the current default Opus", () => {
    // Bare family aliases and retired-ref upgrades both land on the current
    // default Opus; only an explicitly pinned ref keeps its own target.
    expect(resolveKnownAnthropicModelRef("opus")).toBe("anthropic/claude-opus-5-5");
    expect(resolveKnownAnthropicModelRef("claude-cli/opus")).toBe("anthropic/claude-opus-5-5");
    expect(resolveKnownAnthropicModelRef("anthropic/claude-opus-4-5")).toBe(
      "anthropic/claude-opus-5-5",
    );
    expect(resolveKnownAnthropicModelRef("anthropic/claude-opus-4-8")).toBe(
      "anthropic/claude-opus-4-8",
    );
  });

  it.each([
    ["fable", "claude-fable-5-1"],
    ["fable-5.1", "claude-fable-5-1"],
    ["fable-5-1", "claude-fable-5-1"],
    ["claude-fable-5-1", "claude-fable-5-1"],
    ["fable-5", "claude-fable-5"],
    ["claude-fable-5", "claude-fable-5"],
  ])("canonicalizes %s without changing explicit Fable versions", (alias, modelId) => {
    for (const provider of ["", "anthropic/", "claude-cli/"]) {
      expect(resolveKnownAnthropicModelRef(`${provider}${alias}`)).toBe(`anthropic/${modelId}`);
    }
  });

  it("preserves the current claude-haiku-4-5 model and its bare alias", () => {
    // claude-haiku-4-5 is a current production model (not retired), so neither
    // its full ref, its dotted variant, nor the bare "haiku" family alias must
    // be rewritten to sonnet.
    expect(resolveKnownAnthropicModelRef("anthropic/claude-haiku-4-5")).toBe(
      "anthropic/claude-haiku-4-5",
    );
    expect(resolveKnownAnthropicModelRef("anthropic/claude-haiku-4.5")).toBe(
      "anthropic/claude-haiku-4.5",
    );
    expect(resolveKnownAnthropicModelRef("anthropic/claude-haiku-4-5@anthropic:work")).toBe(
      "anthropic/claude-haiku-4-5@anthropic:work",
    );
    // Genuinely retired Claude 3 Haiku still upgrades to the current sonnet.
    expect(resolveKnownAnthropicModelRef("anthropic/claude-3-5-haiku-20241022")).toBe(
      "anthropic/claude-sonnet-4-6",
    );
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
    runtime: createRuntimeSpies(),
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
    runtime: createRuntimeSpies(),
    agentDir: "/tmp/openclaw/agents/main",
    workspaceDir: "/tmp/openclaw/workspace",
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(() => null),
  };
}

describe("anthropic cli migration", () => {
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

    expect(result.profiles).toStrictEqual([]);
    expect(result.defaultModel).toBe("anthropic/claude-opus-4-7");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
          },
          models: {
            "anthropic/claude-opus-4-7": {
              alias: "Opus",
              agentRuntime: { id: "claude-cli" },
            },
            "anthropic/claude-opus-4-6": {
              alias: "Opus",
              agentRuntime: { id: "claude-cli" },
            },
            "openai/gpt-5.2": {},
            "anthropic/claude-opus-5-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-sonnet-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-fable-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-fable-5-1": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    });
  });

  it("routes provider-qualified shorthand refs through Claude CLI without dropping the raw ref", () => {
    const result = buildAnthropicCliMigrationResult({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/opus-4.7",
            fallbacks: ["anthropic/sonnet-4.6", "openai/gpt-5.2"],
          },
          models: {
            "anthropic/opus-4.7": { alias: "Opus shorthand" },
            "anthropic/sonnet-4.6": { alias: "Sonnet shorthand" },
          },
        },
      },
    });

    const defaults = result.configPatch?.agents?.defaults;
    expect(defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-7",
      fallbacks: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.2"],
    });
    expect(defaults?.models?.["anthropic/opus-4.7"]).toEqual({
      alias: "Opus shorthand",
      agentRuntime: { id: "claude-cli" },
    });
    expect(defaults?.models?.["anthropic/claude-opus-4-7"]).toEqual({
      alias: "Opus shorthand",
      agentRuntime: { id: "claude-cli" },
    });
    expect(defaults?.models?.["anthropic/sonnet-4.6"]).toEqual({
      alias: "Sonnet shorthand",
      agentRuntime: { id: "claude-cli" },
    });
    expect(defaults?.models?.["anthropic/claude-sonnet-4-6"]).toEqual({
      alias: "Sonnet shorthand",
      agentRuntime: { id: "claude-cli" },
    });
  });

  it("keeps unknown Anthropic refs raw while still selecting Claude CLI", () => {
    const result = buildAnthropicCliMigrationResult({
      agents: {
        defaults: {
          model: { primary: "anthropic/opus-5.0" },
          models: {
            "anthropic/opus-5.0": { alias: "Future Opus" },
          },
        },
      },
    });

    const defaults = result.configPatch?.agents?.defaults;
    expect(result.defaultModel).toBe("anthropic/opus-5.0");
    expect(defaults?.model).toBeUndefined();
    expect(defaults?.models?.["anthropic/opus-5.0"]).toEqual({
      alias: "Future Opus",
      agentRuntime: { id: "claude-cli" },
    });
    expect(defaults?.models?.["anthropic/claude-opus-5-0"]).toBeUndefined();
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

    expect(result.defaultModel).toBe("anthropic/claude-opus-5-5");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": {},
            "anthropic/claude-opus-5-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-sonnet-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-fable-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-fable-5-1": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    });
  });

  it("does not treat bare non-Claude model refs as Anthropic", () => {
    const result = buildAnthropicCliMigrationResult({
      agents: {
        defaults: {
          model: { primary: "gpt-5.2" },
          models: {
            "openai/gpt-5.2": {},
          },
        },
      },
    });

    expect(result.defaultModel).toBe("anthropic/claude-opus-5-5");
    expect(result.configPatch?.agents?.defaults?.model).toBeUndefined();
    expect(result.configPatch?.agents?.defaults?.models?.["anthropic/gpt-5.2"]).toBeUndefined();
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
          models: {
            "anthropic/claude-opus-5-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-sonnet-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-fable-5": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-fable-5-1": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    });
  });

  it.each([
    {
      descriptor: {
        value: { inherited: true },
        writable: true,
      },
      name: "writable data descriptor",
    },
    {
      descriptor: {
        value: { inherited: true },
        writable: false,
      },
      name: "non-writable data descriptor",
    },
    {
      descriptor: {
        get: () => ({ inherited: true }),
      },
      name: "getter-only accessor",
    },
  ])("writes migrated refs as own entries over an inherited $name", ({ descriptor }) => {
    // Process-global prototype pollution can expose a converted ref. The
    // migration must write the converted entry as an own property without
    // invoking inherited getters/setters or throwing on non-writable descriptors.
    const convertedRef = "anthropic/claude-opus-4-7";
    const priorDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, convertedRef);
    try {
      Reflect.defineProperty(Object.prototype, convertedRef, {
        configurable: true,
        ...descriptor,
      });

      const result = buildAnthropicCliMigrationResult({
        agents: {
          defaults: {
            model: { primary: "claude-cli/claude-opus-4-7" },
            models: {
              "claude-cli/claude-opus-4-7": { alias: "Opus" },
            },
          },
        },
      });

      const models = result.configPatch?.agents?.defaults?.models ?? {};
      const migrated = models[convertedRef];
      expect(migrated).toEqual({ alias: "Opus", agentRuntime: { id: "claude-cli" } });
      expect(Object.hasOwn(models, convertedRef)).toBe(true);
    } finally {
      if (priorDescriptor) {
        Reflect.defineProperty(Object.prototype, convertedRef, priorDescriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, convertedRef);
      }
    }
  });

  it("writes migrated refs as own entries without invoking an inherited setter", () => {
    const convertedRef = "anthropic/claude-opus-4-7";
    let setterCalled = false;
    const priorDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, convertedRef);
    try {
      Reflect.defineProperty(Object.prototype, convertedRef, {
        configurable: true,
        set: () => {
          setterCalled = true;
        },
      });

      const result = buildAnthropicCliMigrationResult({
        agents: {
          defaults: {
            model: { primary: "claude-cli/claude-opus-4-7" },
            models: {
              "claude-cli/claude-opus-4-7": { alias: "Opus" },
            },
          },
        },
      });

      const models = result.configPatch?.agents?.defaults?.models ?? {};
      const migrated = models[convertedRef];
      expect(migrated).toEqual({ alias: "Opus", agentRuntime: { id: "claude-cli" } });
      expect(Object.hasOwn(models, convertedRef)).toBe(true);
      expect(setterCalled).toBe(false);
    } finally {
      if (priorDescriptor) {
        Reflect.defineProperty(Object.prototype, convertedRef, priorDescriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, convertedRef);
      }
    }
  });

  it("preserves explicit model runtime policy while filling missing Claude CLI policies", () => {
    const result = buildAnthropicCliMigrationResult({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
          models: {
            "anthropic/claude-opus-4-7": {
              alias: "Opus",
              agentRuntime: { id: "openclaw" },
            },
            "anthropic/claude-sonnet-4-6": {
              alias: "Sonnet",
              agentRuntime: { id: "auto" },
            },
          },
        },
      },
    });

    const defaults = result.configPatch?.agents?.defaults;
    if (!defaults) {
      throw new Error("Expected Claude CLI migration to return default agent config");
    }

    expect(defaults.models?.["anthropic/claude-opus-4-7"]).toEqual({
      alias: "Opus",
      agentRuntime: { id: "openclaw" },
    });
    expect(defaults.models?.["anthropic/claude-sonnet-4-6"]).toEqual({
      alias: "Sonnet",
      agentRuntime: { id: "claude-cli" },
    });
  });

  it("registered cli auth tells users to run claude auth login when local auth is missing", async () => {
    probeClaudeCliAuthStatus.mockReturnValue({ status: "missing" });
    const method = await resolveAnthropicCliAuthMethod();

    await expect(method.run(createProviderAuthContext())).rejects.toThrow(
      [
        "Claude CLI is not authenticated on this host.",
        "Run claude auth login first, then re-run this setup.",
      ].join("\n"),
    );
  });

  it.each(["object", "string", "legacy-collision"] as const)(
    "registered CLI setup preserves authored primary and fallback aliases (%s model)",
    async (shape) => {
      probeClaudeCliAuthStatus.mockReturnValue({ status: "available" });
      const method = await resolveAnthropicCliAuthMethod();
      const primary = "oPuS@anthropic:work";
      const fallbacks = ["anthropic/backup", "team/fast", "sonnet"];
      const config = {
        agents: {
          defaults: {
            model: shape === "string" ? primary : { primary, fallbacks },
            models: {
              "anthropic/claude-opus-5": {
                alias: shape === "legacy-collision" ? "Canonical" : "Opus",
              },
              ...(shape === "legacy-collision"
                ? { "claude-cli/claude-opus-5": { alias: "Opus" } }
                : {}),
              "anthropic/claude-opus-4-8": { alias: "Backup" },
              "openai/gpt-5.2": { alias: "team/fast" },
            },
          },
        },
      };
      const interactive = await method.run(createProviderAuthContext(config));
      const nonInteractive = await method.runNonInteractive!(
        createProviderAuthMethodNonInteractiveContext(config),
      );
      expect(interactive.defaultModel).toBe("anthropic/claude-opus-5@anthropic:work");
      const expectedModel = {
        primary: "anthropic/claude-opus-5@anthropic:work",
        ...(shape !== "string"
          ? { fallbacks: ["anthropic/claude-opus-4-8", "team/fast", "anthropic/claude-sonnet-5"] }
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
        expect(models?.["anthropic/claude-opus-5"]).toEqual({
          alias: shape === "legacy-collision" ? "Canonical" : "Opus",
          agentRuntime: { id: "claude-cli" },
        });
        expect(models?.["anthropic/claude-opus-4-8"]).toEqual({
          alias: "Backup",
          agentRuntime: { id: "claude-cli" },
        });
        expect(models?.["openai/gpt-5.2"]).toEqual({ alias: "team/fast" });
      }
    },
  );

  it.each(["setup", "gateway"] as const)(
    "probes the %s native login without forwarding inherited provider credentials",
    async (source) => {
      const actual =
        await vi.importActual<typeof import("./cli-auth-seam.js")>("./cli-auth-seam.js");
      probeClaudeCliAuthStatus.mockImplementation(actual.probeClaudeCliAuthStatus);
      runUtf8CommandWithTimeout.mockResolvedValue({
        code: 0,
        termination: "exit",
        stdout: JSON.stringify({ loggedIn: true }),
      });
      vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/gateway-claude-work");
      vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-gateway-key");
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-gateway-token");
      const method = await resolveAnthropicCliAuthMethod();
      if (source === "setup") {
        const ctx = createProviderAuthContext();
        ctx.env = {
          CLAUDE_CONFIG_DIR: "/tmp/claude-work",
          ANTHROPIC_API_KEY: "synthetic-setup-key",
          CLAUDE_CODE_OAUTH_TOKEN: "synthetic-setup-token",
        };
        await method.run(ctx);
      } else {
        await method.runNonInteractive!(createProviderAuthMethodNonInteractiveContext());
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

  it("does not copy native Claude credentials into OpenClaw", () => {
    const result = buildAnthropicCliMigrationResult({});
    expect(result.profiles).toEqual([]);
  });

  it("registered non-interactive cli auth keeps anthropic fallbacks and selects claude-cli runtime", async () => {
    probeClaudeCliAuthStatus.mockReturnValue({ status: "available" });
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

    const result = await method.runNonInteractive?.(
      createProviderAuthMethodNonInteractiveContext(config),
    );
    const defaults = result?.agents?.defaults as
      | {
          model?: { primary?: string; fallbacks?: string[] };
          models?: Record<string, unknown>;
        }
      | undefined;
    expect(defaults?.model?.primary).toBe("anthropic/claude-opus-4-7");
    expect(defaults?.model?.fallbacks).toEqual(["anthropic/claude-opus-4-6", "openai/gpt-5.2"]);
    expect(defaults?.models?.["anthropic/claude-opus-4-7"]).toEqual({
      alias: "Opus",
      agentRuntime: { id: "claude-cli" },
    });
    expect(defaults?.models?.["anthropic/claude-opus-4-6"]).toEqual({
      alias: "Opus",
      agentRuntime: { id: "claude-cli" },
    });
    expect(defaults?.models?.["anthropic/claude-opus-5"]).toEqual({
      agentRuntime: { id: "claude-cli" },
    });
    expect(defaults?.models?.["anthropic/claude-opus-4-8"]).toEqual({
      agentRuntime: { id: "claude-cli" },
    });
    expect(defaults?.models?.["openai/gpt-5.2"]).toEqual({});
  });

  it("registered non-interactive cli auth reports missing local auth and exits cleanly", async () => {
    probeClaudeCliAuthStatus.mockReturnValue({ status: "missing" });
    const method = await resolveAnthropicCliAuthMethod();
    const ctx = createProviderAuthMethodNonInteractiveContext();

    await expect(method.runNonInteractive?.(ctx)).resolves.toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      [
        'Auth choice "anthropic-cli" requires Claude CLI auth on this host.',
        "Run claude auth login first.",
      ].join("\n"),
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("registered non-interactive cli auth reports stored credentials that need interaction", async () => {
    probeClaudeCliAuthStatus.mockReturnValue({ status: "unreadable" });
    const method = await resolveAnthropicCliAuthMethod();
    const ctx = createProviderAuthMethodNonInteractiveContext();

    await expect(method.runNonInteractive?.(ctx)).resolves.toBeNull();
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      [
        'Auth choice "anthropic-cli" could not verify the installed Claude CLI login.',
        "Run claude auth status, then retry.",
      ].join("\n"),
    );
    expect(ctx.runtime.exit).toHaveBeenCalledWith(1);
  });
});
