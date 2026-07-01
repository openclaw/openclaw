/**
 * Managed-binary resolution for the Claude bridge, mirroring
 * extensions/codex/src/app-server/managed-binary.ts.
 *
 * By default (commandSource "managed") the bridge the gateway spawns is the one
 * bundled in the plugin's own node_modules — kept in lockstep with the
 * dependency pin in extensions/claude/package.json. This resolves that bundled
 * binary to an absolute path before spawn so the version is deterministic and
 * an operator can't accidentally run a drifting PATH copy. An explicit
 * appServer.command / OPENCLAW_CLAUDE_APP_SERVER_BIN override (commandSource
 * "config"/"env") is passed through untouched.
 */

import { constants as fsConstants, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeAppServerStartOptions } from "./client.js";
import { CLAUDE_BRIDGE_BIN_ENV } from "./config.js";
import { MANAGED_CLAUDE_BRIDGE_PACKAGE } from "./version.js";

const CLAUDE_BRIDGE_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_PLUGIN_ROOT = resolveDefaultClaudePluginRoot(CLAUDE_BRIDGE_MODULE_DIR);
const BIN_NAME = "openclaw-claude-bridge";

type ResolveManagedClaudeBridgeOptions = {
  platform?: NodeJS.Platform;
  pluginRoot?: string;
  pathExists?: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
};

/**
 * Resolve a "managed" start command to the bundled binary's absolute path.
 * Passes through any explicit override (commandSource config/env) and any
 * already-resolved command. Throws a clear, actionable error when the managed
 * binary can't be found (a stale/incomplete install).
 */
export async function resolveManagedClaudeBridgeStartOptions(
  startOptions: ClaudeAppServerStartOptions,
  options: ResolveManagedClaudeBridgeOptions = {},
): Promise<ClaudeAppServerStartOptions> {
  if (startOptions.commandSource !== "managed") {
    return startOptions;
  }
  const platform = options.platform ?? process.platform;
  const candidates = resolveManagedClaudeBridgeCommandCandidates(
    options.pluginRoot ?? CLAUDE_PLUGIN_ROOT,
    platform,
  );
  const pathExists = options.pathExists ?? commandPathExists;
  const commandPath = await findManagedClaudeBridgeCommandPath({
    candidates,
    pathExists,
    platform,
  });
  return { ...startOptions, command: commandPath, commandSource: "resolved-managed" };
}

/**
 * Best-effort version of the bundled (managed) bridge as it sits on disk, read
 * from its package.json via Node resolution. Used by /claude version to show a
 * pending-restart indicator. Returns undefined when it can't be resolved.
 */
export function resolveManagedClaudeBridgeVersion(
  pluginRoot: string = CLAUDE_PLUGIN_ROOT,
): string | undefined {
  for (const root of resolveCandidateRoots(pluginRoot, process.platform)) {
    try {
      const requireFromRoot = createRequire(path.join(root, "package.json"));
      const packageJsonPath = requireFromRoot.resolve(
        `${MANAGED_CLAUDE_BRIDGE_PACKAGE}/package.json`,
      );
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      /* try the next root */
    }
  }
  return undefined;
}

function resolveManagedClaudeBridgeCommandCandidates(
  pluginRoot: string,
  platform: NodeJS.Platform,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const commandName = platform === "win32" ? `${BIN_NAME}.cmd` : BIN_NAME;
  const roots = resolveCandidateRoots(pluginRoot, platform);
  return [
    ...new Set([
      ...roots.map((root) => pathApi.join(root, "node_modules", ".bin", commandName)),
      ...resolvePackageBinCandidates(roots, platform),
    ]),
  ];
}

function resolveCandidateRoots(pluginRoot: string, platform: NodeJS.Platform): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return [
    pluginRoot,
    pathApi.dirname(pluginRoot),
    pathApi.dirname(pathApi.dirname(pluginRoot)),
    pathApi.dirname(pathApi.dirname(pathApi.dirname(pluginRoot))),
  ].filter((root, index, all) => Boolean(root) && all.indexOf(root) === index);
}

function resolvePackageBinCandidates(
  roots: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  // Windows cannot spawn the raw `bin/*.mjs` directly (no shebang execution); it
  // needs the npm-generated `.bin/*.cmd` shim, which is already a candidate. So
  // on win32 skip the package-bin fallback — mirrors codex's
  // resolveManagedCodexPackageBinCandidates — and let a missing shim fall through
  // to the actionable "binary not found" throw instead of a confusing spawn error.
  if (platform === "win32") {
    return [];
  }
  const candidates: string[] = [];
  for (const root of roots) {
    try {
      const requireFromRoot = createRequire(path.join(root, "package.json"));
      const packageJsonPath = requireFromRoot.resolve(
        `${MANAGED_CLAUDE_BRIDGE_PACKAGE}/package.json`,
      );
      const packageRoot = path.dirname(packageJsonPath);
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { bin?: unknown };
      const binPath =
        typeof pkg.bin === "string"
          ? pkg.bin
          : isRecord(pkg.bin) && typeof pkg.bin[BIN_NAME] === "string"
            ? pkg.bin[BIN_NAME]
            : null;
      if (binPath) {
        candidates.push(path.resolve(packageRoot, binPath));
      }
    } catch {
      /* root without the package — try the next */
    }
  }
  return candidates;
}

async function findManagedClaudeBridgeCommandPath(params: {
  candidates: readonly string[];
  pathExists: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
  platform: NodeJS.Platform;
}): Promise<string> {
  for (const candidate of params.candidates) {
    if (await params.pathExists(candidate, params.platform)) {
      return candidate;
    }
  }
  throw new Error(
    [
      `Managed ${MANAGED_CLAUDE_BRIDGE_PACKAGE} binary was not found.`,
      "Reinstall or update OpenClaw, or run pnpm install in a source checkout.",
      `Set plugins.entries.claude.config.appServer.command or ${CLAUDE_BRIDGE_BIN_ENV} to use a custom bridge binary.`,
    ].join(" "),
  );
}

async function commandPathExists(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(filePath, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDefaultClaudePluginRoot(moduleDir: string): string {
  const moduleBaseName = path.basename(moduleDir);
  if (moduleBaseName === "dist" || moduleBaseName === "dist-runtime") {
    return path.dirname(moduleDir);
  }
  // src/app-server -> extensions/claude
  return path.resolve(moduleDir, "..", "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
