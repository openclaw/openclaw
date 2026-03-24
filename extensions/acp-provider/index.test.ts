import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAcpAgentConfig } from "./acp-stream-bridge.js";

describe("ACP provider", () => {
  // ── resolveAcpAgentConfig ─────────────────────────────────────────────

  describe("resolveAcpAgentConfig", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("returns defaults when no config is provided", () => {
      delete process.env.ACP_COMMAND;
      delete process.env.ACP_ARGS;
      delete process.env.ACP_CWD;
      delete process.env.ACP_PERSIST_SESSION;

      const config = resolveAcpAgentConfig();
      expect(config.command).toBe("gemini");
      expect(config.args).toEqual(["--experimental-acp"]);
      expect(config.persistSession).toBe(false);
    });

    it("uses extraParams.acpCommand when provided", () => {
      const config = resolveAcpAgentConfig({ acpCommand: "claude-agent-acp" });
      expect(config.command).toBe("claude-agent-acp");
    });

    it("uses extraParams.acpArgs array when provided", () => {
      const config = resolveAcpAgentConfig({ acpArgs: ["--flag1", "--flag2"] });
      expect(config.args).toEqual(["--flag1", "--flag2"]);
    });

    it("uses extraParams.acpPersistSession boolean", () => {
      const config = resolveAcpAgentConfig({ acpPersistSession: true });
      expect(config.persistSession).toBe(true);
    });

    it("uses extraParams.acpCwd when provided", () => {
      const config = resolveAcpAgentConfig({ acpCwd: "/some/dir" });
      expect(config.cwd).toBe("/some/dir");
    });

    it("prefers extraParams over env vars", () => {
      process.env.ACP_COMMAND = "env-command";
      process.env.ACP_ARGS = "--env-flag";
      process.env.ACP_CWD = "/env/dir";

      const config = resolveAcpAgentConfig({
        acpCommand: "param-command",
        acpArgs: ["--param-flag"],
        acpCwd: "/param/dir",
      });

      expect(config.command).toBe("param-command");
      expect(config.args).toEqual(["--param-flag"]);
      expect(config.cwd).toBe("/param/dir");
    });

    it("falls back to env vars when extraParams are empty", () => {
      process.env.ACP_COMMAND = "codex";
      process.env.ACP_ARGS = "--interactive --verbose";
      process.env.ACP_CWD = "/workspace";
      process.env.ACP_PERSIST_SESSION = "1";

      const config = resolveAcpAgentConfig({});

      expect(config.command).toBe("codex");
      expect(config.args).toEqual(["--interactive", "--verbose"]);
      expect(config.cwd).toBe("/workspace");
      expect(config.persistSession).toBe(true);
    });

    it("trims whitespace from env and param strings", () => {
      process.env.ACP_COMMAND = "  gemini  ";

      const config = resolveAcpAgentConfig();
      expect(config.command).toBe("gemini");
    });

    it("handles undefined extraParams gracefully", () => {
      const config = resolveAcpAgentConfig(undefined);
      expect(config.command).toBe("gemini");
      expect(config.args).toEqual(["--experimental-acp"]);
    });

    it("handles non-string acpCommand gracefully", () => {
      const config = resolveAcpAgentConfig({ acpCommand: 123 as unknown });
      // Should fall back to env or default
      expect(config.command).toBe("gemini");
    });

    it("handles non-array acpArgs gracefully", () => {
      const config = resolveAcpAgentConfig({ acpArgs: "not-an-array" as unknown });
      // Should fall back to env or default
      expect(config.args).toEqual(["--experimental-acp"]);
    });
  });

  // ── Plugin registration ───────────────────────────────────────────────

  describe("plugin registration", () => {
    it("exports a valid plugin entry", async () => {
      const plugin = await import("./index.js");
      const entry = plugin.default;
      expect(entry.id).toBe("acp-provider");
      expect(entry.name).toBe("ACP Provider");
      expect(typeof entry.register).toBe("function");
    });

    it("registers an acp provider via the api", async () => {
      const plugin = await import("./index.js");
      const captured: { id: string; label: string }[] = [];
      const mockApi = {
        registerProvider: (provider: { id: string; label: string }) => {
          captured.push(provider);
        },
      };
      plugin.default.register(mockApi as never);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.id).toBe("acp");
      expect(captured[0]!.label).toBe("ACP");
    });

    it("provides expected env vars", async () => {
      const plugin = await import("./index.js");
      let capturedProvider: { envVars: string[] } | undefined;
      const mockApi = {
        registerProvider: (provider: { envVars: string[] }) => {
          capturedProvider = provider;
        },
      };
      plugin.default.register(mockApi as never);
      expect(capturedProvider!.envVars).toEqual(["ACP_COMMAND", "ACP_ARGS", "ACP_CWD"]);
    });

    it("has custom auth method", async () => {
      const plugin = await import("./index.js");
      let capturedProvider: { auth: { id: string; kind: string }[] } | undefined;
      const mockApi = {
        registerProvider: (provider: { auth: { id: string; kind: string }[] }) => {
          capturedProvider = provider;
        },
      };
      plugin.default.register(mockApi as never);
      expect(capturedProvider!.auth).toHaveLength(1);
      expect(capturedProvider!.auth[0]!.id).toBe("custom");
      expect(capturedProvider!.auth[0]!.kind).toBe("custom");
    });

    it("has wizard setup configuration", async () => {
      const plugin = await import("./index.js");
      let capturedProvider:
        | { wizard: { setup: { choiceId: string; groupId: string } } }
        | undefined;
      const mockApi = {
        registerProvider: (provider: {
          wizard: { setup: { choiceId: string; groupId: string } };
        }) => {
          capturedProvider = provider;
        },
      };
      plugin.default.register(mockApi as never);
      expect(capturedProvider!.wizard.setup.choiceId).toBe("acp-agent");
      expect(capturedProvider!.wizard.setup.groupId).toBe("acp");
    });

    it("has wrapStreamFn hook", async () => {
      const plugin = await import("./index.js");
      let capturedProvider: { wrapStreamFn?: unknown } | undefined;
      const mockApi = {
        registerProvider: (provider: { wrapStreamFn?: unknown }) => {
          capturedProvider = provider;
        },
      };
      plugin.default.register(mockApi as never);
      expect(typeof capturedProvider!.wrapStreamFn).toBe("function");
    });

    it("has resolveDynamicModel hook", async () => {
      const plugin = await import("./index.js");
      let capturedProvider: { resolveDynamicModel?: unknown } | undefined;
      const mockApi = {
        registerProvider: (provider: { resolveDynamicModel?: unknown }) => {
          capturedProvider = provider;
        },
      };
      plugin.default.register(mockApi as never);
      expect(typeof capturedProvider!.resolveDynamicModel).toBe("function");
    });

    it("resolveDynamicModel returns correct structure", async () => {
      const plugin = await import("./index.js");
      let capturedProvider:
        | {
            resolveDynamicModel: (ctx: { modelId: string }) => {
              id: string;
              provider: string;
              api: string;
            };
          }
        | undefined;
      const mockApi = {
        registerProvider: (
          provider: typeof capturedProvider extends undefined
            ? never
            : NonNullable<typeof capturedProvider>,
        ) => {
          capturedProvider = provider;
        },
      };
      plugin.default.register(mockApi as never);
      const model = capturedProvider!.resolveDynamicModel({ modelId: "my-custom-model" });
      expect(model.id).toBe("my-custom-model");
      expect(model.provider).toBe("acp");
      expect(model.api).toBe("openai-completions");
    });
  });

  // ── Provider catalog ──────────────────────────────────────────────────

  describe("provider-catalog", () => {
    it("builds a valid ACP provider config", async () => {
      const { buildAcpProvider } = await import("./provider-catalog.js");
      const provider = buildAcpProvider();
      expect(provider.api).toBe("openai-completions");
      expect(provider.models).toHaveLength(1);
      expect(provider.models[0]!.id).toBe("default");
      expect(provider.models[0]!.name).toBe("ACP Default Agent");
    });

    it("sets zero cost for ACP models", async () => {
      const { buildAcpProvider } = await import("./provider-catalog.js");
      const provider = buildAcpProvider();
      const model = provider.models[0]!;
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it("sets a reasonable context window", async () => {
      const { buildAcpProvider } = await import("./provider-catalog.js");
      const provider = buildAcpProvider();
      const model = provider.models[0]!;
      expect(model.contextWindow).toBeGreaterThanOrEqual(100_000);
    });

    it("uses placeholder base URL", async () => {
      const { buildAcpProvider } = await import("./provider-catalog.js");
      const provider = buildAcpProvider();
      expect(provider.baseUrl).toBe("https://acp.local/v1");
    });
  });

  // ── Onboard ───────────────────────────────────────────────────────────

  describe("onboard", () => {
    it("applies ACP provider config with alias", async () => {
      const { applyAcpProviderConfig } = await import("./onboard.js");
      const result = applyAcpProviderConfig({ agents: { defaults: { models: {} } } } as never);
      const models = (result as { agents: { defaults: { models: Record<string, unknown> } } })
        .agents.defaults.models;
      expect(models["acp/default"]).toBeDefined();
      expect((models["acp/default"] as { alias: string }).alias).toBe("ACP Agent");
    });

    it("preserves existing alias when already set", async () => {
      const { applyAcpProviderConfig } = await import("./onboard.js");
      const result = applyAcpProviderConfig({
        agents: {
          defaults: {
            models: {
              "acp/default": { alias: "My Custom ACP" },
            },
          },
        },
      } as never);
      const models = (result as { agents: { defaults: { models: Record<string, unknown> } } })
        .agents.defaults.models;
      expect((models["acp/default"] as { alias: string }).alias).toBe("My Custom ACP");
    });

    it("applies ACP config with default model ref", async () => {
      const { applyAcpConfig, ACP_DEFAULT_MODEL_REF } = await import("./onboard.js");
      expect(ACP_DEFAULT_MODEL_REF).toBe("acp/default");
      const result = applyAcpConfig({ agents: { defaults: { models: {} } } } as never);
      expect(result).toBeDefined();
    });
  });

  // ── Stream bridge (unit-level) ────────────────────────────────────────

  describe("stream bridge", () => {
    it("createAcpStreamFn returns a function", async () => {
      const { createAcpStreamFn } = await import("./acp-stream-bridge.js");
      const streamFn = createAcpStreamFn(undefined, {
        command: "echo",
        args: ["hello"],
      });
      expect(typeof streamFn).toBe("function");
    });

    it("cleanupAcpProviders is a function", async () => {
      const { cleanupAcpProviders } = await import("./acp-stream-bridge.js");
      expect(typeof cleanupAcpProviders).toBe("function");
      // Should not throw when called with no providers
      cleanupAcpProviders();
    });
  });

  // ── wrapStreamFn integration ──────────────────────────────────────────

  describe("wrapStreamFn integration", () => {
    it("wrapStreamFn hook produces a function from config", async () => {
      const plugin = await import("./index.js");
      let capturedProvider:
        | {
            wrapStreamFn: (ctx: {
              streamFn: undefined;
              extraParams: Record<string, unknown>;
            }) => unknown;
          }
        | undefined;
      const mockApi = {
        registerProvider: (
          provider: typeof capturedProvider extends undefined
            ? never
            : NonNullable<typeof capturedProvider>,
        ) => {
          capturedProvider = provider;
        },
      };
      plugin.default.register(mockApi as never);

      const wrappedFn = capturedProvider!.wrapStreamFn({
        streamFn: undefined,
        extraParams: { acpCommand: "echo", acpArgs: ["test"] },
      });
      expect(typeof wrappedFn).toBe("function");
    });
  });
});
