import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveRepoRoot } from "./repo-root.mjs";

type BunPin = {
  tag: string;
  artifacts: Record<string, { executableSha256: string }>;
};
type PinnedBunResult = { command: string; reason?: never } | { command?: never; reason: string };
type PinnedBunDeps = {
  fs: typeof fs;
  repoRoot: string;
  platform: string;
  arch: string;
  homedir: () => string;
  stage: (destination: string, platform: string, arch: string) => void;
};

// Prepared worker copies still consume the checkout's pin and stager.
const repoRoot = resolveRepoRoot(import.meta.url);
const defaults: PinnedBunDeps = {
  fs,
  repoRoot,
  platform: process.platform,
  arch: process.arch,
  homedir,
  stage(destination, platform, arch) {
    execFileSync(
      "/bin/bash",
      [path.join(repoRoot, "scripts/stage-openclaw-bun.sh"), destination, platform, arch],
      { stdio: "pipe" },
    );
  },
};

export function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI && env.CI !== "false");
}

export function resolvePinnedBun(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<PinnedBunDeps> = {},
): PinnedBunResult {
  const deps = { ...defaults, ...overrides };
  const override = env.OPENCLAW_BUN_PATH?.trim();
  if (override) {
    const command = path.resolve(override);
    try {
      deps.fs.accessSync(command, fs.constants.X_OK);
      if (deps.fs.statSync(command).isFile()) {
        return { command };
      }
    } catch {
      // An explicit override never silently selects a different Bun installation.
    }
    return { reason: `OPENCLAW_BUN_PATH is not executable: ${command}` };
  }
  if (isCiEnvironment(env)) {
    return { command: "bun" };
  }
  const target = `${deps.platform}-${deps.arch}`;
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    return { reason: `unsupported platform ${target}` };
  }
  try {
    const pin: BunPin = JSON.parse(
      deps.fs.readFileSync(path.join(deps.repoRoot, "scripts/lib/openclaw-bun.json"), "utf8"),
    );
    const artifact = pin.artifacts[target];
    if (!artifact) {
      return { reason: `no pinned artifact for ${target}` };
    }
    const directory = path.resolve(
      env.XDG_CACHE_HOME || path.join(deps.homedir(), ".cache"),
      "openclaw/bun",
      pin.tag,
      target,
    );
    const command = path.join(directory, "bin/bun");
    const stampPath = path.join(directory, "verified.json");
    const stampFor = (stat: fs.Stats) => ({
      executableSha256: artifact.executableSha256,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    try {
      deps.fs.accessSync(command, fs.constants.X_OK);
      const stat = deps.fs.statSync(command);
      const expected = stampFor(stat);
      let stamp;
      try {
        stamp = JSON.parse(deps.fs.readFileSync(stampPath, "utf8"));
      } catch {
        // Old or interrupted caches are verified once before reuse.
      }
      if (
        stamp?.executableSha256 === expected.executableSha256 &&
        stamp?.size === expected.size &&
        stamp?.mtimeMs === expected.mtimeMs
      ) {
        return { command };
      }
      const digest = createHash("sha256").update(deps.fs.readFileSync(command)).digest("hex");
      if (digest === artifact.executableSha256) {
        deps.fs.writeFileSync(stampPath, JSON.stringify(expected));
        return { command };
      }
    } catch {
      // A missing or damaged cache is repaired by the checksum-verifying stager.
    }
    deps.fs.mkdirSync(path.join(directory, "bin"), { recursive: true });
    const staging = deps.fs.mkdtempSync(path.join(directory, ".stage-"));
    try {
      console.error(`[openclaw] Staging pinned Bun fork ${pin.tag} (one-time download)…`);
      deps.stage(staging, deps.platform, deps.arch);
      // Publish complete bytes so concurrent local launchers cannot execute a partial copy.
      deps.fs.renameSync(path.join(staging, "bin/bun"), command);
      deps.fs.writeFileSync(stampPath, JSON.stringify(stampFor(deps.fs.statSync(command))));
    } finally {
      deps.fs.rmSync(staging, { recursive: true, force: true });
    }
    return { command };
  } catch (error) {
    const cause = (error instanceof Error ? error.message : String(error)).split(/\r?\n/u, 1)[0];
    return { reason: `could not stage the pinned fork: ${cause}` };
  }
}

export function requirePinnedBun(env: NodeJS.ProcessEnv = process.env): string {
  const result = resolvePinnedBun(env);
  if (!result.command) {
    throw new Error(
      `[openclaw] Bun fork unavailable (${result.reason}). Set OPENCLAW_BUN_PATH to an executable or OPENCLAW_VITEST_RUNTIME=node.`,
    );
  }
  return result.command;
}

export function pinnedBunEnv(command: string, env: NodeJS.ProcessEnv): { PATH: string } {
  return {
    PATH: path.isAbsolute(command)
      ? [path.dirname(command), env.PATH].filter(Boolean).join(path.delimiter)
      : (env.PATH ?? ""),
  };
}
