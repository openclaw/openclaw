export type TelegramReliabilityErrorKind =
  | "timeout"
  | "context_overflow"
  | "session_lock"
  | "provider_fetch"
  | "delivery_failure"
  | "unknown";

export type TelegramTokenRisk = "normal" | "observe" | "handoff" | "high" | "new_session";

export function classifyTelegramReliabilityError(error: unknown): TelegramReliabilityErrorKind {
  const text = String(
    error instanceof Error ? `${error.name}: ${error.message}` : error ?? "",
  ).toLowerCase();
  if (/\b(context|token).{0,24}(overflow|limit|too large)|maximum context/.test(text)) {
    return "context_overflow";
  }
  if (/\b(session|conversation).{0,24}(lock|busy|locked)/.test(text)) {
    return "session_lock";
  }
  if (/\b(fetch|network|econn|etimedout|eai_again|socket|provider|api)\b/.test(text)) {
    return text.includes("timeout") || text.includes("timed out") ? "timeout" : "provider_fetch";
  }
  if (/\btimeout|timed out|abort(ed)?\b/.test(text)) {
    return "timeout";
  }
  return "unknown";
}

export function classifyTelegramTokenRisk(totalTokens: number): TelegramTokenRisk {
  if (totalTokens >= 200_000) {
    return "new_session";
  }
  if (totalTokens >= 160_000) {
    return "high";
  }
  if (totalTokens >= 120_000) {
    return "handoff";
  }
  if (totalTokens >= 80_000) {
    return "observe";
  }
  return "normal";
}

export function shouldGuardTelegramLongInput(params: {
  totalTokens: number;
  text: string;
  commandSource?: string;
}): { guarded: boolean; risk: TelegramTokenRisk; message?: string } {
  const text = params.text.trim();
  const risk = classifyTelegramTokenRisk(params.totalTokens);
  if (!text) {
    return { guarded: false, risk };
  }
  if (isReliabilitySafeCommand(text, params.commandSource)) {
    return { guarded: false, risk };
  }

  const length = text.length;
  const shouldGuard =
    (risk === "new_session" && length >= 800) ||
    (risk === "high" && length >= 2_000) ||
    (risk === "handoff" && length >= 5_000);
  if (!shouldGuard) {
    return { guarded: false, risk };
  }

  return {
    guarded: true,
    risk,
    message:
      "This Telegram chat is already carrying a large context. I received the message, but I will not process this long input here because it may stall the gateway. Please run /handoff or /new first, then send a short summary or attach the long material through a background task.",
  };
}

export function buildTelegramFailureNotice(error: unknown): string {
  const kind = classifyTelegramReliabilityError(error);
  if (kind === "timeout") {
    return "The request timed out before a final Telegram reply could be delivered. Please retry, or use /new if this chat is already large.";
  }
  if (kind === "context_overflow") {
    return "The request could not continue because the conversation context is too large. Please use /handoff or /new, then send a shorter follow-up.";
  }
  if (kind === "session_lock") {
    return "This Telegram session appears to be busy or locked. Please wait a moment and retry.";
  }
  if (kind === "provider_fetch") {
    return "The model/provider request failed before a final Telegram reply could be delivered. Please retry after the connection is stable.";
  }
  return "Something went wrong before a final Telegram reply could be delivered. Please try again.";
}

function isReliabilitySafeCommand(text: string, commandSource?: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (commandSource === "native") {
    return true;
  }
  return /^\/(new|handoff|resume|compact|status|stop|abort)(\s|$)/.test(normalized);
}
