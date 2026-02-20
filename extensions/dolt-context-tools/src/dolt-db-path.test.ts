import type { OpenClawConfig } from "openclaw/plugin-sdk";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAgentId, resolveDoltDbPath } from "./dolt-db-path.js";

describe("resolveDoltDbPath", () => {
  it("falls back to state-level dolt.db when no agent id is provided", () => {
    const resolved = resolveDoltDbPath({
      resolveStateDir: () => "/tmp/openclaw-state",
    });

    expect(resolved).toBe(path.join("/tmp/openclaw-state", "dolt.db"));
  });

  it("uses normalized agent-id path when config does not override agentDir", () => {
    const resolved = resolveDoltDbPath({
      resolveStateDir: () => "/tmp/openclaw-state",
      agentId: "Main Agent",
      config: {} as OpenClawConfig,
    });

    expect(resolved).toBe(path.join("/tmp/openclaw-state", "agents", "main-agent", "dolt.db"));
  });

  it("derives from configured agentDir when available", () => {
    const config = {
      agents: {
        list: [
          {
            id: "research",
            agentDir: "/var/tmp/agents/research/agent",
          },
        ],
      },
    } as OpenClawConfig;

    const resolved = resolveDoltDbPath({
      resolveStateDir: () => "/tmp/openclaw-state",
      config,
      agentId: "research",
    });

    expect(resolved).toBe("/var/tmp/agents/research/dolt.db");
  });
});

describe("normalizeAgentId", () => {
  it("normalizes mixed-case and unsupported characters", () => {
    expect(normalizeAgentId("  Main/Agent  ")).toBe("main-agent");
  });
});
