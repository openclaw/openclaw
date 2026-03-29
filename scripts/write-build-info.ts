import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type ExecSyncLike = typeof execSync;

export function readPackageVersion(pkgPath: string) {
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function readGitText(
  command: string,
  options: {
    rootDir: string;
    execSyncImpl?: ExecSyncLike;
  },
): string | null {
  const execSyncImpl = options.execSyncImpl ?? execSync;
  try {
    const raw = execSyncImpl(command, {
      cwd: options.rootDir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return raw.toString().trim();
  } catch {
    return null;
  }
}

export function resolveCommit(
  options: {
    rootDir?: string;
    env?: NodeJS.ProcessEnv;
    execSyncImpl?: ExecSyncLike;
  } = {},
) {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? repoRoot;
  const envCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  if (envCommit) {
    return envCommit;
  }
  return readGitText("git rev-parse HEAD", {
    rootDir,
    execSyncImpl: options.execSyncImpl,
  });
}

export function resolveDisplayVersionMarker(
  options: {
    rootDir?: string;
    env?: NodeJS.ProcessEnv;
    execSyncImpl?: ExecSyncLike;
  } = {},
) {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? repoRoot;
  const explicitMarker = env.OPENCLAW_DISPLAY_VERSION_MARKER?.trim();
  if (explicitMarker) {
    return explicitMarker;
  }
  const gitStatus = readGitText("git status --porcelain --untracked-files=normal", {
    rootDir,
    execSyncImpl: options.execSyncImpl,
  });
  return gitStatus ? "dirty" : null;
}

export function createBuildInfo(
  options: {
    rootDir?: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    execSyncImpl?: ExecSyncLike;
  } = {},
) {
  const rootDir = options.rootDir ?? repoRoot;
  const pkgPath = path.join(rootDir, "package.json");
  return {
    version: readPackageVersion(pkgPath),
    displayVersionMarker: resolveDisplayVersionMarker({
      rootDir,
      env: options.env,
      execSyncImpl: options.execSyncImpl,
    }),
    commit: resolveCommit({
      rootDir,
      env: options.env,
      execSyncImpl: options.execSyncImpl,
    }),
    builtAt: (options.now ?? new Date()).toISOString(),
  };
}

export function writeBuildInfo(
  options: {
    rootDir?: string;
    distDir?: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    execSyncImpl?: ExecSyncLike;
  } = {},
) {
  const rootDir = options.rootDir ?? repoRoot;
  const distDir = options.distDir ?? path.join(rootDir, "dist");
  const buildInfo = createBuildInfo({
    rootDir,
    env: options.env,
    now: options.now,
    execSyncImpl: options.execSyncImpl,
  });
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, "build-info.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
  );
  return buildInfo;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeBuildInfo();
}
