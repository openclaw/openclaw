import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveCliBackendConfig } from "./cli-backends.js";

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
