import path from "node:path";

function stripWindowsLongPathPrefix(value) {
  if (value.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  }
  if (value.startsWith("\\\\?\\")) {
    return value.slice("\\\\?\\".length);
  }
  return value;
}

export function normalizeComparablePath(input) {
  if (typeof input !== "string") {
    return "";
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  const stripped = stripWindowsLongPathPrefix(trimmed);
  const normalized = path.normalize(path.resolve(stripped));
  if (process.platform === "win32") {
    return normalized.replaceAll("/", "\\").toLowerCase();
  }
  return normalized;
}

export function pathsEqual(left, right) {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  if (!normalizedLeft || !normalizedRight) {
    return normalizedLeft === normalizedRight;
  }
  return normalizedLeft === normalizedRight;
}
