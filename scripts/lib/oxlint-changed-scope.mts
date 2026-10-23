import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Leave headroom below the per-environment-string limit on Linux.
const MAX_CHANGED_PATHS_BYTES = 32 * 1024;
const OXLINT_CHANGED_BASE_ENV = "OPENCLAW_OXLINT_CHANGED_BASE";
const OXLINT_TRUSTED_POLICY_REF_ENV = "OPENCLAW_OXLINT_TRUSTED_POLICY_REF";

export function isOxlintCommand(command: { args: string[]; bin?: string }) {
  return command.bin === "node"
    ? command.args[0] === "scripts/run-oxlint.mjs"
    : !command.bin && /^lint(?::(?:all|core|extensions|scripts))?$/u.test(command.args[0] ?? "");
}

type ChangedOxlintContext = {
  base?: string;
  cwd?: string;
  trustedPolicyRef?: string;
};

function isReleaseVersionOnlyPackageManifestUpdate(before: string, after: string) {
  let beforeVersion: unknown;
  let afterVersion: unknown;
  try {
    beforeVersion = (JSON.parse(before) as { version?: unknown }).version;
    afterVersion = (JSON.parse(after) as { version?: unknown }).version;
  } catch {
    return false;
  }
  return (
    typeof beforeVersion === "string" &&
    typeof afterVersion === "string" &&
    beforeVersion !== afterVersion &&
    before.replaceAll(beforeVersion, afterVersion) === after
  );
}

function isReleaseVersionOnlyPackageManifest(file: string, context: ChangedOxlintContext) {
  const base = context.base;
  const cwd = context.cwd ?? process.cwd();
  if (!base) {
    return false;
  }
  try {
    const before = execFileSync("git", ["show", `${base}:${file}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const after = fs.readFileSync(path.join(cwd, file), "utf8");
    return isReleaseVersionOnlyPackageManifestUpdate(before, after);
  } catch {
    return false;
  }
}

function matchesTrustedPolicyFile(file: string, context: ChangedOxlintContext) {
  const trustedPolicyRef = context.trustedPolicyRef;
  const cwd = context.cwd ?? process.cwd();
  if (!trustedPolicyRef) {
    return false;
  }
  try {
    const trusted = execFileSync("git", ["show", `${trustedPolicyRef}:${file}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return fs.readFileSync(path.join(cwd, file), "utf8") === trusted;
  } catch {
    return false;
  }
}

function isOxlintPolicyFile(file: string) {
  return (
    /(?:^|\/)(?:\.oxlintrc(?:\.[^/]*)?|oxlint\.config\.[^/]+|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.pnpmfile\.[cm]?js|\.npmrc)$/u.test(
      file,
    ) ||
    file.startsWith("patches/") ||
    /^scripts\/(?:check-changed|changed-lanes|run-lint|run-oxlint(?:-shards)?)\.m[jt]s$/u.test(
      file,
    ) ||
    /^scripts\/lib\/(?:oxlint-changed-scope|check-limits|local-check-runtime)\.mts$/u.test(file)
  );
}

function changesOxlintPolicy(paths: string[], context: ChangedOxlintContext = {}) {
  return paths.some(
    (file) =>
      (isOxlintPolicyFile(file) && !matchesTrustedPolicyFile(file, context)) ||
      (path.basename(file) === "package.json" &&
        !isReleaseVersionOnlyPackageManifest(file, context)),
  );
}

export function createChangedOxlintEnv(
  paths: string[],
  env: NodeJS.ProcessEnv,
  context: ChangedOxlintContext = {},
) {
  const serialized = JSON.stringify(paths);
  const effectiveContext = {
    ...context,
    base: context.base ?? env.CHECKOUT_BASE_SHA,
    trustedPolicyRef: context.trustedPolicyRef ?? env[OXLINT_TRUSTED_POLICY_REF_ENV],
  };
  const scopeEnabled =
    !changesOxlintPolicy(paths, effectiveContext) &&
    Buffer.byteLength(serialized) <= MAX_CHANGED_PATHS_BYTES;
  return {
    ...env,
    OPENCLAW_OXLINT_CHANGED_PATHS: scopeEnabled ? serialized : undefined,
    [OXLINT_CHANGED_BASE_ENV]: scopeEnabled ? effectiveContext.base : undefined,
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
  if (
    paths.some((file) => path.resolve(file) === configPath) ||
    changesOxlintPolicy(paths, {
      base: env[OXLINT_CHANGED_BASE_ENV],
      trustedPolicyRef: env[OXLINT_TRUSTED_POLICY_REF_ENV],
    })
  ) {
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
