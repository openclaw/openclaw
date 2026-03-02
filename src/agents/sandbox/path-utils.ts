import path from "node:path";

export function normalizeContainerPath(value: string): string {
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === "/") {
    return "/";
  }
  // Strip trailing slash to ensure consistent boundary comparisons.
  // Without this, a workdir configured as "/workspace/" would fail
  // isPathInsideContainerRoot checks against paths normalized without
  // the trailing slash (e.g. mkdirp for "/workspace").
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function isPathInsideContainerRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizeContainerPath(root);
  const normalizedTarget = normalizeContainerPath(target);
  if (normalizedRoot === "/") {
    return true;
  }
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}
