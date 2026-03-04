/**
 * Add a skill from a Git URL: clone into managed skills dir and run npm install.
 * Used by CLI `openclaw skills add <url>` and Control UI "Add from URL".
 */

import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { runCommandWithTimeout, type CommandOptions } from "../process/exec.js";
import { CONFIG_DIR, ensureDir } from "../utils.js";
import { resolveSkillsInstallPreferences } from "./skills.js";

export type AddSkillFromUrlOptions = {
  url: string;
  managedSkillsDir?: string;
  config?: OpenClawConfig;
  cloneTimeoutMs?: number;
  installTimeoutMs?: number;
};

export type AddSkillFromUrlResult = {
  ok: boolean;
  name?: string;
  message: string;
};

/**
 * Returns true if name is safe to use as a skill directory name (no path traversal,
 * path separators, or null bytes). Allows non-ASCII and emoji (e.g. GitHub repo names).
 */
function isSafeSkillDirName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  if (name.includes("..")) {
    return false;
  }
  if (name.includes("/") || name.includes("\\")) {
    return false;
  }
  if (name.includes("\0")) {
    return false;
  }
  return true;
}

/**
 * Parse a Git repo URL and derive a safe directory name.
 * Only allows https URLs. Returns the last path segment (repo name) with .git stripped.
 */
export function parseSkillRepoUrl(url: string): { url: string; name: string } {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("URL is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only https URLs are allowed");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  let segment = pathname.split("/").filter(Boolean).pop() ?? "";
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // leave segment as-is if malformed percent-encoding
  }
  const name = segment.replace(/\.git$/i, "").trim();
  if (!isSafeSkillDirName(name)) {
    throw new Error(
      `Invalid repo name: must not contain .. / \\ or null bytes. Got: ${name || "(empty)"}`,
    );
  }
  return { url: trimmed, name };
}

/**
 * Clone a Git repo into the managed skills directory, then run npm/pnpm install
 * in that directory if package.json exists.
 */
export async function addSkillFromUrl(
  opts: AddSkillFromUrlOptions,
): Promise<AddSkillFromUrlResult> {
  const managedDir = opts.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const cloneTimeoutMs = opts.cloneTimeoutMs ?? 120_000;
  const installTimeoutMs = opts.installTimeoutMs ?? 120_000;

  let url: string;
  let name: string;
  try {
    const parsed = parseSkillRepoUrl(opts.url);
    url = parsed.url;
    name = parsed.name;
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const targetDir = path.join(managedDir, name);
  const targetDirResolved = path.resolve(targetDir);
  const managedDirResolved = path.resolve(managedDir);
  if (
    !targetDirResolved.startsWith(managedDirResolved + path.sep) &&
    targetDirResolved !== managedDirResolved
  ) {
    return { ok: false, message: "Invalid target path" };
  }

  try {
    await ensureDir(managedDir);
  } catch (err) {
    return {
      ok: false,
      message: `Failed to create skills directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const cloneOpts: CommandOptions = { timeoutMs: cloneTimeoutMs, cwd: managedDir };
  const cloneResult = await runCommandWithTimeout(
    ["git", "clone", "--depth", "1", url, name],
    cloneOpts,
  );
  if (cloneResult.code !== 0) {
    const stderr = cloneResult.stderr.trim() || cloneResult.stdout.trim();
    const dirExisted = fs.existsSync(targetDir);
    try {
      if (dirExisted) {
        fs.rmSync(targetDir, { recursive: true });
      }
    } catch {
      // ignore cleanup failure
    }
    const message = dirExisted
      ? `Skill directory already exists: ${name}. Remove it first or use a different URL.`
      : stderr
        ? `Clone failed: ${stderr}`
        : "Clone failed";
    return { ok: false, name, message };
  }

  const packageJsonPath = path.join(targetDir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const prefs = resolveSkillsInstallPreferences(opts.config);
    const installArgv = buildInstallArgv(prefs.nodeManager);
    const installResult = await runCommandWithTimeout(installArgv, {
      timeoutMs: installTimeoutMs,
      cwd: targetDir,
    });
    if (installResult.code !== 0) {
      const stderr = installResult.stderr.trim() || installResult.stdout.trim();
      return {
        ok: false,
        name,
        message: `Cloned successfully; dependency install failed: ${stderr || "unknown"}`,
      };
    }
  }

  return {
    ok: true,
    name,
    message: `Added skill "${name}". It will appear on the next refresh (no restart needed).`,
  };
}

/**
 * Build install argv with --ignore-scripts to avoid running lifecycle scripts
 * from untrusted skill repos (supply-chain safety).
 */
function buildInstallArgv(nodeManager: "npm" | "pnpm" | "yarn" | "bun"): string[] {
  switch (nodeManager) {
    case "pnpm":
      return ["pnpm", "install", "--omit=dev", "--ignore-scripts"];
    case "yarn":
      return ["yarn", "install", "--production", "--ignore-scripts"];
    case "bun":
      return ["bun", "install", "--production", "--ignore-scripts"];
    default:
      return ["npm", "install", "--omit=dev", "--ignore-scripts"];
  }
}
