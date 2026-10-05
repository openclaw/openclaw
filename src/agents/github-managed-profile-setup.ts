import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "@openclaw/fs-safe/root";
import { GITHUB_PUBLIC_API_BASE_URL } from "./github-host.js";
import { isPrivateManagedGitHubProfile } from "./github-managed-profile-read.js";
import {
  notifyManagedGitHubProfileChanged,
  writeManagedGitHubProfileFiles,
  type ManagedGitHubCredentialIssuer,
} from "./github-managed-profile.js";
import { verifyGitHubCredential } from "./github-oauth-client.js";
import {
  clearNativeGitHubTokenCache,
  normalizeGitHubToken as normalizeManagedGitHubToken,
} from "./github-read-identity.js";
import { managedGitHubHosts, type GitHubToolAccount } from "./github-tool-account.js";
export class GitHubAccountMismatchError extends Error {}
async function verifyManagedGitHubCredential(
  token: string,
  issuer?: ManagedGitHubCredentialIssuer,
) {
  const credential = normalizeManagedGitHubToken(token);
  const verified = await verifyGitHubCredential(credential, {
    apiBaseUrl: issuer?.apiBaseUrl ?? GITHUB_PUBLIC_API_BASE_URL,
  });
  if (verified.status !== "available") {
    throw new Error("GitHub could not verify the managed credential.");
  }
  // Match gh's classic-token minimum scopes; other token types omit X-OAuth-Scopes.
  const scopes = verified.scopes;
  if (
    scopes.length &&
    (!scopes.includes("repo") ||
      !["read:org", "write:org", "admin:org"].some((scope) => scopes.includes(scope)))
  ) {
    throw new Error("GitHub credential is missing required repo or read:org scopes.");
  }
  return { account: verified.account, credential };
}

/** Verifies a rotated token, then atomically replaces credentials in one stable profile. */
export async function refreshManagedGitHubProfile(params: {
  profileDir: string;
  token: string;
  expectedAccountId: number;
  assertCurrent?: () => void;
}): Promise<GitHubToolAccount> {
  if (!(await isPrivateManagedGitHubProfile(params.profileDir))) {
    throw new Error("The configured GitHub identity profile is unavailable.");
  }
  const { account, credential } = await verifyManagedGitHubCredential(params.token);
  params.assertCurrent?.();
  if (account.accountId !== params.expectedAccountId) {
    throw new GitHubAccountMismatchError("GitHub OAuth refresh returned a different account.");
  }
  const targetHosts = path.join(params.profileDir, "hosts.yml");
  const targetStat = await fs.lstat(targetHosts);
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error("The configured GitHub identity profile is unavailable.");
  }
  const profile = await fsRoot(params.profileDir);
  await profile.write(
    "hosts.yml",
    managedGitHubHosts({ login: account.login, token: credential }),
    {
      mode: 0o600,
      mkdir: false,
      durable: false,
      mutationSymlinks: "reject",
      assertBeforeMutation: params.assertCurrent,
    },
  );
  clearNativeGitHubTokenCache();
  params.assertCurrent?.();
  notifyManagedGitHubProfileChanged(params.profileDir);
  return account;
}

/** Publishes a new inactive profile and switches config without retiring in-use generations. */
export async function installManagedGitHubProfile(params: {
  profileDir: string;
  token: string;
  issuer?: ManagedGitHubCredentialIssuer;
  commitConfig: (account: GitHubToolAccount) => Promise<void>;
  retainProfileOnCommitFailure?: boolean;
  assertCurrent?: () => void;
}): Promise<GitHubToolAccount> {
  const parent = path.dirname(params.profileDir);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.chmod(parent, 0o700);
  const stagingRoot = await fs.mkdtemp(path.join(parent, ".github-profile.staging-"));
  const stagedProfile = path.join(stagingRoot, "profile");
  let published = false;
  let committed = false;
  try {
    const { account, credential } = await verifyManagedGitHubCredential(
      params.token,
      params.issuer,
    );
    await writeManagedGitHubProfileFiles(stagedProfile, {
      login: account.login,
      token: credential,
      host: params.issuer?.host,
    });
    params.assertCurrent?.();
    await fs.rename(stagedProfile, params.profileDir);
    published = true;
    params.assertCurrent?.();
    await params.commitConfig(account);
    clearNativeGitHubTokenCache();
    committed = true;
    return account;
  } finally {
    if (published && !committed && !params.retainProfileOnCommitFailure) {
      await fs.rm(params.profileDir, { recursive: true, force: true });
    }
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}
