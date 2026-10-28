/** Capabilities exposed together by Codex native code mode. */
export const CODEX_NATIVE_TOOL_REQUIREMENTS = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "apply_patch",
] as const;

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
  // OpenClaw admin/status tools have no native counterpart. Session and
  // conversation tools remain unsafe until native target isolation is enforced.
  // Leaf-only sessions_spawn/subagents denies intentionally remain unsafe.
  "agents_list",
  "openclaw",
  "session_status",
  "progress_card",
  "skill_workshop",
  "image_generate",
  "music_generate",
  "video_generate",
  "tts",
] as const;
