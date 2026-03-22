import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";

/**
 * Resolve config-injected system prompt from agents.defaults.systemPrompt / rules,
 * with per-agent override from agents.list[].systemPrompt / rules.
 *
 * Per-agent fields override (not merge with) defaults.
 */
export function resolveConfigSystemPrompt(cfg: OpenClawConfig, agentId: string): string {
  const agentEntry = cfg.agents?.list?.find(
    (e) => normalizeAgentId(e.id) === normalizeAgentId(agentId),
  );
  // Per-agent fields override defaults (not merge).
  const systemPrompt = agentEntry?.systemPrompt ?? cfg.agents?.defaults?.systemPrompt;
  const rules = agentEntry?.rules ?? cfg.agents?.defaults?.rules;

  const parts: string[] = [];
  if (systemPrompt?.trim()) {
    parts.push(systemPrompt.trim());
  }
  if (rules && rules.length > 0) {
    const filtered = rules.filter((r) => r.trim());
    if (filtered.length > 0) {
      const numbered = filtered.map((r, i) => `${i + 1}. ${r}`).join("\n");
      parts.push(numbered);
    }
  }
  return parts.join("\n\n");
}
