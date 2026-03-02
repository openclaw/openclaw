import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCliBackendConfig, resolveCliBackendIds } from "./cli-backends.js";

describe("resolveCliBackendConfig reliability merge", () => {
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

describe("cursor-cli backend", () => {
  it("resolves built-in defaults without config", () => {
    const resolved = resolveCliBackendConfig("cursor-cli");

    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe("cursor-cli");
    expect(resolved?.config.command).toBe("agent");
    expect(resolved?.config.args).toEqual(["-p", "--output-format", "json", "--force", "--trust"]);
    expect(resolved?.config.resumeArgs).toEqual([
      "-p",
      "--output-format",
      "json",
      "--force",
      "--trust",
      "--resume",
      "{sessionId}",
    ]);
    expect(resolved?.config.output).toBe("json");
    expect(resolved?.config.input).toBe("arg");
    expect(resolved?.config.modelArg).toBe("--model");
    expect(resolved?.config.modelAliases).toEqual({ default: "" });
    expect(resolved?.config.sessionMode).toBe("always");
    expect(resolved?.config.sessionIdFields).toEqual(["session_id"]);
    expect(resolved?.config.serialize).toBe(true);
  });

  it("deep-merges reliability watchdog overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "cursor-cli": {
              command: "agent",
              reliability: {
                watchdog: {
                  fresh: {
                    noOutputTimeoutMs: 90_000,
                  },
                },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("cursor-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.reliability?.watchdog?.fresh?.noOutputTimeoutMs).toBe(90_000);
    expect(resolved?.config.reliability?.watchdog?.resume?.noOutputTimeoutRatio).toBe(0.3);
    expect(resolved?.config.reliability?.watchdog?.resume?.minMs).toBe(60_000);
  });

  it("allows overriding command path", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "cursor-cli": {
              command: "/usr/local/bin/agent",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const resolved = resolveCliBackendConfig("cursor-cli", cfg);

    expect(resolved).not.toBeNull();
    expect(resolved?.config.command).toBe("/usr/local/bin/agent");
    expect(resolved?.config.args).toEqual(["-p", "--output-format", "json", "--force", "--trust"]);
  });

  it("is included in resolveCliBackendIds", () => {
    const ids = resolveCliBackendIds();
    expect(ids.has("cursor-cli")).toBe(true);
  });
});
