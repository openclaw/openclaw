// Telegram helper module supports agent config behavior.
import type { OpenClawConfig, TypingMode } from "openclaw/plugin-sdk/config-contracts";

type ReasoningDefault = "on" | "stream" | "off";

const DEFAULT_AGENT_ID = "main";

function normalizeAgentId(value: string | undefined | null): string {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized || DEFAULT_AGENT_ID;
}

export function resolveTelegramConfigReasoningDefault(
  cfg: OpenClawConfig,
  agentId: string,
): ReasoningDefault {
  const id = normalizeAgentId(agentId);
  const agentDefault = cfg.agents?.list?.find(
    (entry) => normalizeAgentId(entry?.id) === id,
  )?.reasoningDefault;
  return agentDefault ?? cfg.agents?.defaults?.reasoningDefault ?? "off";
}

/**
 * Returns the explicitly configured typing mode (session override first, then
 * agents.defaults), mirroring how get-reply resolves it. Returns undefined
 * when the operator never set one, so callers can keep legacy defaults.
 */
export function resolveConfiguredTypingMode(cfg: OpenClawConfig): TypingMode | undefined {
  return cfg.session?.typingMode ?? cfg.agents?.defaults?.typingMode;
}
