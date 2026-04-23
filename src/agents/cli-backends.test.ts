import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { normalizeClaudeBackendConfig, resolveCliBackendConfig } from "./cli-backends.js";

function createBackendEntry(params: {
  pluginId: string;
  id: string;
  config: CliBackendConfig;
  bundleMcp?: boolean;
  normalizeConfig?: (config: CliBackendConfig) => CliBackendConfig;
}) {
  return {
    pluginId: params.pluginId,
    source: "test",
    backend: {
      id: params.id,
      config: params.config,
      ...(params.bundleMcp ? { bundleMcp: params.bundleMcp } : {}),
      ...(params.normalizeConfig ? { normalizeConfig: params.normalizeConfig } : {}),
    },
  };
}

beforeEach(() => {
  const registry = createEmptyPluginRegistry();
  registry.cliBackends = [
    createBackendEntry({
      pluginId: "anthropic",
      id: "claude-cli",
      config: {
        command: "claude",
        args: [
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          "--setting-sources",
          "user",
        ],
        resumeArgs: [
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          "--setting-sources",
          "user",
          "--resume",
          "{sessionId}",
        ],
        output: "jsonl",
        input: "stdin",
        env: {
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
        },
        clearEnv: [
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_API_KEY_OLD",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_UNIX_SOCKET",
          "CLAUDE_CONFIG_DIR",
          "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
          "CLAUDE_CODE_ENTRYPOINT",
          "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
          "CLAUDE_CODE_OAUTH_SCOPES",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
          "CLAUDE_CODE_PLUGIN_CACHE_DIR",
          "CLAUDE_CODE_PLUGIN_SEED_DIR",
          "CLAUDE_CODE_REMOTE",
          "CLAUDE_CODE_USE_COWORK_PLUGINS",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_FOUNDRY",
          "CLAUDE_CODE_USE_VERTEX",
        ],
      },
      normalizeConfig: normalizeClaudeBackendConfig,
    }),
    createBackendEntry({
      pluginId: "openai",
      id: "codex-cli",
      config: {
        command: "codex",
        args: [
          "exec",
          "--json",
          "--color",
          "never",
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check",
        ],
        resumeArgs: [
          "exec",
          "resume",
          "{sessionId}",
          "--color",
          "never",
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check",
        ],
        reliability: {
          watchdog: {
            fresh: {
              noOutputTimeoutRatio: 0.8,
              minMs: 60_000,
              maxMs: 180_000,
            },
            resume: {
              noOutputTimeoutRatio: 0.3,
              minMs: 60_000,
              maxMs: 180_000,
            },
          },
        },
      },
    }),
    createBackendEntry({
      pluginId: "google",
      id: "google-gemini-cli",
      bundleMcp: false,
      config: {
        command: "gemini",
        args: ["--prompt", "--output-format", "json"],
        resumeArgs: ["--resume", "{sessionId}", "--prompt", "--output-format", "json"],
        modelArg: "--model",
        sessionMode: "existing",
        sessionIdFields: ["session_id", "sessionId"],
        modelAliases: { pro: "gemini-3.1-pro-preview" },
      },
    }),
  ];
  setActivePluginRegistry(registry);
});

describe("resolveCliBackendConfig reliability merge", () => {
  it("defaults codex-cli to workspace-write for fresh and resume runs", () => {
    const resolved = resolveCliBackendConfig("codex-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toEqual([
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
    ]);
    expect(resolved?.config.resumeArgs).toEqual([
      "exec",
      "resume",
      "{sessionId}",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
    ]);
  });

  it("deep-merges reliability watchdog overrides for codex", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": {
              command: "codex",
              reliability: {
                watchdog: {
                  resume: {
                    noOutputTimeoutMs: 42_000,
                  },
                },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("codex-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.reliability?.watchdog?.resume?.noOutputTimeoutMs).toBe(42_000);
    // Ensure defaults are retained when only one field is overridden.
    expect(resolved?.config.reliability?.watchdog?.resume?.noOutputTimeoutRatio).toBe(0.3);
    expect(resolved?.config.reliability?.watchdog?.resume?.minMs).toBe(60_000);
    expect(resolved?.config.reliability?.watchdog?.resume?.maxMs).toBe(180_000);
    expect(resolved?.config.reliability?.watchdog?.fresh?.noOutputTimeoutRatio).toBe(0.8);
  });
});

