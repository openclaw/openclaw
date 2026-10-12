import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "../infra/process-env.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { runCommandBuffered } from "../process/exec.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { resolveGitHubHost } from "./github-host-runtime.js";

const GITHUB_IDENTITY_COMMAND_TIMEOUT_MS = 15_000;
export const GITHUB_IDENTITY_OUTPUT_LIMIT_BYTES = 32 * 1024;

// Read/options only: host gh login/logout/switch detection can lag by 60 seconds,
// matching credential verification. Publication and environment tokens stay live.
const NATIVE_GITHUB_TOKEN_TTL_MS = 60_000;
let nativeTokens = new Map<string, { token: string; expiresAt: number }>();
const pendingNativeTokens = new Map<string, Promise<string | undefined>>();

export function clearNativeGitHubTokenCache(): void {
  // In-flight reads keep their old map and cannot repopulate the cleared cache.
  nativeTokens = new Map();
  pendingNativeTokens.clear();
}

function ambientGitHubCredential(env: NodeJS.ProcessEnv, host = resolveGitHubHost()) {
  const names =
    host === "github.com"
      ? (["GH_TOKEN", "GITHUB_TOKEN"] as const)
      : (["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const);
  const token = resolveEnvironmentValue(env, names[0]) || resolveEnvironmentValue(env, names[1]);
  if (
    token &&
    host !== "github.com" &&
    resolveEnvironmentValue(env, "GH_HOST")?.trim().toLowerCase() !== host
  ) {
    throw new GitHubIdentityError("unverified");
  }
  return { host, token };
}

export async function readCachedNativeGitHubToken(
  env: NodeJS.ProcessEnv,
  requireAbsentProof = false,
  githubHost = resolveGitHubHost(),
): Promise<string | undefined> {
  const effectiveEnv = mergeProcessEnv([process.env, env]);
  const { host, token } = ambientGitHubCredential(effectiveEnv, githubHost);
  if (token) {
    return normalizeGitHubToken(token);
  }
  // Include the complete command context: operators can provide gh wrappers,
  // and relative config/executable paths depend on the current directory.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        host,
        process.cwd(),
        Object.entries(effectiveEnv).toSorted(([left], [right]) => left.localeCompare(right)),
        requireAbsentProof,
      ]),
    )
    .digest("hex");
  const cache = nativeTokens;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  cache.delete(key);
  return getOrCreatePromise(
    pendingNativeTokens,
    key,
    async () => {
      const current = await readNativeGitHubToken(env, requireAbsentProof, host);
      // Failures and anonymous absence proofs remain live, so unreadable native
      // configuration cannot be hidden by a previously absent account.
      if (current !== undefined) {
        cache.set(key, { token: current, expiresAt: Date.now() + NATIVE_GITHUB_TOKEN_TTL_MS });
        pruneMapToMaxSize(cache, 32);
      }
      return current;
    },
    { evictOnSettled: true },
  );
}

export async function readGitAuthor(env: NodeJS.ProcessEnv, cwd: string) {
  const result = await runGitHubIdentityCommand(
    ["git", "config", "--null", "--get-regexp", "^user\\.(name|email)$"],
    env,
    cwd,
  );
  const author: { name: string | null; email: string | null } = { name: null, email: null };
  if (result.code !== 0) {
    return author;
  }
  for (const entry of result.stdout.toString("utf8").split("\0")) {
    const separator = entry.indexOf("\n");
    if (separator < 0) {
      continue;
    }
    const key = entry.slice(0, separator);
    const value = readNonBlankString(entry.slice(separator + 1))?.trim() ?? null;
    if (key === "user.name") {
      author.name = value;
    } else if (key === "user.email") {
      author.email = value;
    }
  }
  return author;
}

async function runGitHubIdentityCommand(
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
  githubHost = resolveGitHubHost(),
): Promise<string | undefined> {
  // Match child-process overlay semantics: an explicit undefined must keep a
  // preview or other owner's inherited credential scrubbed, including on Windows.
  const effectiveEnv = mergeProcessEnv([process.env, env]);
  const { token } = ambientGitHubCredential(effectiveEnv, githubHost);
  if (token) {
    return normalizeGitHubToken(token);
  }
  // gh also accepts public ambient tokens for ghe.com tenants. Native lookup
  // must read only the explicitly selected host's stored profile.
  const commandEnv = {
    ...env,
    GH_HOST: githubHost,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
  };
  const startedAt = performance.now();
  const result = await runGitHubIdentityCommand(
    ["gh", "auth", "token", "--hostname", githubHost],
    commandEnv,
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
    ["gh", "auth", "status", "--active", "--hostname", githubHost, "--json", "hosts"],
    commandEnv,
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
/** Release admission after starting the operation, before its asynchronous result settles. */
export type GitHubReadIdentityStarter = <T>(start: () => T) => Promise<Awaited<T>>;

export type GitHubReadIdentityPreparation = GitHubIdentityPreparation & {
  /** Fixed public capabilities ignore the repository host; other reads use its configured issuer. */
  issuer?: "github.com";
  /** Account display facts may refresh in the background; never grants write authority. */
  allowStale?: boolean;
  getCurrentConfig: () => OpenClawConfig;
  assertActive: () => void;
  startActive?: GitHubReadIdentityStarter;
  refresh: () => Promise<void>;
};

/** The caller's owner admits the operation; selection is checked inside that admission. */
export function startGitHubIdentityOperation<T>(
  operation: () => T,
  authority: { assertCurrent?: () => void; startCurrent?: GitHubReadIdentityStarter },
): T | Promise<Awaited<T>> {
  authority.assertCurrent?.();
  return authority.startCurrent
    ? authority.startCurrent(() => {
        authority.assertCurrent?.();
        return operation();
      })
    : operation();
}

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
  stale?: true;
  cacheScope: string;
  assertSelected: () => void;
  revalidate: () => Promise<void>;
  start: GitHubReadIdentityStarter;
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
    startActive?: GitHubReadIdentityStarter;
    readToken: () => Promise<string | undefined>;
    stale?: true;
  } & (
    | { token: string; selection: GitHubReadIdentitySelection }
    | { token: undefined; selection: Readonly<{ source: "anonymous" }> }
  ),
): PreparedGitHubSourceReadIdentity {
  const { token, selection, assertSelected, startActive, readToken } = params;
  const caller = { assertCurrent: assertSelected, startCurrent: startActive };
  const start = async <T>(operation: () => T): Promise<Awaited<T>> => {
    const current = await startGitHubIdentityOperation(readToken, caller);
    return await startGitHubIdentityOperation(() => {
      if (current !== token) {
        throw new GitHubIdentityError("changed");
      }
      return operation();
    }, caller);
  };
  const authority: GitHubReadAuthority = {
    ...(params.stale ? { stale: true } : {}),
    cacheScope:
      selection.source === "anonymous"
        ? "anonymous"
        : createHash("sha256")
            .update(
              JSON.stringify([selection.source, selection.profileId, selection.accountId, token]),
            )
            .digest("hex"),
    assertSelected,
    revalidate: () => start(() => undefined),
    start,
  };
  // Durable selection excludes credentials; the in-process result cache still
  // separates rotations, and later native sign-in closes anonymous authority.
  return params.token === undefined
    ? { ...authority, token: undefined, selection: Object.freeze(params.selection) }
    : { ...authority, token: params.token, selection: Object.freeze(params.selection) };
}
