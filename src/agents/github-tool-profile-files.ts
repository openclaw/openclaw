import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "@openclaw/fs-safe/root";
import { readSecretFileSync } from "@openclaw/fs-safe/secret";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { hasErrnoCode } from "../infra/errno.js";
import {
  GITHUB_IDENTITY_OUTPUT_LIMIT_BYTES,
  normalizeGitHubToken,
} from "./github-read-identity.js";
import { managedGitHubHosts } from "./github-tool-account.js";
import { notifyManagedGitHubProfileChanged } from "./github-tool-identity-lifecycle.js";

/** Write gh's external file contract without touching its OS keyring or verifying again. */
export async function writeManagedGitHubProfileFiles(
  profileDir: string,
  identity: { login: string; token: string },
  options?: { assertCurrent: () => void },
): Promise<void> {
  if (process.platform === "win32") {
    // Worker profiles live under OS temp, outside the node's restricted state ACL.
    const parentDir = path.dirname(profileDir);
    await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
    const parent = await fsRoot(parentDir);
    await parent.mkdir(path.basename(profileDir), {
      private: true,
      assertBeforeMutation: options?.assertCurrent,
    });
  } else {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.chmod(profileDir, 0o700);
  }
  const profile = await fsRoot(profileDir, { mode: 0o600, mkdir: false, durable: false });
  await profile.write("config.yml", stringifyYaml({ version: "1" }));
  await profile.write("hosts.yml", managedGitHubHosts(identity), {
    assertBeforeMutation: options?.assertCurrent,
  });
  notifyManagedGitHubProfileChanged({ profileDir, kind: "updated" });
}

/** Refresh the stable external profile through fs-safe's pinned atomic publication. */
export async function refreshManagedGitHubProfileFiles(
  profileDir: string,
  identity: { login: string; token: string },
  options: { assertCurrent: () => void },
): Promise<void> {
  const targetStat = await fs.lstat(path.join(profileDir, "hosts.yml"));
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    throw new Error("The configured GitHub identity profile is unavailable.");
  }
  const profile = await fsRoot(profileDir);
  await profile.write("hosts.yml", managedGitHubHosts(identity), {
    mode: 0o600,
    mkdir: false,
    durable: false,
    mutationSymlinks: "reject",
    assertBeforeMutation: options.assertCurrent,
  });
}

export async function isPrivateManagedGitHubProfile(profileDir: string): Promise<boolean> {
  try {
    const [profile, hosts] = await Promise.all([
      fs.lstat(profileDir),
      fs.lstat(path.join(profileDir, "hosts.yml")),
    ]);
    if (
      !profile.isDirectory() ||
      profile.isSymbolicLink() ||
      !hosts.isFile() ||
      hosts.isSymbolicLink()
    ) {
      return false;
    }
    return (
      process.platform === "win32" || ((profile.mode & 0o077) === 0 && (hosts.mode & 0o077) === 0)
    );
  } catch {
    return false;
  }
}

/** The worker owns every path check and bounded read; callers retain live authority. */
export function readManagedGitHubProfileToken(profileDir: string): string | undefined {
  try {
    const profile = fsSync.lstatSync(profileDir);
    if (
      !profile.isDirectory() ||
      profile.isSymbolicLink() ||
      (process.platform !== "win32" && (profile.mode & 0o077) !== 0)
    ) {
      return undefined;
    }
    let hosts: Record<string, unknown> | undefined;
    for (const name of ["hosts.yml", "config.yml"]) {
      const filePath = path.join(profileDir, name);
      let stat;
      try {
        stat = fsSync.lstatSync(filePath);
      } catch (error) {
        if (name === "config.yml" && hasErrnoCode(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        return undefined;
      }
      const raw = readSecretFileSync(filePath, "Managed GitHub profile", {
        maxBytes: GITHUB_IDENTITY_OUTPUT_LIMIT_BYTES,
        rejectSymlink: true,
      });
      // parse() logs YAML warnings containing file contents. Inspect the document
      // instead so corrupt credentials never escape into parser diagnostics.
      const document = parseDocument(raw, { prettyErrors: false });
      if (document.errors.length || document.warnings.length) {
        return undefined;
      }
      const value: unknown = document.toJS({ maxAliasCount: 0 });
      if (!isRecord(value)) {
        return undefined;
      }
      if (name === "hosts.yml") {
        hosts = value;
      }
    }
    const host = hosts?.["github.com"];
    // gh reads the active host token before considering the global keyring.
    // User-keyed entries alone cannot prove isolation from native auth.
    return isRecord(host) && typeof host.oauth_token === "string"
      ? normalizeGitHubToken(host.oauth_token)
      : undefined;
  } catch {
    return undefined;
  }
}
