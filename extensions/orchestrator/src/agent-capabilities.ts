// V0 capability inference. The agent-installer (Plan 002) does not yet
// surface capabilities in IDENTITY.md frontmatter, so the orchestrator
// uses an opt-in `capabilities.json` per agent dir, falling back to a
// prefix table when no opt-in file is present. Recon notes A-S3.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface InferCapabilitiesOptions {
  /** Override the agents root for tests. Default `~/.openclaw/agents`. */
  agentsDir?: string;
}

const PREFIX_RULES: ReadonlyArray<{
  test: (id: string) => boolean;
  capabilities: ReadonlyArray<string>;
}> = [
  {
    test: (id) => id.startsWith("github-"),
    capabilities: ["mutate-external", "code"],
  },
  {
    test: (id) => id.startsWith("gmail-"),
    capabilities: ["mutate-external", "writing"],
  },
  {
    test: (id) => id.startsWith("linear-"),
    capabilities: ["mutate-external", "ops"],
  },
  {
    test: (id) => id.includes("publisher") || id.includes("deploy"),
    capabilities: ["publish", "ops"],
  },
];

const EXACT_RULES: Readonly<Record<string, ReadonlyArray<string>>> = {
  coder: ["code", "mutate-external"],
  helpdesk: ["ops", "mutate-external"],
  researcher: ["research"],
  main: [],
};

function defaultAgentsDir(): string {
  return resolve(homedir(), ".openclaw", "agents");
}

function readOptInCapabilities(agentId: string, agentsDir: string): string[] | null {
  const file = resolve(agentsDir, agentId, "agent", "capabilities.json");
  if (!existsSync(file)) {
    return null;
  }
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { capabilities?: unknown };
    if (Array.isArray(parsed.capabilities)) {
      return parsed.capabilities.filter((c): c is string => typeof c === "string");
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve an agent id to its capability list.
 *
 * Lookup order:
 *   1. `<agentsDir>/<agentId>/agent/capabilities.json` (opt-in override).
 *   2. Exact-match table (`coder`, `helpdesk`, `researcher`, `main`).
 *   3. Prefix-match table (`github-`, `gmail-`, `linear-`, `*publisher*`, `*deploy*`).
 *   4. Empty list (no inferred capabilities).
 */
export function inferCapabilities(
  agentId: string,
  options: InferCapabilitiesOptions = {},
): string[] {
  const agentsDir = options.agentsDir ?? defaultAgentsDir();
  const optIn = readOptInCapabilities(agentId, agentsDir);
  if (optIn !== null) {
    return optIn;
  }
  if (agentId in EXACT_RULES) {
    return [...EXACT_RULES[agentId]!];
  }
  for (const rule of PREFIX_RULES) {
    if (rule.test(agentId)) {
      return [...rule.capabilities];
    }
  }
  return [];
}
