export type ZulipTarget =
  | { kind: "stream"; stream: string; topic: string }
  | { kind: "private"; recipients: string[] };

export function normalizeZulipMessagingTarget(raw: string): string | undefined {
  let normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }
  if (/^zulip:/i.test(normalized)) {
    normalized = normalized.replace(/^zulip:/i, "").trim();
  }
  return normalized || undefined;
}

export function looksLikeZulipTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(stream|pm|private|user):/i.test(trimmed)) {
    return true;
  }
  if (trimmed.includes("#") || trimmed.includes("@")) {
    return true;
  }
  return false;
}

function splitEmails(value: string): string[] {
  const parts = value
    .split(/[;,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return Array.from(new Set(parts.map((p) => p.toLowerCase())));
}

export function parseZulipTarget(raw: string): ZulipTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Zulip target is empty");
  }

  const prefixed = trimmed.replace(/^zulip:/i, "");
  if (/^(pm|private|user):/i.test(prefixed)) {
    const rest = prefixed.replace(/^(pm|private|user):/i, "").trim();
    const recipients = splitEmails(rest);
    if (recipients.length === 0) {
      throw new Error("Zulip PM target requires at least one recipient email");
    }
    return { kind: "private", recipients };
  }

  // stream:<stream>/<topic>
  if (/^stream:/i.test(prefixed)) {
    const rest = prefixed.replace(/^stream:/i, "").trim();
    const [streamRaw, topicRaw] = rest.split(/\s*\/\s*/, 2);
    const stream = streamRaw?.trim();
    const topic = topicRaw?.trim();
    if (!stream || !topic) {
      throw new Error('Zulip stream target requires "stream:<stream>/<topic>"');
    }
    return { kind: "stream", stream, topic };
  }

  // stream#topic shorthand
  if (prefixed.includes("#")) {
    const [stream, topic] = prefixed.split("#", 2).map((s) => s.trim());
    if (stream && topic) {
      return { kind: "stream", stream, topic };
    }
  }

  // Email => PM
  if (prefixed.includes("@")) {
    return { kind: "private", recipients: splitEmails(prefixed) };
  }

  throw new Error(
    'Unrecognized Zulip target. Use "stream:<stream>/<topic>" or "pm:<email>" (or <stream>#<topic>).',
  );
}