describe("resolveCliBackendConfig claude-cli defaults", () => {
  it("uses hardened claude-cli defaults for fresh and resume args", () => {
    const resolved = resolveCliBackendConfig("claude-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.config.output).toBe("jsonl");
    expect(resolved?.config.args).toContain("stream-json");
    expect(resolved?.config.args).toContain("--include-partial-messages");
    expect(resolved?.config.args).toContain("--verbose");
    expect(resolved?.config.args).toContain("--setting-sources");
    expect(resolved?.config.args).toContain("user");
    expect(resolved?.config.args).not.toContain("--permission-mode");
    expect(resolved?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.input).toBe("stdin");
    expect(resolved?.config.resumeArgs).toContain("stream-json");
    expect(resolved?.config.resumeArgs).toContain("--include-partial-messages");
    expect(resolved?.config.resumeArgs).toContain("--verbose");
    expect(resolved?.config.resumeArgs).toContain("--setting-sources");
    expect(resolved?.config.resumeArgs).toContain("user");
    expect(resolved?.config.resumeArgs).not.toContain("--permission-mode");
    expect(resolved?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
  });

  it("retains default claude safety args when only command is overridden", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "/usr/local/bin/claude",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.command).toBe("/usr/local/bin/claude");
    expect(resolved?.config.args).toContain("--setting-sources");
    expect(resolved?.config.args).toContain("user");
    expect(resolved?.config.args).not.toContain("--permission-mode");
    expect(resolved?.config.resumeArgs).toContain("--setting-sources");
    expect(resolved?.config.resumeArgs).toContain("user");
    expect(resolved?.config.resumeArgs).not.toContain("--permission-mode");
    expect(resolved?.config.env).toEqual({ CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" });
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_BASE_URL");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CONFIG_DIR");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_CACHE_DIR");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_SEED_DIR");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_REMOTE");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_USE_COWORK_PLUGINS");
  });

  it("normalizes legacy skip-permissions overrides by removing the legacy flag", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--dangerously-skip-permissions", "--output-format", "json"],
              resumeArgs: [
                "-p",
                "--dangerously-skip-permissions",
                "--output-format",
                "json",
                "--resume",
                "{sessionId}",
              ],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.args).not.toContain("--permission-mode");
    expect(resolved?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.resumeArgs).not.toContain("--permission-mode");
  });

  it("keeps explicit permission-mode overrides while removing legacy skip flag", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--dangerously-skip-permissions", "--permission-mode", "acceptEdits"],
              resumeArgs: [
                "-p",
                "--dangerously-skip-permissions",
                "--permission-mode=acceptEdits",
                "--resume",
                "{sessionId}",
              ],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.args).toEqual([
      "-p",
      "--permission-mode",
      "acceptEdits",
      "--setting-sources",
      "user",
    ]);
    expect(resolved?.config.resumeArgs).not.toContain("--dangerously-skip-permissions");
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--permission-mode=acceptEdits",
      "--resume",
      "{sessionId}",
      "--setting-sources",
      "user",
    ]);
    expect(resolved?.config.args).not.toContain("bypassPermissions");
    expect(resolved?.config.resumeArgs).not.toContain("bypassPermissions");
  });

  it("forces project or local setting-source overrides back to user-only", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--setting-sources", "project", "--permission-mode", "acceptEdits"],
              resumeArgs: [
                "-p",
                "--setting-sources=local,user",
                "--resume",
                "{sessionId}",
                "--permission-mode=acceptEdits",
              ],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toEqual([
      "-p",
      "--setting-sources",
      "user",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--setting-sources=user",
      "--resume",
      "{sessionId}",
      "--permission-mode=acceptEdits",
    ]);
  });

  it("falls back to user-only setting sources when a custom override leaves the flag without a value", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--setting-sources", "--output-format", "stream-json"],
              resumeArgs: ["-p", "--setting-sources", "--resume", "{sessionId}"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--setting-sources",
      "user",
    ]);
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--resume",
      "{sessionId}",
      "--setting-sources",
      "user",
    ]);
  });

  it("drops malformed permission-mode values while keeping setting-source hardening", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--permission-mode", "--output-format", "stream-json"],
              resumeArgs: ["-p", "--permission-mode", "--resume", "{sessionId}"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--setting-sources",
      "user",
    ]);
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--resume",
      "{sessionId}",
      "--setting-sources",
      "user",
    ]);
  });

  it("does not inject permission-mode when custom args omit permission flags", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              args: ["-p", "--output-format", "stream-json", "--verbose"],
              resumeArgs: [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--resume",
                "{sessionId}",
              ],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.args).toContain("--setting-sources");
    expect(resolved?.config.args).toContain("user");
    expect(resolved?.config.args).not.toContain("--permission-mode");
    expect(resolved?.config.resumeArgs).toContain("--setting-sources");
    expect(resolved?.config.resumeArgs).toContain("user");
    expect(resolved?.config.resumeArgs).not.toContain("--permission-mode");
  });

  it("keeps hardened clearEnv defaults when custom claude env overrides are merged", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude",
              env: {
                SAFE_CUSTOM: "ok",
                ANTHROPIC_BASE_URL: "https://evil.example.com/v1",
              },
              clearEnv: ["EXTRA_CLEAR"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.env).toEqual({
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      SAFE_CUSTOM: "ok",
      ANTHROPIC_BASE_URL: "https://evil.example.com/v1",
    });
    expect(resolved?.config.clearEnv).toContain("ANTHROPIC_BASE_URL");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CONFIG_DIR");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_CACHE_DIR");
    expect(resolved?.config.clearEnv).toContain("CLAUDE_CODE_PLUGIN_SEED_DIR");
    expect(resolved?.config.clearEnv).toContain("EXTRA_CLEAR");
  });

  it("normalizes override-only claude-cli config when the plugin registry is absent", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);

    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "/usr/local/bin/claude",
              args: ["-p", "--output-format", "json"],
              resumeArgs: ["-p", "--output-format", "json", "--resume", "{sessionId}"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("claude-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.bundleMcp).toBe(true);
    expect(resolved?.config.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--setting-sources",
      "user",
    ]);
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--output-format",
      "json",
      "--resume",
      "{sessionId}",
      "--setting-sources",
      "user",
    ]);
    expect(resolved?.config.systemPromptArg).toBe("--append-system-prompt");
    expect(resolved?.config.systemPromptWhen).toBe("first");
    expect(resolved?.config.sessionArg).toBe("--session-id");
    expect(resolved?.config.sessionMode).toBe("always");
    expect(resolved?.config.input).toBe("stdin");
    expect(resolved?.config.output).toBe("jsonl");
  });
});

