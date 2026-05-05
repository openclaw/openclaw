import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

const CLAUDE_CLI_PROVIDER = "claude-cli";
const CLAUDE_PROJECTS_DIRNAME = path.join(".claude", "projects");
const MAX_SANITIZED_PROJECT_LENGTH = 200;

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

function canonicalizeWorkspaceDir(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).normalize("NFC");
  try {
    return fs.realpathSync.native(resolved).normalize("NFC");
  } catch {
    return resolved;
  }
}

/**
 * Resolve the directory the Claude CLI uses to store this workspace's session
 * transcripts. Mirrors the path-construction rules used by the `claude` binary:
 *   `~/.claude/projects/<sanitized-workspace>/`.
 *
 * Used by both `doctor` health checks and the read-through transcript resolver
 * for sessions whose modelProvider is `claude-cli`.
 */
export function resolveClaudeCliProjectDirForWorkspace(params: {
  workspaceDir: string;
  homeDir?: string;
}): string {
  const homeDir = normalizeOptionalString(params.homeDir) || process.env.HOME || os.homedir();
  const canonicalWorkspaceDir = canonicalizeWorkspaceDir(params.workspaceDir);
  return path.join(
    homeDir,
    CLAUDE_PROJECTS_DIRNAME,
    sanitizeClaudeCliProjectKey(canonicalWorkspaceDir),
  );
}

/**
 * Resolve the canonical transcript file owned by the Claude CLI for a given
 * session, when (and only when) the session is running under the `claude-cli`
 * model provider AND has a populated CLI session id.
 *
 * Returns `undefined` when the session is not CLI-bound, when required inputs
 * are missing, or when the resolved file does not yet exist on disk (callers
 * should fall back to the openclaw-store `sessionFile` candidate in that case).
 *
 * Read-only path resolution: this function never creates files or directories.
 */
export function resolveActiveCliTranscriptPath(params: {
  modelProvider?: string;
  cliSessionId?: string;
  workspaceDir?: string;
  homeDir?: string;
}): string | undefined {
  const provider = normalizeOptionalString(params.modelProvider);
  if (provider !== CLAUDE_CLI_PROVIDER) {
    return undefined;
  }
  const cliSessionId = normalizeOptionalString(params.cliSessionId);
  if (!cliSessionId) {
    return undefined;
  }
  const workspaceDir = normalizeOptionalString(params.workspaceDir);
  if (!workspaceDir) {
    return undefined;
  }
  const projectDir = resolveClaudeCliProjectDirForWorkspace({
    workspaceDir,
    homeDir: params.homeDir,
  });
  const candidate = path.join(projectDir, `${cliSessionId}.jsonl`);
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return candidate;
}
