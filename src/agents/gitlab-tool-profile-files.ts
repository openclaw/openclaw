import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "@openclaw/fs-safe/root";
import { readSecretFile } from "@openclaw/fs-safe/secret";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { normalizeGitLabIssuer } from "./gitlab-host.js";
import { notifyManagedGitLabProfileChanged } from "./gitlab-tool-identity-lifecycle.js";

/** glab's isolated global config uses hosts.<hostname>.token, never the OS keyring. */
export async function writeManagedGitLabProfileFiles(
  profileDir: string,
  identity: { issuer: string; login: string; token: string },
  options?: { assertCurrent?: () => void },
): Promise<void> {
  const host = new URL(normalizeGitLabIssuer(identity.issuer)).host;
  registerSecretValueForRedaction(identity.token);
  const parentDir = path.dirname(profileDir);
  await fs.mkdir(parentDir, { recursive: true, mode: 0o700 });
  const parent = await fsRoot(parentDir);
  const existing = await fs.lstat(profileDir).catch(() => undefined);
  if (!existing) {
    await parent.mkdir(path.basename(profileDir), {
      private: true,
      assertBeforeMutation: options?.assertCurrent,
    });
  } else if (
    !existing.isDirectory() ||
    existing.isSymbolicLink() ||
    (process.platform !== "win32" && (existing.mode & 0o077) !== 0)
  ) {
    throw new Error("Managed GitLab CLI profile directory is unsafe.");
  }
  const profile = await fsRoot(profileDir, { mode: 0o600, mkdir: false, durable: false });
  await profile.write(
    "config.yml",
    stringifyYaml({
      host,
      git_protocol: "https",
      check_update: false,
      hosts: {
        [host]: {
          api_protocol: "https",
          api_host: host,
          token: identity.token,
          user: identity.login,
          use_keyring: false,
        },
      },
    }),
    { mode: 0o600, mutationSymlinks: "reject", assertBeforeMutation: options?.assertCurrent },
  );
  notifyManagedGitLabProfileChanged({ profileDir, kind: "updated" });
}

/** A child launcher can read only the selected private glab profile after admission. */
export async function readManagedGitLabProfileToken(
  profileDir: string,
  issuer: string,
): Promise<string | undefined> {
  const host = new URL(normalizeGitLabIssuer(issuer)).host;
  try {
    const [directory, file] = await Promise.all([
      fs.lstat(profileDir),
      fs.lstat(path.join(profileDir, "config.yml")),
    ]);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !file.isFile() ||
      file.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((directory.mode & 0o077) !== 0 || (file.mode & 0o077) !== 0))
    ) {
      return undefined;
    }
    const raw = await readSecretFile(
      path.join(profileDir, "config.yml"),
      "Managed GitLab profile",
      {
        maxBytes: 16 * 1024,
        rejectSymlink: true,
      },
    );
    const document = parseDocument(raw, { prettyErrors: false });
    if (document.errors.length || document.warnings.length) {
      return undefined;
    }
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (
      !isRecord(value) ||
      value.host !== host ||
      !isRecord(value.hosts) ||
      Object.keys(value.hosts).length !== 1
    ) {
      return undefined;
    }
    const selected = value.hosts[host];
    if (
      !isRecord(selected) ||
      selected.api_protocol !== "https" ||
      selected.api_host !== host ||
      selected.use_keyring !== false ||
      Object.keys(selected).some(
        (key) => !["api_protocol", "api_host", "token", "user", "use_keyring"].includes(key),
      ) ||
      typeof selected.token !== "string" ||
      !selected.token ||
      selected.token.length > 4096 ||
      /[\r\n\0]/u.test(selected.token)
    ) {
      return undefined;
    }
    registerSecretValueForRedaction(selected.token);
    return selected.token;
  } catch {
    return undefined;
  }
}
