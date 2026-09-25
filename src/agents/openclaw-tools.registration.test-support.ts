import type { OpenClawConfig } from "../config/types.openclaw.js";
import { useToolPolicySessionFixture } from "./agent-tools.session-policy.test-support.js";
import { createOpenClawTools } from "./openclaw-tools.js";

type CreateOpenClawToolsOptions = NonNullable<Parameters<typeof createOpenClawTools>[0]>;

useToolPolicySessionFixture({
  "agent:main:main": { sessionId: "main-session", updatedAt: 1 },
  "agent:main:dashboard:project": { sessionId: "project-session", updatedAt: 1 },
  ...Object.fromEntries(
    ["worker", "collector"].map((name) => [
      `agent:main:subagent:${name}`,
      {
        sessionId: name === "worker" ? "subagent-session" : "collector-session",
        updatedAt: 1,
        spawnedBy: "agent:main:main",
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1 as const,
      },
    ]),
  ),
});

export function withDefaultRoster(config: OpenClawConfig | undefined): OpenClawConfig {
  return {
    ...config,
    agents: config?.agents ?? { entries: { main: { default: true } } },
  };
}

export function createTestOpenClawTools(options: CreateOpenClawToolsOptions = {}) {
  return createOpenClawTools({
    ...options,
    config: withDefaultRoster(options.config),
  });
}
