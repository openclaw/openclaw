import type { OpenClawConfig } from "../config/config.js";
import { resolveAppSkillsAllowlist, resolveSessionAgentId } from "./agent-scope.js";
import { appUserIdFromSessionKey } from "./app-profile-context.js";
import { isAppUserSession, resolveAppUserId } from "./app-user-workspace.js";

export type AppPromptContext = {
  /** True when this is an app-user session (vs Telegram/owner/subagent/cron). */
  isAppSession: boolean;
  /** Resolved app user id (turn-1-safe via the #71 session-key fallback), or null. */
  appUserId: string | null;
  /**
   * Per-agent app-skill allowlist resolved for THIS session's agent id (entry → defaults
   * fallback). undefined = leave the catalog unchanged; [] = no app skills; names = subset.
   */
  appSkillsAllowlist: string[] | undefined;
};

/**
 * Centralizes the app-user prompt decisions shared by the run path (attempt.ts) and the
 * compaction path (compact.ts) so they cannot drift (Codex 4536644504 #2): whether this is an
 * app session (→ the "app" PromptMode), the app user id, and the agent-scoped app-skill
 * allowlist. The allowlist is resolved for THIS session's agent id up front — before any skill
 * filtering — so it can never be applied globally (Codex 4536672313 / 4536644504 #1).
 */
export function resolveAppPromptContext(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
}): AppPromptContext {
  if (!isAppUserSession(params.sessionKey)) {
    return { isAppSession: false, appUserId: null, appSkillsAllowlist: undefined };
  }
  const appUserId =
    resolveAppUserId(params.sessionKey) ?? appUserIdFromSessionKey(params.sessionKey) ?? null;
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.config,
  });
  const appSkillsAllowlist = resolveAppSkillsAllowlist(params.config ?? {}, sessionAgentId);
  return { isAppSession: true, appUserId, appSkillsAllowlist };
}
