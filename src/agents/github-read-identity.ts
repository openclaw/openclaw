import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "../infra/process-env.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { runCommandBuffered } from "../process/exec.js";

const GITHUB_IDENTITY_COMMAND_TIMEOUT_MS = 15_000;
export const GITHUB_IDENTITY_OUTPUT_LIMIT_BYTES = 32 * 1024;

export async function runGitHubIdentityCommand(
  argv: string[],
  env?: NodeJS.ProcessEnv,
  cwd?: string,
  timeoutMs = GITHUB_IDENTITY_COMMAND_TIMEOUT_MS,
) {
  return await runCommandBuffered(argv, {
    env: env ? { ...env } : {},
    cwd,
    timeoutMs,
    maxOutputBytes: GITHUB_IDENTITY_OUTPUT_LIMIT_BYTES,
  });
}

export function normalizeGitHubToken(token: string): string {
  const normalized = token.trim();
  if (!normalized || normalized.length > 2048 || /\s/u.test(normalized)) {
    throw new Error("Managed GitHub credential must be one non-empty line.");
  }
  registerSecretValueForRedaction(normalized);
  return normalized;
}

async function assertNoNativeGitHubConfiguration(env: NodeJS.ProcessEnv, cwd: string) {
  const value = (name: string) => resolveEnvironmentValue(env, name);
  const windows = process.platform === "win32";
  const nativePath = windows ? path.win32 : path.posix;
  const home = value(windows ? "USERPROFILE" : "HOME");
  const xdg = value("XDG_CONFIG_HOME");
  const appData = value("APPDATA");
  // Match gh's external config contract, including Windows USERPROFILE rather
  // than OpenClaw's own home overrides. Existing files remain indeterminate.
  const configured =
    value("GH_CONFIG_DIR") ||
    (xdg ? nativePath.join(xdg, "gh") : undefined) ||
    (windows && appData ? nativePath.join(appData, "GitHub CLI") : undefined) ||
    (home ? nativePath.join(home, ".config", "gh") : undefined);
  if (!configured) {
    throw new GitHubIdentityError("unverified");
  }
  const directory = nativePath.resolve(cwd, configured);
  for (const file of [
    directory,
    nativePath.join(directory, "config.yml"),
    nativePath.join(directory, "hosts.yml"),
  ]) {
    try {
      const stat = await fs.lstat(file);
      if (file !== directory || !stat.isDirectory() || stat.isSymbolicLink()) {
        throw new GitHubIdentityError("unavailable");
      }
    } catch (error) {
      if (error instanceof GitHubIdentityError) {
        throw error;
      }
      if (!hasErrnoCode(error, "ENOENT")) {
        throw new GitHubIdentityError("unverified");
      }
    }
  }
}

