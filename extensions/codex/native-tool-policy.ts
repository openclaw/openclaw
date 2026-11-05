/** Capabilities exposed together by Codex native code mode. */
export const CODEX_NATIVE_TOOL_REQUIREMENTS = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "apply_patch",
] as const;

/** OpenClaw tools whose denial is enforced by disabling Codex native delegation. */
const CODEX_NATIVE_DELEGATION_DENY_NAMES = [
  "sessions_send",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_spawn",
  "subagents",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
] as const;

const CODEX_NATIVE_DELEGATION_DENY_SET: ReadonlySet<string> = new Set(
  CODEX_NATIVE_DELEGATION_DENY_NAMES,
);

/** True when a safe-denied tool requires native delegation to be disabled for the run. */
export function deniesCodexNativeDelegation(
  safeDeniedTools: readonly string[] | undefined,
): boolean {
  return safeDeniedTools?.some((name) => CODEX_NATIVE_DELEGATION_DENY_SET.has(name)) === true;
}

// Audited against @openai/codex 0.160.0. These exact denies
// either have no Codex-native equivalent or are enforced by the harness. Keep
// the list positive and conservative: an omitted tool isolates the native surface.
export const CODEX_TOOL_POLICY_SAFE_DENY_NAMES = [
  "web_fetch",
  "x_search",
  "memory_search",
  "memory_get",
  "dashboard",
  "canvas",
  "show_widget",
  "message",
  "automations",
  "gateway",
  // OpenClaw admin/status tools have no native counterpart.
  "agents_list",
  "openclaw",
  "session_status",
  "progress_card",
  "skill_workshop",
  "skill_library",
  "image_generate",
  "music_generate",
  "video_generate",
  "tts",
  // Session, conversation and delegation tools. Their native counterparts are
  // Codex collaboration tools (spawn_agent, send_input, resume_agent, v2), which
  // can address other threads. A deny here is enforced by disabling native
  // delegation for the run instead of the whole native surface.
  ...CODEX_NATIVE_DELEGATION_DENY_NAMES,
] as const;
