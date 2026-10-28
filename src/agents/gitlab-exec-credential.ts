import fs from "node:fs/promises";
import path from "node:path";
import { inspectPathPermissions } from "@openclaw/fs-safe/permissions";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseDocument } from "yaml";
import { readSecureFile } from "../infra/fs-safe.js";
import { normalizeGitLabIssuer } from "./gitlab-host.js";

export const GITLAB_EXEC_CREDENTIAL_UNAVAILABLE =
  "GitLab Identity credential is unavailable or insecure. Reconnect or change GitLab Identity, then retry.";

async function privateProfileStat(profileDir: string) {
  const stat = await fs.lstat(profileDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(GITLAB_EXEC_CREDENTIAL_UNAVAILABLE);
  }
  if (process.platform === "win32") {
    const permissions = await inspectPathPermissions(profileDir);
    if (
      !permissions.ok ||
      permissions.source !== "windows-acl" ||
      permissions.ownerTrusted !== true ||
      permissions.groupReadable ||
      permissions.worldReadable ||
      permissions.groupWritable ||
      permissions.worldWritable
    ) {
      throw new Error(GITLAB_EXEC_CREDENTIAL_UNAVAILABLE);
    }
  } else if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error(GITLAB_EXEC_CREDENTIAL_UNAVAILABLE);
  }
  return stat;
}

/** Called only inside the local launcher, never by the Gateway or supervision pipeline. */
export async function readGitLabExecToken(profileDir: string, issuer: string): Promise<string> {
  try {
    const host = new URL(normalizeGitLabIssuer(issuer)).host;
    const profile = await privateProfileStat(profileDir);
    const realProfileDir = await fs.realpath(profileDir);
    const filePath = path.join(profileDir, "config.yml");
    const config = await fs.lstat(filePath);
    if (!config.isFile() || config.isSymbolicLink() || config.nlink !== 1) {
      throw new Error(GITLAB_EXEC_CREDENTIAL_UNAVAILABLE);
    }
    const snapshot = await readSecureFile({
      filePath,
      trust: { trustedDirs: [realProfileDir] },
      io: { maxBytes: 64 * 1024, timeoutMs: 5_000 },
    });
    try {
      const currentProfile = await privateProfileStat(profileDir);
      if (
        currentProfile.dev !== profile.dev ||
        currentProfile.ino !== profile.ino ||
        path.dirname(snapshot.realPath) !== realProfileDir ||
        snapshot.stat.nlink !== 1
      ) {
        throw new Error(GITLAB_EXEC_CREDENTIAL_UNAVAILABLE);
      }
      const document = parseDocument(snapshot.buffer.toString("utf8"), { prettyErrors: false });
      if (document.errors.length || document.warnings.length) {
        throw new Error(GITLAB_EXEC_CREDENTIAL_UNAVAILABLE);
      }
      const parsed: unknown = document.toJS({ maxAliasCount: 0 });
      const hosts = isRecord(parsed) ? parsed.hosts : undefined;
      const hostEntry = isRecord(hosts) && Object.hasOwn(hosts, host) ? hosts[host] : undefined;
      const token =
        isRecord(hostEntry) && typeof hostEntry.token === "string" ? hostEntry.token.trim() : "";
      if (!token || /[\r\n\0]/u.test(token)) {
        throw new Error(GITLAB_EXEC_CREDENTIAL_UNAVAILABLE);
      }
      return token;
    } finally {
      snapshot.buffer.fill(0);
    }
  } catch {
    // Filesystem and YAML diagnostics may contain credential bytes or private paths.
    throw new Error(GITLAB_EXEC_CREDENTIAL_UNAVAILABLE);
  }
}
