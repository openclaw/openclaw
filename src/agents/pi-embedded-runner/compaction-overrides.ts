import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";

/**
 * Resolves the thinking level to use for a compaction run.
 *
 * Priority:
 * 1. `agents.defaults.compaction.thinking` if explicitly configured
 * 2. "off" — compaction defaults to no thinking regardless of session model,
 *    since extended thinking on slow models can exceed channel timeout windows
 *    (e.g. Discord 30s, Telegram 240s) and compaction is a summarization task
 *    that does not benefit from extended reasoning.
 */
export function resolveCompactionThinkLevel(params: { cfg?: OpenClawConfig }): ThinkLevel {
  return params.cfg?.agents?.defaults?.compaction?.thinking ?? "off";
}
