import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const CLAUDE_DEFAULT_CONFIG_DIRNAME = ".claude";
const CLAUDE_PROJECTS_DIRNAME = "projects";
const MAX_SANITIZED_PROJECT_LENGTH = 200;

// Claude CLI stores project state under a sanitized workspace key. Add a stable
// hash when the key is truncated so long paths do not collide silently.
function simpleHash36(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function sanitizeClaudeCliProjectKey(workspaceDir: string): string {
  const sanitized = workspaceDir.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_PROJECT_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_SANITIZED_PROJECT_LENGTH)}-${simpleHash36(workspaceDir)}`;
}

// Realpath when possible so symlinked workspaces reuse the same Claude project
// directory as their canonical path.
function canonicalizeWorkspaceDir(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).normalize("NFC");
  try {
    return fs.realpathSync.native(resolved).normalize("NFC");
  } catch {
    return resolved;
  }
}

/**
 * Resolves the Claude CLI configuration directory that owns `projects/`.
 *
 * Claude Code writes every transcript under `$CLAUDE_CONFIG_DIR/projects/` when that
 * variable is set on the process that spawns it, and under `~/.claude/projects/`
 * otherwise. The Gateway forwards `CLAUDE_CONFIG_DIR` to the CLI (clear-env allowlist;
 * the documented way to give the Gateway a separate login), so the transcript probe
 * must follow the same rule or every turn reads as transcript-missing. An explicit
 * `homeDir` keeps the HOME-relative layout: callers and tests that inject a home are
 * describing a fixture, not a configured override.
 */
export function resolveClaudeCliConfigDir(params?: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const explicitHomeDir = normalizeOptionalString(params?.homeDir);
  if (explicitHomeDir) {
    return path.join(explicitHomeDir, CLAUDE_DEFAULT_CONFIG_DIRNAME);
  }
  const env = params?.env ?? process.env;
  const configuredDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configuredDir) {
    return path.resolve(configuredDir);
  }
  return path.join(env.HOME?.trim() || os.homedir(), CLAUDE_DEFAULT_CONFIG_DIRNAME);
}

/** Resolves Claude CLI's per-workspace project directory. */
export function resolveClaudeCliProjectDirForWorkspace(params: {
  workspaceDir: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const canonicalWorkspaceDir = canonicalizeWorkspaceDir(params.workspaceDir);
  return path.join(
    resolveClaudeCliConfigDir({ homeDir: params.homeDir, env: params.env }),
    CLAUDE_PROJECTS_DIRNAME,
    sanitizeClaudeCliProjectKey(canonicalWorkspaceDir),
  );
}
