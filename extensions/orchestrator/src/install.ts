// Idempotent installer for the Fleet Orchestrator agent. Copies the
// template files under `install/agent-template/` into the operator's
// `~/.openclaw/agents/fleet-orchestrator/agent/` directory. Existing
// files are never overwritten — operators can edit the live copy
// directly without losing changes on next gateway start.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FLEET_ORCHESTRATOR_AGENT_ID = "fleet-orchestrator";

export interface EnsureAgentInstalledOptions {
  /** Override the agents root for tests. Default `~/.openclaw/agents`. */
  agentsDir?: string;
  /** Override the template source for tests. Default ships from the extension's install/agent-template/. */
  templateDir?: string;
}

export interface EnsureAgentInstalledResult {
  agentDir: string;
  copied: string[];
  skipped: string[];
}

function defaultAgentsDir(): string {
  return resolve(homedir(), ".openclaw", "agents");
}

function defaultTemplateDir(): string {
  // install.ts lives at extensions/orchestrator/src/install.ts; template
  // sits two dirs up under install/agent-template/.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "install", "agent-template");
}

function* walkTemplateFiles(dir: string, base: string = dir): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkTemplateFiles(full, base);
    } else if (stat.isFile()) {
      // Skip the template's own README — it documents the template, not
      // the live agent dir.
      if (entry === "README.md") {
        continue;
      }
      yield full;
    }
  }
}

/**
 * Ensure the Fleet Orchestrator agent dir exists with all template files.
 * Creates `<agentsDir>/<FLEET_ORCHESTRATOR_AGENT_ID>/agent/` and copies
 * each template file that is not already present. Returns which files
 * were newly copied vs already existed.
 */
export function ensureAgentInstalled(
  options: EnsureAgentInstalledOptions = {},
): EnsureAgentInstalledResult {
  const agentsDir = options.agentsDir ?? defaultAgentsDir();
  const templateDir = options.templateDir ?? defaultTemplateDir();
  const agentDir = resolve(agentsDir, FLEET_ORCHESTRATOR_AGENT_ID, "agent");
  mkdirSync(agentDir, { recursive: true });

  const copied: string[] = [];
  const skipped: string[] = [];

  for (const sourcePath of walkTemplateFiles(templateDir)) {
    const relative = sourcePath.slice(templateDir.length + 1);
    const target = resolve(agentDir, relative);
    if (existsSync(target)) {
      skipped.push(relative);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(sourcePath, target);
    copied.push(relative);
  }

  return { agentDir, copied, skipped };
}
