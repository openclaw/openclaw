/**
 * Default tools denied for sub-agent sessions.
 * Keep this list as the single source of truth for runtime policy and UI behavior.
 */
export const SUBAGENT_DEFAULT_TOOL_DENY = [
  // Session management - main agent orchestrates
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  // System admin - dangerous from subagent
  "gateway",
  "agents_list",
  // Interactive setup - not a task
  "whatsapp_login",
  // Status/scheduling - main agent coordinates
  "session_status",
  "cron",
  // Memory - pass relevant info in spawn prompt instead
  "memory_search",
  "memory_get",
] as const;
