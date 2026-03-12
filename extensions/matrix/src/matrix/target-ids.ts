const MATRIX_PREFIX = "matrix:";
const ROOM_PREFIX = "room:";
const CHANNEL_PREFIX = "channel:";
const USER_PREFIX = "user:";

function stripKnownPrefixes(raw: string, prefixes: readonly string[]): string {
  let normalized = raw.trim();
  while (normalized) {
    const lowered = normalized.toLowerCase();
    const matched = prefixes.find((prefix) => lowered.startsWith(prefix));
    if (!matched) {
      return normalized;
    }
    normalized = normalized.slice(matched.length).trim();
  }
  return normalized;
}

export function isMatrixQualifiedUserId(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith("@") && trimmed.includes(":");
}

export function normalizeMatrixResolvableTarget(raw: string): string {
  return stripKnownPrefixes(raw, [MATRIX_PREFIX, ROOM_PREFIX, CHANNEL_PREFIX]);
}

export function normalizeMatrixMessagingTarget(raw: string): string | undefined {
  const normalized = stripKnownPrefixes(raw, [
    MATRIX_PREFIX,
    ROOM_PREFIX,
    CHANNEL_PREFIX,
    USER_PREFIX,
  ]);
  return normalized || undefined;
}

export function normalizeMatrixDirectoryUserId(raw: string): string | undefined {
  const normalized = stripKnownPrefixes(raw, [MATRIX_PREFIX, USER_PREFIX]);
  if (!normalized || normalized === "*") {
    return undefined;
  }
  return isMatrixQualifiedUserId(normalized) ? `user:${normalized}` : normalized;
}

export function normalizeMatrixDirectoryGroupId(raw: string): string | undefined {
  const normalized = stripKnownPrefixes(raw, [MATRIX_PREFIX]);
  if (!normalized || normalized === "*") {
    return undefined;
  }
  const lowered = normalized.toLowerCase();
  if (lowered.startsWith(ROOM_PREFIX) || lowered.startsWith(CHANNEL_PREFIX)) {
    return normalized;
  }
  if (normalized.startsWith("!")) {
    return `room:${normalized}`;
  }
  return normalized;
}

export function resolveMatrixDirectUserId(params: {
  from?: string;
  to?: string;
  chatType?: string;
}): string | undefined {
  if (params.chatType !== "direct") {
    return undefined;
  }
  const roomId = normalizeMatrixResolvableTarget(params.to ?? "");
  if (!roomId.startsWith("!")) {
    return undefined;
  }
  const userId = stripKnownPrefixes(params.from ?? "", [MATRIX_PREFIX, USER_PREFIX]);
  return isMatrixQualifiedUserId(userId) ? userId : undefined;
}