describe("resolveCliBackendConfig google-gemini-cli defaults", () => {
  it("uses Gemini CLI json args and existing-session resume mode", () => {
    const resolved = resolveCliBackendConfig("google-gemini-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.bundleMcp).toBe(false);
    expect(resolved?.config.args).toEqual(["--prompt", "--output-format", "json"]);
    expect(resolved?.config.resumeArgs).toEqual([
      "--resume",
      "{sessionId}",
      "--prompt",
      "--output-format",
      "json",
    ]);
    expect(resolved?.config.modelArg).toBe("--model");
    expect(resolved?.config.sessionMode).toBe("existing");
    expect(resolved?.config.sessionIdFields).toEqual(["session_id", "sessionId"]);
    expect(resolved?.config.modelAliases?.pro).toBe("gemini-3.1-pro-preview");
  });
});

describe("resolveCliBackendConfig alias precedence", () => {
  it("prefers the canonical backend key over legacy aliases when both are configured", () => {
    const registry = createEmptyPluginRegistry();
    registry.cliBackends = [
      createBackendEntry({
        pluginId: "moonshot",
        id: "kimi",
        config: {
          command: "kimi",
          args: ["--default"],
        },
      }),
    ];
    setActivePluginRegistry(registry);

    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "kimi-coding": {
              command: "kimi-legacy",
              args: ["--legacy"],
            },
            kimi: {
              command: "kimi-canonical",
              args: ["--canonical"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("kimi", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.command).toBe("kimi-canonical");
    expect(resolved?.config.args).toEqual(["--canonical"]);
  });
});
