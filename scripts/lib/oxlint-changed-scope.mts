import path from "node:path";

// Leave headroom below the per-environment-string limit on Linux.
const MAX_CHANGED_PATHS_BYTES = 32 * 1024;

export function isOxlintCommand(command: { args: string[]; bin?: string }) {
  return command.bin === "node"
    ? command.args[0] === "scripts/run-oxlint.mjs"
    : !command.bin && /^lint(?::(?:all|core|extensions|scripts))?$/u.test(command.args[0] ?? "");
}

function changesOxlintPolicy(paths: string[]) {
  return paths.some(
    (file) =>
      /(?:^|\/)(?:\.oxlintrc(?:\.[^/]*)?|oxlint\.config\.[^/]+|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.pnpmfile\.[cm]?js|\.npmrc)$/u.test(
        file,
      ) ||
      file.startsWith("patches/") ||
      /^scripts\/(?:check-changed|changed-lanes|run-lint|run-oxlint(?:-shards)?)\.m[jt]s$/u.test(
        file,
      ) ||
      /^scripts\/lib\/(?:oxlint-changed-scope|check-limits|local-check-runtime)\.mts$/u.test(file),
  );
}

export function createChangedOxlintEnv(paths: string[], env: NodeJS.ProcessEnv) {
  const serialized = JSON.stringify(paths);
  return {
    ...env,
    OPENCLAW_OXLINT_CHANGED_PATHS:
      !changesOxlintPolicy(paths) && Buffer.byteLength(serialized) <= MAX_CHANGED_PATHS_BYTES
        ? serialized
        : undefined,
  };
}

export function resolveUntouchedOxlintExclusions(configPath: string, env: NodeJS.ProcessEnv) {
  const serialized = env.OPENCLAW_OXLINT_CHANGED_PATHS;
  if (!serialized || Buffer.byteLength(serialized) > MAX_CHANGED_PATHS_BYTES) {
    return undefined;
  }
  const paths: unknown = JSON.parse(serialized);
  if (!Array.isArray(paths) || !paths.every((file): file is string => typeof file === "string")) {
    throw new Error("OPENCLAW_OXLINT_CHANGED_PATHS must contain a JSON array of changed paths");
  }
  if (paths.length === 0) {
    return undefined;
  }
  // These inputs can change caps or the linter itself without editing a reported file.
  if (paths.some((file) => path.resolve(file) === configPath) || changesOxlintPolicy(paths)) {
    return undefined;
  }
  return paths.map((file) => {
    const relative = path
      .relative(path.dirname(configPath), path.resolve(file))
      .split(path.sep)
      .join("/");
    // Oxlint makes bare filenames recursive; escape fast-glob syntax for literal Git paths.
    return `./${relative.replace(/[\\*?[\]{}!,]/gu, "\\$&")}`;
  });
}
