/** Leaf helper shared by native and dynamic tool diagnostics. */

const CODEX_ABORT_TERMINAL_REASONS = new Map<string, "failed" | "timed_out">([
  ["codex_startup_timeout", "timed_out"],
  ["turn_completion_idle_timeout", "timed_out"],
  ["turn_progress_idle_timeout", "timed_out"],
  ["turn_terminal_idle_timeout", "timed_out"],
  ["client_closed", "failed"],
]);

/** Preserves timeout provenance when an enclosing run aborts an active tool. */
export function resolveCodexToolAbortTerminalReason(
  signal: AbortSignal,
): "failed" | "cancelled" | "timed_out" {
  try {
    const reason = signal.reason;
    if (typeof reason === "string") {
      // Transport loss is a run failure, not an operator cancellation. Native
      // and dynamic tool diagnostics share this helper and must agree with it.
      return CODEX_ABORT_TERMINAL_REASONS.get(reason) ?? "cancelled";
    }
    if (reason && typeof reason === "object") {
      const record = reason as { name?: unknown; reason?: unknown };
      if (record.name === "TimeoutError" || record.reason === "timeout") {
        return "timed_out";
      }
    }
  } catch {
    return "cancelled";
  }
  return "cancelled";
}
