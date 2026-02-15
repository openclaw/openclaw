import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { resolveAgentDir } from "./agent-scope.js";
import { listAgentsForGateway } from "../gateway/session-utils.js";

export type LocalModelOverride = {
  agentId: string;
  agentDir: string;
  modelsJsonPath: string;
  providerKeys: string[];
};

/**
 * Detect per-agent `models.json` files that may silently override central config.
 *
 * These files are written by `ensureOpenClawModelsJson` during agent startup and
 * can accumulate stale provider/model entries that shadow `openclaw.json` settings.
 * This function scans all configured agents and returns metadata about any local
 * overrides found, so callers (e.g. `openclaw status`) can surface warnings.
 */
export async function detectLocalModelOverrides(
  cfg: OpenClawConfig,
): Promise<LocalModelOverride[]> {
  const agentList = listAgentsForGateway(cfg);
  const overrides: LocalModelOverride[] = [];

  for (const agent of agentList.agents) {
    const agentDir = resolveAgentDir(cfg, agent.id);
    const modelsJsonPath = path.join(agentDir, "models.json");

    try {
      const raw = await fs.readFile(modelsJsonPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.providers)) {
        continue;
      }
      const providerKeys = Object.keys(parsed.providers as Record<string, unknown>).filter(
        (k) => k.trim().length > 0,
      );
      if (providerKeys.length > 0) {
        overrides.push({
          agentId: agent.id,
          agentDir,
          modelsJsonPath,
          providerKeys,
        });
      }
    } catch {
      // No models.json or unreadable — no override, which is the desired state
      continue;
    }
  }

  return overrides;
}
