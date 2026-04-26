const UUID_HYPHENATED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_RE = /^[0-9a-f]{32}$/i;

export function isStrictUuid(value: string): boolean {
  return UUID_HYPHENATED_RE.test(value) || UUID_COMPACT_RE.test(value);
}

export function looksLikeUuid(value: string): boolean {
  if (isStrictUuid(value)) {
    return true;
  }
  const compact = value.replace(/-/g, "");
  if (!/^[0-9a-f]+$/i.test(compact)) {
    return false;
  }
  return /[a-f]/i.test(compact);
}
