import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
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
  const setup = metadata?.setup;
  if (!setup) {
    return { ok: true };
  }

  const scriptPath = path.resolve(params.targetDir, setup.script);
  const resolvedTargetDir = path.resolve(params.targetDir);
  if (!scriptPath.startsWith(resolvedTargetDir + path.sep)) {
    return {
      ok: false,
      error: `Setup script path escapes skill directory: ${setup.script}`,
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

  const hookEnv: Record<string, string> = {
    SKILL_DIR: resolvedTargetDir,
    OPENCLAW_HOOK_KIND: params.mode,
  };

  const requiredEnv = metadata?.requires?.env ?? [];
  for (const envName of requiredEnv) {
    const trimmed = envName.trim();
    if (!trimmed || hookEnv[trimmed] !== undefined) {
      continue;
    }
    const value = process.env[trimmed];
    if (value !== undefined) {
      hookEnv[trimmed] = value;
    }
  }

  const scriptEnv: Record<string, string> = {};
  // Minimal execution environment: only PATH so shell and common tools resolve.
  if (process.env.PATH !== undefined) {
    scriptEnv.PATH = process.env.PATH;
  }
  Object.assign(scriptEnv, hookEnv);

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
