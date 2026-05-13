import { isCronSessionKey } from "../routing/session-key.js";

export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "Auto-announce is push-based. After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool. Track expected child session keys. Continue any independent work. If any required child completion has not arrived yet, call sessions_yield to end the turn and wait for completion events as user messages. After ALL expected completions arrive, send the final answer even when some children failed, timed out, or returned partial results; report those statuses explicitly. Reply ONLY with NO_REPLY when the exact same child completion result was already delivered in a prior final answer.";
export const SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound session stays active after this task; continue in-thread for follow-ups.";

export function resolveSubagentSpawnAcceptedNote(params: {
  spawnMode: "run" | "session";
  agentSessionKey?: string;
}): string | undefined {
  if (params.spawnMode === "session") {
    return SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE;
  }
  return isCronSessionKey(params.agentSessionKey) ? undefined : SUBAGENT_SPAWN_ACCEPTED_NOTE;
}
