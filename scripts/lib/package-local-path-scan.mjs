const DEFAULT_TEXT_DIST_FILE_RE = /^dist\/.*\.(?:cjs|d\.ts|js|json|mjs)$/u;
const DEFAULT_LOCAL_PATH_PATTERNS = [
  { label: "/Users/", pattern: /\/Users\/[^"'`\s<>()]+/gu },
  { label: "/home/", pattern: /\/home\/[^"'`\s<>()]+/gu },
  { label: "/private/var/", pattern: /\/private\/var\/[^"'`\s<>()]+/gu },
  { label: "C:\\Users\\", pattern: /[A-Za-z]:\\Users\\[^"'`\s<>()]+/gu },
];

function normalizePackagePath(value) {
  return value.replace(/\\/gu, "/").replace(/^package\//u, "");
}

function normalizeSearchPath(value) {
  return value.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeMatch(value) {
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function isDefaultScannablePackagePath(relativePath) {
  return DEFAULT_TEXT_DIST_FILE_RE.test(relativePath) && !relativePath.includes("/node_modules/");
}

function isIntentionalExampleOrPlatformPath(value) {
  return (
    value.startsWith("/home/linuxbrew/.linuxbrew") ||
    value.startsWith("/home/package-manager") ||
    value.startsWith("/home/user/") ||
    value.startsWith("/home/.../") ||
    value.startsWith("/Users/*/") ||
    value.startsWith("/Users/alice/") ||
    value === "/private/var/run" ||
    value.startsWith("/private/var/run/")
  );
}

export function collectPackageLocalAbsolutePathContentErrors(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const scannablePath =
    params.scannablePath ?? ((relativePath) => isDefaultScannablePackagePath(relativePath));
  const roots = [...new Set((params.forbiddenRoots ?? []).map(normalizeSearchPath))]
    .filter(Boolean)
    .filter((root) => root.length > 1)
    .toSorted((left, right) => right.length - left.length);
  const rootPatterns = roots.map((root) => ({
    label: "current repo root",
    pattern: new RegExp(`${escapeRegExp(root)}(?:/[^"'\\s<>()]*)?`, "gu"),
  }));
  const patterns = [...DEFAULT_LOCAL_PATH_PATTERNS, ...rootPatterns];
  const errors = [];

  for (const relativePath of files) {
    if (!scannablePath(relativePath)) {
      continue;
    }
    let source;
    try {
      source = params.readText(relativePath);
    } catch {
      continue;
    }
    const matches = new Set();
    for (const { pattern } of patterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        if (match[0] && !isIntentionalExampleOrPlatformPath(match[0])) {
          matches.add(normalizeMatch(match[0]));
        }
      }
    }
    if (matches.size > 0) {
      errors.push(
        `${relativePath} contains local absolute path reference(s): ${[...matches]
          .toSorted((left, right) => left.localeCompare(right))
          .join(", ")}`,
      );
    }
  }

  return errors;
}