export async function readNativeGitHubToken(
  env: NodeJS.ProcessEnv,
  requireAbsentProof = false,
): Promise<string | undefined> {
  // Match child-process overlay semantics: an explicit undefined must keep a
  // preview or other owner's inherited credential scrubbed, including on Windows.
  const effectiveEnv = mergeProcessEnv([process.env, env]);
  const token =
    resolveEnvironmentValue(effectiveEnv, "GH_TOKEN") ||
    resolveEnvironmentValue(effectiveEnv, "GITHUB_TOKEN");
  if (token) {
    return normalizeGitHubToken(token);
  }
  const startedAt = performance.now();
  const result = await runGitHubIdentityCommand(
    ["gh", "auth", "token", "--hostname", "github.com"],
    env,
  );
  try {
    if (result.code === 0) {
      return normalizeGitHubToken(result.stdout.toString("utf8"));
    }
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
  if (!requireAbsentProof) {
    return undefined;
  }
  if (result.termination === "error") {
    try {
      const cwd = process.cwd();
      if (
        !hasErrnoCode(result.error, "ENOENT") ||
        !(await fs.stat(cwd)).isDirectory() ||
        resolveExecutablePath("gh", { env: effectiveEnv, cwd, useCache: false })
      ) {
        throw new GitHubIdentityError("unverified");
      }
      // An absent optional CLI on a clean host permits public reads. This does
      // not assert an empty OS keyring or fall back from a configured account.
      await assertNoNativeGitHubConfiguration(effectiveEnv, cwd);
      return undefined;
    } catch (error) {
      throw error instanceof GitHubIdentityError ? error : new GitHubIdentityError("unverified");
    }
  }
  if (result.termination !== "exit") {
    throw new GitHubIdentityError("unverified");
  }
  const remainingMs = GITHUB_IDENTITY_COMMAND_TIMEOUT_MS - Math.ceil(performance.now() - startedAt);
  if (remainingMs <= 0) {
    throw new GitHubIdentityError("unverified");
  }
  // gh's JSON status includes an entry even for locked, rejected, or timed-out
  // configured accounts. Only an empty host map proves anonymous admission.
  const observed = await runGitHubIdentityCommand(
    ["gh", "auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"],
    env,
    undefined,
    remainingMs,
  );
  try {
    if (observed.code !== 0) {
      throw new GitHubIdentityError("unverified");
    }
    let value: unknown;
    try {
      value = JSON.parse(observed.stdout.toString("utf8"));
    } catch {
      throw new GitHubIdentityError("unverified");
    }
    if (!isRecord(value) || !isRecord(value.hosts) || Object.keys(value).length !== 1) {
      throw new GitHubIdentityError("unverified");
    }
    if (Object.keys(value.hosts).length !== 0) {
      throw new GitHubIdentityError("unavailable");
    }
    return undefined;
  } finally {
    observed.stdout.fill(0);
    observed.stderr.fill(0);
  }
}

export type GitHubIdentityPreparation = {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
};
export type GitHubReadIdentityPreparation = GitHubIdentityPreparation & {
  getCurrentConfig: () => OpenClawConfig;
  assertActive: () => void;
  refresh: () => Promise<void>;
};

export class GitHubIdentityError extends Error {
  constructor(readonly reason: "unavailable" | "changed" | "rate_limited" | "unverified") {
    super(
      reason === "changed"
        ? "GitHub identity changed; reload the dashboard and retry."
        : reason === "rate_limited"
          ? "GitHub identity verification is rate limited; wait and retry."
          : reason === "unverified"
            ? "The effective GitHub identity could not be verified; retry or reconnect the agent's GitHub identity."
            : "The selected GitHub credential is unavailable; reconnect the agent's GitHub identity in Settings.",
    );
  }
}

export type GitHubReadIdentitySelection = Readonly<{
  source: "system-detected" | "system-configured" | "agent-override";
  profileId?: string;
  accountId: number;
}>;
type GitHubReadAuthority = {
  cacheScope: string;
  assertSelected: () => void;
  revalidate: () => Promise<void>;
};
export type PreparedGitHubReadIdentity = GitHubReadAuthority & {
  token: string;
  selection: GitHubReadIdentitySelection;
};
export type PreparedGitHubSourceReadIdentity =
  | PreparedGitHubReadIdentity
  | (GitHubReadAuthority & { token: undefined; selection: Readonly<{ source: "anonymous" }> });

export function createGitHubReadIdentity(
  params: {
    assertSelected: () => void;
    readToken: () => Promise<string | undefined>;
  } & (
    | { token: string; selection: GitHubReadIdentitySelection }
    | { token: undefined; selection: Readonly<{ source: "anonymous" }> }
  ),
): PreparedGitHubSourceReadIdentity {
  const { token, selection, assertSelected, readToken } = params;
  const authority: GitHubReadAuthority = {
    cacheScope:
      selection.source === "anonymous"
        ? "anonymous"
        : createHash("sha256")
            .update(
              JSON.stringify([selection.source, selection.profileId, selection.accountId, token]),
            )
            .digest("hex"),
    assertSelected,
    revalidate: async () => {
      assertSelected();
      const current = await readToken();
      assertSelected();
      if (current !== token) {
        throw new GitHubIdentityError("changed");
      }
    },
  };
  // Durable selection excludes credentials; the in-process result cache still
  // separates rotations, and later native sign-in closes anonymous authority.
  return params.token === undefined
    ? { ...authority, token: undefined, selection: Object.freeze(params.selection) }
    : { ...authority, token: params.token, selection: Object.freeze(params.selection) };
}
