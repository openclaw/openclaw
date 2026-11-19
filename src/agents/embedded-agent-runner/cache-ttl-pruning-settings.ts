import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseDurationMs } from "../../cli/parse-duration.js";
import type { AgentContextPruningConfig } from "../../config/types.agent-defaults.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../glob-pattern.js";

const CACHE_TTL_DEFAULT_PLACEHOLDER = "[Old tool result content cleared]";

export type CacheTtlPruningSettings = {
  ttlMs: number;
  hardClear: boolean;
  placeholder: string;
  isToolPrunable: (toolName: string) => boolean;
};
export function resolveCacheTtlPruningSettings(
  config: AgentContextPruningConfig | undefined,
): CacheTtlPruningSettings | undefined {
  if (config?.mode !== "cache-ttl") {
    return undefined;
  }
  let ttlMs = 5 * 60_000;
  try {
    ttlMs = config.ttl ? parseDurationMs(config.ttl, { defaultUnit: "m" }) : ttlMs;
  } catch {
    // Invalid durations retain the shipped five-minute default.
  }
  const normalize = normalizeLowercaseStringOrEmpty;
  const deny = compileGlobPatterns({ raw: config.tools?.deny, normalize });
  const allow = compileGlobPatterns({ raw: config.tools?.allow, normalize });
  return {
    ttlMs,
    hardClear: config.hardClear?.enabled ?? true,
    placeholder: config.hardClear?.placeholder?.trim() || CACHE_TTL_DEFAULT_PLACEHOLDER,
    isToolPrunable: (toolName) => {
      const normalized = normalize(toolName);
      return (
        !matchesAnyGlobPattern(normalized, deny) &&
        (allow.length === 0 || matchesAnyGlobPattern(normalized, allow))
      );
    },
  };
}
