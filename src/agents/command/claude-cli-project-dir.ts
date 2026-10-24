import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const MAX_SANITIZED_PROJECT_LENGTH = 200;

export function resolveClaudeCliProjectsDir(homeDir?: string): string {
  // An explicit home scopes offline reads; ordinary runs share Claude's selected config root.
  const configuredDir = homeDir === undefined ? process.env.CLAUDE_CONFIG_DIR?.trim() : undefined;
  const configDir = configuredDir
    ? path.resolve(configuredDir)
    : path.join(normalizeOptionalString(homeDir) || process.env.HOME || os.homedir(), ".claude");
  return path.join(configDir.normalize("NFC"), "projects");
}

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

export function resolveClaudeCliProjectDirForWorkspace(params: {
  workspaceDir: string;
  homeDir?: string;
}): string {
  const canonicalWorkspaceDir = canonicalizeWorkspaceDir(params.workspaceDir);
  return path.join(
    resolveClaudeCliProjectsDir(params.homeDir),
    sanitizeClaudeCliProjectKey(canonicalWorkspaceDir),
  );
}
