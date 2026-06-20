// Slack plugin module implements commands behavior.
import type { SlackSlashCommandConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Strip Slack mentions (<@U123>, <@U123|name>) and optional bot display name
 * prefix so command detection works on normalized text. Use in both prepare
 * and debounce gate for consistency.
 *
 * "ada stop" with botDisplayName="ada" → "stop" allows abort-trigger matching
 * even when the user prefixes the bot name without a mention syntax.
 */
export function stripSlackMentionsForCommandDetection(
  text: string,
  botDisplayName?: string,
): string {
  let normalized = (text ?? "").replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (botDisplayName) {
    const lower = normalized.toLowerCase();
    const prefix = botDisplayName.toLowerCase();
    if (lower === prefix) {
      // bare bot name with no payload drops to empty so downstream treat as no-op
      return "";
    }
    if (lower.startsWith(prefix + " ")) {
      normalized = normalized.slice(prefix.length + 1).trim();
    }
  }
  return normalized;
}

function normalizeSlackSlashCommandName(raw: string) {
  return raw.replace(/^\/+/, "");
}

export function resolveSlackSlashCommandConfig(
  raw?: SlackSlashCommandConfig,
): Required<SlackSlashCommandConfig> {
  const normalizedName = normalizeSlackSlashCommandName(
    normalizeOptionalString(raw?.name) ?? "openclaw",
  );
  const name = normalizedName || "openclaw";
  return {
    enabled: raw?.enabled === true,
    name,
    sessionPrefix: normalizeOptionalString(raw?.sessionPrefix) ?? "slack:slash",
    ephemeral: raw?.ephemeral !== false,
  };
}

export function buildSlackSlashCommandMatcher(name: string) {
  const normalized = normalizeSlackSlashCommandName(name);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^/?${escaped}$`);
}
