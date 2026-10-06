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
    return `${current}${next.slice(overlap)}`.trim();
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
