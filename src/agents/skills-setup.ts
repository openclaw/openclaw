import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import {
  sanitizeHostExecEnv,
  isDangerousHostEnvVarName,
  isDangerousHostEnvOverrideVarName,
  normalizeEnvVarKey,
} from "../infra/host-env-security.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { parseFrontmatter, resolveOpenClawMetadata } from "./skills/frontmatter.js";

const SKILL_MD_CANDIDATES = ["SKILL.md", "skill.md", "skills.md", "SKILL.MD"] as const;

const DEFAULT_SETUP_TIMEOUT_MS = 60_000;
const MAX_SETUP_TIMEOUT_MS = 300_000;

function findSkillMd(targetDir: string): string | null {
  for (const candidate of SKILL_MD_CANDIDATES) {
    const filePath = path.join(targetDir, candidate);
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      return filePath;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export type SkillSetupResult =
  | { ok: true }
  | { ok: false; error: string; failureKind: "setup-failed" | "timeout" };

export type SkillSetupParams = {
  targetDir: string;
  mode: "install" | "update";
  logger?: {
    info?: (message: string) => void;
  };
};

export async function runSkillSetupHook(params: SkillSetupParams): Promise<SkillSetupResult> {
  const skillMdPath = findSkillMd(params.targetDir);
  if (!skillMdPath) {
    return { ok: true };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(skillMdPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read SKILL.md for setup hook: ${formatErrorMessage(err)}`,
      failureKind: "setup-failed",
    };
  }

  let frontmatter: Record<string, string>;
  try {
    frontmatter = parseFrontmatter(raw);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse SKILL.md frontmatter for setup hook: ${formatErrorMessage(err)}`,
      failureKind: "setup-failed",
    };
  }

  const metadata = resolveOpenClawMetadata(frontmatter);

  // Trust gate: Prevent automatic execution of setup hooks unless explicitly trusted
  if (!isSetupHookTrusted(metadata)) {
    return {
      ok: false,
      error:
        "Setup hooks require explicit trust. Set `trusted: true` in SKILL.md frontmatter or enable global config.",
      failureKind: "setup-failed",
    };
  }

  const setup = metadata?.setup;
  if (!setup) {
    return { ok: true };
  }

  const resolvedTargetDir = path.resolve(params.targetDir);
  let scriptPath = path.resolve(params.targetDir, setup.script);
  // Security: Use realpath to ensure symlink escape protection
  try {
    scriptPath = fs.realpathSync(scriptPath);
    const realTargetDir = fs.realpathSync(resolvedTargetDir);
    if (!scriptPath.startsWith(realTargetDir + path.sep)) {
      return {
        ok: false,
        error: `Setup script path escapes skill directory (realpath check): ${setup.script}`,
        failureKind: "setup-failed",
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to resolve setup script path: ${formatErrorMessage(err)}`,
      failureKind: "setup-failed",
    };
  }

  let executable: boolean;
  try {
    fs.accessSync(scriptPath, fs.constants.F_OK);
    executable = true;
  } catch {
    return {
      ok: false,
      error: `Setup script not found: ${setup.script}`,
      failureKind: "setup-failed",
    };
  }

  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
  } catch {
    executable = false;
  }

  const timeoutMs = Math.min(setup.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS, MAX_SETUP_TIMEOUT_MS);

  const requiredEnv = metadata?.requires?.env ?? [];

  // Collect allowed required environment variables with security filtering
  const allowedRequiredEnv: Record<string, string> = {};
  for (const envName of requiredEnv) {
    const key = normalizeEnvVarKey(envName);
    if (!key) continue;
    // Block dangerous host env keys that could compromise execution
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      continue;
    }
    const value = process.env[key];
    if (value !== undefined) {
      allowedRequiredEnv[key] = value;
    }
  }

  // Build a minimal, sanitized execution environment
  const baseEnv: Record<string, string | undefined> = {
    // Preserve PATH for shell/tool resolution
    PATH: process.env.PATH,
  };
  const scriptEnv = sanitizeHostExecEnv({
    baseEnv,
    overrides: allowedRequiredEnv,
  });
  // Inject setup-specific vars after sanitization
  scriptEnv.SKILL_DIR = resolvedTargetDir;
  scriptEnv.OPENCLAW_HOOK_KIND = params.mode;

  // Minimal execution environment: keep sanitized PATH and our injected variables

  // scriptEnv is already constructed above using sanitizeHostExecEnv

  const argv = executable ? [scriptPath] : ["sh", scriptPath];

  params.logger?.info?.(`Running setup hook: ${setup.script}`);

  try {
    const result = await runCommandWithTimeout(argv, {
      timeoutMs,
      cwd: resolvedTargetDir,
      env: scriptEnv,
      baseEnv: {},
    });

    if (result.code === 0) {
      return { ok: true };
    }

    const detail =
      result.termination === "timeout"
        ? `Setup hook timed out after ${timeoutMs}ms`
        : `Setup hook exited with code ${result.code ?? "null"}`;
    const stderrSuffix = result.stderr.trim() ? `: ${result.stderr.trim()}` : "";
    return {
      ok: false,
      error: `${detail}${stderrSuffix}`,
      failureKind: result.termination === "timeout" ? "timeout" : "setup-failed",
    };
  } catch (err) {
    return {
      ok: false,
      error: `Setup hook failed: ${formatErrorMessage(err)}`,
      failureKind: "setup-failed",
    };
  }
}

/**
 * Check if setup hooks are trusted to run.
 * This implements a trust gate to prevent automatic execution of potentially dangerous setup scripts.
 * Returns true if hooks are explicitly trusted (via metadata), false otherwise.
 *
 * TODO: Check global config flag `openclaw.config` when available.
 */
export function isSetupHookTrusted(metadata?: { trusted?: boolean }): boolean {
  return metadata?.trusted === true;
}
