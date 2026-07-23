import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";

// Incognito runs must not let Codex persist transcripts; `ephemeral` is stable and skips rollout/state DB
// writes (`codex-rs/app-server-protocol/src/protocol/v2/thread.rs:108`; `codex-rs/core/src/session/session.rs:599-683`).
// Loaded threads stay process-reusable (`codex-rs/core/src/thread_manager.rs:1157-1163,1606-1623`).
export function isIncognitoSessionKey(sessionKey: string | undefined): boolean {
  return /^(?:dashboard|subagent):incognito-[^:]+$/u.test(
    parseAgentSessionKey(sessionKey)?.rest ?? "",
  );
}
