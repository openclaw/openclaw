import {
  interactiveReplyToPresentation,
  normalizeInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveInteractiveTextFallback,
} from "openclaw/plugin-sdk/interactive-runtime";

export function resolveTelegramInteractiveTextFallback(params: {
  text?: string | null;
  interactive?: unknown;
  presentation?: unknown;
}): string | undefined {
  const interactive = normalizeInteractiveReply(params.interactive);
  const text = resolveInteractiveTextFallback({
    text: params.text ?? undefined,
    interactive,
  });
  if (text?.trim()) {
    return text;
  }
  // Fallback to the original presentation when the interactive path produced
  // no usable text (e.g. presentation-only payloads where renderPresentation
  // upstream returned an interactive without text blocks, or presentations
  // that did not survive normalization). Without this, Telegram rejects the
  // send with "Message must be non-empty for Telegram sends".
  const presentation = normalizeMessagePresentation(params.presentation);
  if (presentation) {
    const directFallback = renderMessagePresentationFallbackText({
      text: params.text ?? undefined,
      presentation,
    });
    if (directFallback.trim()) {
      return directFallback;
    }
  }
  if (!interactive) {
    return text;
  }
  const reconstructed = interactiveReplyToPresentation(interactive);
  if (!reconstructed) {
    return text;
  }
  const fallback = renderMessagePresentationFallbackText({ presentation: reconstructed });
  return fallback.trim() ? fallback : text;
}
