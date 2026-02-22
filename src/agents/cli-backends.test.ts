import { describe, expect, it } from "vitest";

import type { OpenClawConfig } from "../config/config.js";
import { resolveCliBackendConfig } from "./cli-backends.js";

describe("resolveCliBackendConfig", () => {
  describe("claude-cli defaults", () => {
    it("includes --verbose when using stream-json output format", () => {
      const resolved = resolveCliBackendConfig("claude-cli");
      expect(resolved).not.toBeNull();

      const args = resolved!.config.args ?? [];
      const resumeArgs = resolved!.config.resumeArgs ?? [];

      // stream-json requires --verbose in print mode
      if (args.includes("stream-json")) {
        expect(args).toContain("--verbose");
      }
      if (resumeArgs.includes("stream-json")) {
        expect(resumeArgs).toContain("--verbose");
      }
    });

    it("has streaming enabled with stream-json format", () => {
      const resolved = resolveCliBackendConfig("claude-cli");
      expect(resolved).not.toBeNull();

      expect(resolved!.config.streaming).toBe(true);
      expect(resolved!.config.args).toContain("stream-json");
      expect(resolved!.config.output).toBe("jsonl");
    });

    it("includes required streaming event types", () => {
      const resolved = resolveCliBackendConfig("claude-cli");
      expect(resolved).not.toBeNull();

      const eventTypes = resolved!.config.streamingEventTypes ?? [];
      expect(eventTypes).toContain("text");
      expect(eventTypes).toContain("result");
    });

    it("resume args also use stream-json with --verbose", () => {
      const resolved = resolveCliBackendConfig("claude-cli");
      expect(resolved).not.toBeNull();

      const resumeArgs = resolved!.config.resumeArgs ?? [];
      expect(resumeArgs).toContain("stream-json");
      expect(resumeArgs).toContain("--verbose");
      expect(resumeArgs).toContain("--resume");
      expect(resumeArgs).toContain("{sessionId}");
    });
  });

  describe("codex-cli defaults", () => {
    it("has streaming enabled", () => {
      const resolved = resolveCliBackendConfig("codex-cli");
      expect(resolved).not.toBeNull();

      expect(resolved!.config.streaming).toBe(true);
      expect(resolved!.config.output).toBe("jsonl");
    });

    it("includes required streaming event types", () => {
      const resolved = resolveCliBackendConfig("codex-cli");
      expect(resolved).not.toBeNull();

      const eventTypes = resolved!.config.streamingEventTypes ?? [];
      expect(eventTypes).toContain("item");
      expect(eventTypes).toContain("turn.completed");
    });
  });

  describe("config overrides", () => {
    it("allows disabling streaming via config override", () => {
      const resolved = resolveCliBackendConfig("claude-cli", {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
                streaming: false,
              },
            },
          },
        },
      });
      expect(resolved).not.toBeNull();
      expect(resolved!.config.streaming).toBe(false);
    });

    it("preserves base args when override does not specify args", () => {
      const resolved = resolveCliBackendConfig("claude-cli", {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
                streaming: false,
              },
            },
          },
        },
      });
      expect(resolved).not.toBeNull();
      // Should still have the base args including --verbose
      expect(resolved!.config.args).toContain("--verbose");
      expect(resolved!.config.args).toContain("stream-json");
    });
  });
});

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
