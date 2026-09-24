import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKeyParts, type ParsedAgentSessionKey } from "./session-key.js";

// Signal group IDs (#82853) preserve one colon-free segment.
const SIGNAL_GROUP_ID_PATTERN = /(^|:)signal:group:([^:]+)/gi;
// Matrix room/event IDs (#75670) preserve the tail, including nested ownership wrappers.
const MATRIX_ROOM_KEY_PATTERN = /^(?:(?:agent:[^:]*:)+:*)?matrix:(?:channel|group):/i;

function casePreservingPeerSpan(
  channel: string | undefined | null,
  peerKind: string | undefined | null,
): "segment" | "tail" | undefined {
  const c = normalizeLowercaseStringOrEmpty(channel);
  const k = normalizeLowercaseStringOrEmpty(peerKind);
  if (c === "signal" && k === "group") {
    return "segment";
  }
  if (c === "matrix" && (k === "channel" || k === "group")) {
    return "tail";
  }
  return undefined;
}

export function requiresFoldedSessionKeyAliasProof(sessionKey: string | undefined | null): boolean {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return false;
  }
  const parts = raw.split(":");
  let bodyStartIndex = 0;
  let hasAgentWrapper = false;
  while (
    parts.length - bodyStartIndex >= 3 &&
    normalizeOptionalLowercaseString(parts[bodyStartIndex]) === "agent"
  ) {
    hasAgentWrapper = true;
    bodyStartIndex += 2;
  }
  if (hasAgentWrapper) {
    while (bodyStartIndex < parts.length && !normalizeOptionalString(parts[bodyStartIndex])) {
      bodyStartIndex += 1;
    }
  }
  return casePreservingPeerSpan(parts[bodyStartIndex], parts[bodyStartIndex + 1]) === "tail";
}

export function normalizeSessionPeerId(params: {
  channel: string | undefined | null;
  peerKind?: string | null;
  peerId?: string | null;
}): string {
  const peerId = (params.peerId ?? "").trim();
  if (!peerId) {
    return "";
  }
  return casePreservingPeerSpan(params.channel, params.peerKind) !== undefined
    ? peerId
    : normalizeLowercaseStringOrEmpty(peerId);
}

type PreservedSpan = { start: number; end: number; trim: boolean };

const NORMALIZED_SESSION_KEY_CACHE_MAX_ENTRIES = 2048;
const NORMALIZED_SESSION_KEY_CACHE_MAX_LENGTH = 4096;
const normalizedSessionKeyCache = new Map<string, string>();

function readNormalizedSessionKeyCache(raw: string): string | undefined {
  return raw.length <= NORMALIZED_SESSION_KEY_CACHE_MAX_LENGTH
    ? normalizedSessionKeyCache.get(raw)
    : undefined;
}

function writeNormalizedSessionKeyCache(raw: string, normalized: string): void {
  if (raw.length > NORMALIZED_SESSION_KEY_CACHE_MAX_LENGTH) {
    return;
  }
  normalizedSessionKeyCache.set(raw, normalized);
  if (normalizedSessionKeyCache.size > NORMALIZED_SESSION_KEY_CACHE_MAX_ENTRIES) {
    const oldest = normalizedSessionKeyCache.keys().next();
    if (!oldest.done) {
      normalizedSessionKeyCache.delete(oldest.value);
    }
  }
}

// Collect spans before folding so a Signal-shaped substring cannot lowercase a Matrix tail.
function collectCasePreservedSpans(raw: string): PreservedSpan[] {
  const spans: PreservedSpan[] = [];
  // matchAll clones the global matcher, so separate keys never share a cursor.
  for (const match of raw.matchAll(SIGNAL_GROUP_ID_PATTERN)) {
    const matched = match[0] ?? "";
    const segment = match[2] ?? "";
    const segStart = (match.index ?? 0) + matched.length - segment.length;
    // Segment spans match the legacy peerId.trim() behavior exactly.
    spans.push({ start: segStart, end: segStart + segment.length, trim: true });
  }
  // Nested/malformed ownership wrappers remain opaque; only the matcher owns their shape.
  const match = MATRIX_ROOM_KEY_PATTERN.exec(raw);
  if (!match || match[0].length >= raw.length) {
    return spans;
  }
  const tailStart = match[0].length;
  const tail = raw.slice(tailStart);
  const threadMarker = ":thread:";
  const markerIndex = normalizeLowercaseStringOrEmpty(tail).lastIndexOf(threadMarker);
  if (markerIndex === -1) {
    spans.push({ start: tailStart, end: raw.length, trim: false });
    return spans;
  }
  // Room/event bytes stay opaque; only the structural thread marker is folded.
  spans.push({ start: tailStart, end: tailStart + markerIndex, trim: false });
  const threadIdStart = tailStart + markerIndex + threadMarker.length;
  if (threadIdStart < raw.length) {
    spans.push({ start: threadIdStart, end: raw.length, trim: false });
  }
  return spans;
}

export function normalizeSessionKeyPreservingOpaquePeerIds(
  sessionKey: string | undefined | null,
): string {
  const raw = normalizeOptionalString(sessionKey);
  if (!raw) {
    return "";
  }
  const cached = readNormalizedSessionKeyCache(raw);
  if (cached !== undefined) {
    return cached;
  }
  const folded = raw.toLowerCase();
  // Ordinary inventory keys are cheap to fold and would churn the bounded
  // opaque-key cache, repeatedly scanning deleted Map entries during eviction.
  if (!folded.includes("signal:") && !folded.includes("matrix:")) {
    return folded;
  }
  const spans = collectCasePreservedSpans(raw)
    .filter((span) => span.end > span.start)
    .toSorted((a, b) => a.start - b.start);

  let normalized = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) {
      // Overlapping/contained in an already-emitted preserved range; skip.
      continue;
    }
    normalized += normalizeLowercaseStringOrEmpty(raw.slice(cursor, span.start));
    const preserved = raw.slice(span.start, span.end);
    normalized += span.trim ? preserved.trim() : preserved;
    cursor = span.end;
  }
  normalized += normalizeLowercaseStringOrEmpty(raw.slice(cursor));
  writeNormalizedSessionKeyCache(raw, normalized);
  return normalized;
}

/**
 * Parse agent-scoped session keys in a canonical, case-insensitive way.
 * Returned values are canonicalized for stable comparisons/routing while
 * preserving provider-owned opaque peer IDs.
 */
export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): ParsedAgentSessionKey | null {
  return parseAgentSessionKeyParts(normalizeSessionKeyPreservingOpaquePeerIds(sessionKey));
}
