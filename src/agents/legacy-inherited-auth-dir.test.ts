import path from "node:path";
import { describe, expect, it } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveLegacyInheritedAuthDir } from "./legacy-inherited-auth-dir.js";

const stateDir = path.join(process.cwd(), ".test-state", "legacy-inherited-auth-dir");
const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

function expectedAgentDir(agentId: string): string {
  return path.join(stateDir, "agents", agentId, "agent");
}

describe("resolveLegacyInheritedAuthDir", () => {
  it("uses the durable binding after a process restart", () => {
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { authInheritance: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(resolveLegacyInheritedAuthDir(config, env)).toBe(expectedAgentDir("ops"));
  });

  it("prefers the durable binding during the same-process retention window", () => {
    const config = retainLegacyDefaultAgentId(
      {
        agents: {
          ownership: "explicit",
          defaults: { authInheritance: { agentId: "research" } },
          entries: { ops: {}, research: {} },
        },
      } satisfies OpenClawConfig,
      "ops",
    );

    expect(resolveLegacyInheritedAuthDir(config, env)).toBe(expectedAgentDir("research"));
  });

  it("follows the retained legacy owner for an upgraded fleet", () => {
    const config = retainLegacyDefaultAgentId(
      {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      } satisfies OpenClawConfig,
      "ops",
    );

    expect(resolveLegacyInheritedAuthDir(config, env)).toBe(expectedAgentDir("ops"));
  });

  it("uses the configured agent for a sole-agent fleet", () => {
    const config = {
      agents: { entries: { research: {} } },
    } satisfies OpenClawConfig;

    expect(resolveLegacyInheritedAuthDir(config, env)).toBe(expectedAgentDir("research"));
  });

  it("falls back to the physical main store for a marker-free explicit fleet", () => {
    const config = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(resolveLegacyInheritedAuthDir(config, env)).toBe(expectedAgentDir("main"));
  });
});
