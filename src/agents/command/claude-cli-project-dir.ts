import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

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

type ClaudeCliProjectsRootParams = {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Root already selected from the Claude child's effective environment and cwd. */
  projectsRoot?: string;
  assertNativeHistoryAuthorized?: () => Promise<void>;
};

// A retained root records the environment the child actually ran with, which the
// Gateway's own environment cannot reproduce.
function retainedProjectsRoot(params: ClaudeCliProjectsRootParams): string | undefined {
  return typeof params.projectsRoot === "string" && params.projectsRoot
    ? params.projectsRoot
    : undefined;
}

function resolveClaudeCliProjectsDir(params: ClaudeCliProjectsRootParams): string {
  const env = params.env ?? process.env;
  const homeDir = normalizeOptionalString(params.homeDir) || env.HOME || os.homedir();
  // Native Claude uses nullish selection and NFC; empty values and spaces are paths.
  const configDir = (env.CLAUDE_CONFIG_DIR ?? path.join(homeDir, ".claude")).normalize("NFC");
  return path.join(configDir, "projects");
}

function isFullyQualifiedProjectsDir(projectsDir: string): boolean {
  // Windows \profile is absolute to a drive, but still needs the child's drive.
  return path.isAbsolute(projectsDir) && path.parse(projectsDir).root !== "\\";
}

export function resolveClaudeCliProjectDirForWorkspace(params: {
  workspaceDir: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  projectsRoot?: string;
}): string {
  const canonicalWorkspaceDir = canonicalizeWorkspaceDir(params.workspaceDir);
  return path.resolve(
    canonicalWorkspaceDir,
    retainedProjectsRoot(params) ?? resolveClaudeCliProjectsDir(params),
    sanitizeClaudeCliProjectKey(canonicalWorkspaceDir),
  );
}

/** Relative native roots require the child cwd, never an inferred Gateway cwd. */
export function resolveClaudeCliProjectsRoot(
  params: ClaudeCliProjectsRootParams,
): string | undefined {
  const retained = retainedProjectsRoot(params);
  if (retained) {
    return retained;
  }
  const projectsDir = resolveClaudeCliProjectsDir(params);
  if (isFullyQualifiedProjectsDir(projectsDir)) {
    return projectsDir;
  }
  return params.cwd ? path.resolve(canonicalizeWorkspaceDir(params.cwd), projectsDir) : undefined;
}

/** Keep native history discovery asynchronous, including symlinked child cwds. */
export async function resolveClaudeCliProjectsRootAsync(
  params: ClaudeCliProjectsRootParams,
): Promise<string | undefined> {
  const retained = retainedProjectsRoot(params);
  if (retained) {
    return retained;
  }
  const projectsDir = resolveClaudeCliProjectsDir(params);
  if (isFullyQualifiedProjectsDir(projectsDir)) {
    return projectsDir;
  }
  if (!params.cwd) {
    return undefined;
  }
  let cwd = path.resolve(params.cwd).normalize("NFC");
  await params.assertNativeHistoryAuthorized?.();
  try {
    cwd = (await fs.promises.realpath(cwd)).normalize("NFC");
  } catch {
    // Match the synchronous workspace resolver when the original directory is gone.
  }
  return path.resolve(cwd, projectsDir);
}
