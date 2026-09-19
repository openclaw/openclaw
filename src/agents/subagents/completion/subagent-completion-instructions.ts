import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";

export const SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION =
  "This completion ends one child run, not necessarily the original user request. Compare the result with the requested outcome before deciding the task is done. Reviews, failed checks, and other in-scope fixable blockers require continued work or a follow-up in the kept child session; report a blocker only when progress needs new user authority or an unavailable external decision.";

export const SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION = `Process this result privately. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION} Your final reply stays internal. If the original request requires a user-facing update, send it through an available, permitted messaging tool; do not rely on your final reply for delivery. Reply ONLY: ${SILENT_REPLY_TOKEN} when no further work or user-facing update is owed, or after sending that update.`;
