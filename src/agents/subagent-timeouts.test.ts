import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSubagentCleanupTimeoutMs,
  resolveSubagentCompletionAnnounceTimeoutMs,
  resolveSubagentControlTimeoutMs,
  resolveSubagentStartupWaitTimeoutMs,
  resolveSubagentWaitGatewayTimeoutMs,
} from "./subagent-timeouts.js";

describe("subagent timeout resolution", () => {
  it("falls control and cleanup back to startup when unset", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            startupWaitTimeoutMs: 12_000,
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveSubagentStartupWaitTimeoutMs(config)).toBe(12_000);
    expect(resolveSubagentControlTimeoutMs(config)).toBe(12_000);
    expect(resolveSubagentCleanupTimeoutMs(config)).toBe(12_000);
  });

  it("prefers the canonical completion timeout over the legacy alias", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            completionAnnounceTimeoutMs: 40_000,
            announceTimeoutMs: 15_000,
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveSubagentCompletionAnnounceTimeoutMs(config)).toBe(40_000);
  });

  it("falls back to the legacy announce alias when canonical timeout is absent", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            announceTimeoutMs: 15_000,
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveSubagentCompletionAnnounceTimeoutMs(config)).toBe(15_000);
  });

  it("adds the shared session-settle budget to agent.wait transport timeouts", () => {
    const config = {
      gateway: {
        sessionSettleTimeoutMs: 7_000,
      },
    } satisfies OpenClawConfig;

    expect(resolveSubagentWaitGatewayTimeoutMs(config, 30_000)).toBe(37_000);
    expect(resolveSubagentWaitGatewayTimeoutMs(config, 0)).toBe(7_000);
  });
});
