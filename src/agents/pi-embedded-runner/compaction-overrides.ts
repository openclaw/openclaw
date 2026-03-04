import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";

/**
 * Resolves the thinking level to use for a compaction run.
 *
 * - `"off"` (default): compaction always runs without extended thinking, preventing timeout
 *   races on channels with strict reply windows (e.g. Discord 30s, Telegram 240s).
 * - `"on"`: compaction inherits the session model's current thinking level (`sessionThinkLevel`),
 *   falling back to "off" if none is set.
 */
export function resolveCompactionThinkLevel(params: {
  cfg?: OpenClawConfig;
  sessionThinkLevel?: ThinkLevel;
}): ThinkLevel {
  const configured = params.cfg?.agents?.defaults?.compaction?.thinking;
  if (configured === "on") {
    return params.sessionThinkLevel ?? "off";
  }
  return "off";
}
