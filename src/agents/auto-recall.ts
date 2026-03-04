/**
 * Auto-recall: automatically run memory_search before each agent turn and
 * prepend the results as context so the model never responds without memory.
 *
 * Enabled via `agents.defaults.memorySearch.autoRecall: true` in openclaw.json.
 * Skipped for heartbeat and cron turns.
 */

import type { OpenClawConfig } from "../config/config.js";
import { getMemorySearchManager } from "../memory/index.js";
import { resolveMemorySearchConfig } from "./memory-search.js";

export type AutoRecallConfig = {
  enabled: boolean;
  maxResults: number;
  minScore: number;
};

export function resolveAutoRecallConfig(
  cfg: OpenClawConfig | undefined,
  agentId: string | undefined,
): AutoRecallConfig | null {
  if (!cfg) return null;

  // Memory search must be enabled for auto-recall to work.
  const resolvedAgentId = agentId ?? "main";
  const memCfg = resolveMemorySearchConfig(cfg, resolvedAgentId);
  if (!memCfg) return null;

  // Check per-agent override first, then defaults.
  const agentEntry = agentId ? cfg.agents?.list?.find((a) => a.id === agentId) : undefined;
  const agentRaw = agentEntry?.memorySearch?.autoRecall;
  const defaultRaw = cfg.agents?.defaults?.memorySearch?.autoRecall;
  const effective = agentRaw ?? defaultRaw;

  if (!effective) return null;
  if (typeof effective === "boolean") {
    return effective ? { enabled: true, maxResults: 5, minScore: 0.3 } : null;
  }
  if (effective.enabled === false) return null;
  return {
    enabled: true,
    maxResults: effective.maxResults ?? 5,
    minScore: effective.minScore ?? 0.3,
  };
}

/**
 * Run memory search with the user's prompt and return formatted context,
 * or null if disabled / no results / error.
 */
export async function runAutoRecall(params: {
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): Promise<string | null> {
  const config = resolveAutoRecallConfig(params.cfg, params.agentId);
  if (!config) return null;

  const resolvedAgentId = params.agentId ?? "main";
  const { manager } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: resolvedAgentId,
  });
  if (!manager) return null;

  try {
    const results = await manager.search(params.prompt, {
      maxResults: config.maxResults,
      minScore: config.minScore,
      sessionKey: params.sessionKey,
    });
    if (!results || results.length === 0) return null;

    const snippets = results
      .map((r) => `[${r.path}:${r.startLine}-${r.endLine}] ${r.snippet.trim()}`)
      .join("\n\n");
    return `[Auto-recalled memory context]\n${snippets}\n[End auto-recall]`;
  } catch {
    // Never block the turn on recall failure.
    return null;
  }
}
