import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_PARTIAL_USER_TRANSCRIPT_CHARS = 1_200;

export function limitPartialUserTranscript(text: string): string {
  if (text.length <= MAX_PARTIAL_USER_TRANSCRIPT_CHARS) {
    return text;
  }
  const tail = sliceUtf16Safe(text, -MAX_PARTIAL_USER_TRANSCRIPT_CHARS);
  return tail.replace(/^\S+\s+/, "").trimStart() || tail.trimStart();
}

function normalizeTranscriptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function findTextOverlap(base: string, next: string): number {
  const max = Math.min(base.length, next.length);
  for (let size = max; size > 0; size -= 1) {
    if (base.slice(-size) === next.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

export function appendTranscriptText(base: string | undefined, fragment: string): string {
  const next = normalizeTranscriptText(fragment);
  if (!next) {
    return base ?? "";
  }
  const current = normalizeTranscriptText(base ?? "");
  if (!current) {
    return next;
  }
  const currentLower = current.toLowerCase();
  const nextLower = next.toLowerCase();
  if (currentLower === nextLower || currentLower.endsWith(nextLower)) {
    return current;
  }
  if (nextLower.startsWith(currentLower)) {
    return next;
  }
  const overlap = findTextOverlap(currentLower, nextLower);
  if (overlap >= 6 || (overlap >= 3 && next.length <= 12)) {
    // Lowercasing may expand code points; slice only at an original code point boundary.
    let originalOffset = 0;
    let foldedOffset = 0;
    for (const character of next) {
      originalOffset += character.length;
      foldedOffset += character.toLowerCase().length;
      if (foldedOffset === overlap) {
        return `${current}${next.slice(originalOffset)}`.trim();
      }
      if (foldedOffset > overlap) {
        break;
      }
    }
  }
  const separator = /[([{"']$/.test(current) || /^[,.;:!?)]/.test(next) ? "" : " ";
  return `${current}${separator}${next}`.trim();
}

export function resolveFinalTranscriptText(params: {
  partial: string | undefined;
  rawPartial: string | undefined;
  final: string;
}): string {
  const final = normalizeTranscriptText(params.final);
  const rawPartial = params.rawPartial ?? "";
  const partial = normalizeTranscriptText(params.partial ?? rawPartial);
  if (!partial) {
    return final;
  }
  if (!final) {
    return partial;
  }
  const compact = (value: string) => value.toLowerCase().replaceAll(/\s/g, "");
  const compactFinal = compact(final);
  const compactRaw = compact(rawPartial);
  const compactPartial = compact(partial);
  // A bounded partial buffer may only retain the end of a long complete final.
  // In that case the provider's final is authoritative; appending would duplicate the suffix.
  if (compactFinal.startsWith(compactPartial) || compactFinal.endsWith(compactPartial)) {
    return final;
  }
  if (compactPartial.endsWith(compactFinal)) {
    return partial;
  }
  if (compactRaw !== compactPartial) {
    return appendTranscriptText(partial, params.final);
  }
  return normalizeTranscriptText(`${rawPartial}${params.final}`);
}

type UserTranscript = { text: string; raw?: string; updatedAt?: number };
export type TranscriptSnapshot = { buffer: UserTranscript | undefined; text: string | undefined };
export type NativeConsultTranscript = () => TranscriptSnapshot;

export type UserTranscriptState = {
  partial?: UserTranscript;
  recentFinal?: UserTranscript;
  recentFinalTimer?: ReturnType<typeof setTimeout>;
};

export function captureNativeConsultTranscript(
  state: UserTranscriptState,
): NativeConsultTranscript {
  // Keep the current utterance, including its remaining incremental ASR text.
  const buffer = state.partial ?? state.recentFinal;
  return () => ({ buffer, text: buffer?.text });
}

export function clearRecentFinalUserTranscript(state: UserTranscriptState): void {
  clearTimeout(state.recentFinalTimer);
  state.recentFinalTimer = undefined;
  state.recentFinal = undefined;
}

export function consumeUserTranscript(
  state: UserTranscriptState,
  consumed: TranscriptSnapshot | undefined,
): void {
  const buffer = consumed?.buffer;
  const text = consumed?.text?.trim();
  if (
    !buffer ||
    !text ||
    (buffer !== state.partial && buffer !== state.recentFinal) ||
    !buffer.text.toLowerCase().startsWith(text.toLowerCase())
  ) {
    return;
  }
  const remaining = buffer.text.slice(text.length).trimStart();
  if (remaining) {
    buffer.text = remaining;
    buffer.raw = remaining;
  } else if (buffer === state.partial) {
    state.partial = undefined;
  } else {
    clearRecentFinalUserTranscript(state);
  }
}
