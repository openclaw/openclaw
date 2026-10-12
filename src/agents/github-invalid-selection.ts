import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { GitHubIdentityFacts } from "../../packages/gateway-protocol/src/index.js";
import type { GitHubToolIdentityConfig } from "../config/types.tools.js";
import { splitShellArgs } from "../utils/shell-argv.js";
import { parsePreflightShellSegment } from "./bash-tools.exec-script-target.js";

export const INVALID_GITHUB_PROFILE_SELECTION_MESSAGE =
  "Saved GitHub Identity profile id is invalid. Reconnect GitHub Identity, or clear the selection to use native authentication, then retry.";

/**
 * Non-empty so GitHub CLI treats the variable as set and does not fall through
 * to the OS keyring or another saved account. This is not a credential.
 */
export const INVALID_GITHUB_SELECTION_EXEC_TOKEN = "openclaw-invalid-github-profile";

export type ConfiguredGitHubToolIdentity = {
  source: "agent-override" | "system-configured";
  config: GitHubToolIdentityConfig;
  profileDir: string;
};

export type InvalidGitHubToolIdentity = {
  source: "agent-override" | "system-configured";
  config: GitHubToolIdentityConfig;
  invalidSelection: true;
};

export type DetectedGitHubToolIdentity = {
  source: "system-detected";
};

export type ScopedGitHubToolIdentity = ConfiguredGitHubToolIdentity | InvalidGitHubToolIdentity;

export type ResolvedGitHubToolIdentity =
  | ConfiguredGitHubToolIdentity
  | InvalidGitHubToolIdentity
  | DetectedGitHubToolIdentity;

export function isInvalidGitHubToolIdentity(
  identity: ResolvedGitHubToolIdentity,
): identity is InvalidGitHubToolIdentity {
  return "invalidSelection" in identity && identity.invalidSelection === true;
}

export function isConfiguredGitHubToolIdentity(
  identity: ResolvedGitHubToolIdentity,
): identity is ConfiguredGitHubToolIdentity {
  return identity.source !== "system-detected" && !isInvalidGitHubToolIdentity(identity);
}

export function unavailableGitHubIdentityFacts(
  identity: InvalidGitHubToolIdentity,
  gitAuthor: { name: string | null; email: string | null },
): GitHubIdentityFacts {
  const oauth = identity.config.kind === "oauth";
  return {
    source: identity.source,
    credentialKind: oauth ? "managed-oauth" : "managed-pat",
    credentialState: "configured_unavailable",
    account: null,
    gitAuthor,
    evidence: "none",
    accessExpiresAtMs: null,
    refreshState: oauth ? "unavailable" : "not_applicable",
    oauthScopes: [],
    repositoryGrants: "unknown",
  };
}

/** A profile directory that is never created, so credential launch fails closed. */
export function unavailableGitHubExecProfileDir(): string {
  return path.join(os.tmpdir(), `openclaw-invalid-github-${randomBytes(8).toString("hex")}`);
}

function isGitHubCliExecutable(token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  const base = token.split(/[/\\]/u).at(-1)?.toLowerCase() ?? "";
  const name = base.endsWith(".exe") ? base.slice(0, -4) : base;
  return name === "gh";
}

/** Splits top-level shell commands. Unterminated quotes or escapes return null. */
function splitCommandSegments(command: string): string[] | null {
  const segments: string[] = [];
  let buf = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = () => {
    if (buf.trim()) {
      segments.push(buf);
    }
    buf = "";
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? "";
    const next = command[i + 1];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (quote !== "'" && ch === "\\") {
      buf += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      buf += ch;
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";") {
      push();
      continue;
    }
    if ((ch === "&" || ch === "|") && next === ch) {
      push();
      i += 1;
      continue;
    }
    if (ch === "|" || ch === "&") {
      push();
      continue;
    }
    buf += ch;
  }
  if (escaped || quote) {
    return null;
  }
  push();
  return segments;
}

/**
 * True when a gateway command would invoke GitHub CLI, including pipelines.
 * Unparseable shell is treated as credential-bound so it cannot inherit another account.
 */
export function commandInvokesGitHubCli(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (!segments) {
    return true;
  }
  return segments.some((segment) => {
    if (splitShellArgs(segment.trim()) === null) {
      return true;
    }
    return isGitHubCliExecutable(parsePreflightShellSegment(segment)[0]);
  });
}
