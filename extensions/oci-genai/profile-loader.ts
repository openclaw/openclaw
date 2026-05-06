/**
 * OCI config-file profile loader.
 *
 * Parses Oracle Cloud Infrastructure config files (default `~/.oci/config`)
 * which use a Windows-style INI layout: section headers in `[brackets]`
 * followed by `key=value` lines. The default profile is `[DEFAULT]`; named
 * profiles like `[API_FREE_TIER]` are common when one workstation talks to
 * multiple tenancies.
 *
 * Reference: Oracle's
 * [SDK and CLI configuration file](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/sdkconfig.htm)
 * spec.
 *
 * Pure data: this module reads the file and returns a typed shape. It does
 * **not** load the private key referenced by `key_file` — that's the
 * signer's responsibility, and lazily reading the key keeps test setups
 * independent of the disk.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROFILE_NAME = "DEFAULT";

export type OciProfile = {
  /** Section name (e.g. "DEFAULT" or "API_FREE_TIER"). */
  readonly profileName: string;
  /** OCID of the IAM user the API key belongs to. */
  readonly user: string;
  /** OCID of the tenancy. */
  readonly tenancy: string;
  /** Hex fingerprint of the public key uploaded to the IAM user. */
  readonly fingerprint: string;
  /** Filesystem path to the PEM-encoded private key (resolved, ~ expanded). */
  readonly keyFile: string;
  /** OCI region identifier (e.g. "us-chicago-1"). Optional in some setups. */
  readonly region?: string;
  /** Passphrase protecting the private key, if any. */
  readonly passPhrase?: string;
};

export type LoadOciProfileOptions = {
  /** Override the config file path; defaults to `${HOME}/.oci/config`. */
  readonly configFile?: string;
  /** Profile section to load; defaults to DEFAULT. */
  readonly profileName?: string;
  /**
   * Override `$HOME` when expanding `~/...` paths.  Used by the test suite
   * to avoid touching the real user's home; production callers should leave
   * this unset.
   */
  readonly homeDir?: string;
};

/**
 * Load and validate a single profile out of an OCI config file.
 *
 * Throws if the file is unreadable, the named profile is missing, or any
 * required field is absent.  Returns a frozen shape on success.
 */
export async function loadOciProfile(options: LoadOciProfileOptions = {}): Promise<OciProfile> {
  const profileName = options.profileName?.trim() || DEFAULT_PROFILE_NAME;
  const configPath = options.configFile ?? defaultOciConfigPath(options.homeDir);

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (err) {
    throw new OciConfigError(`OCI config file not readable: ${configPath}`, {
      cause: err as Error,
    });
  }

  const sections = parseIni(raw);
  const section = sections.get(profileName);
  if (!section) {
    const available = [...sections.keys()].join(", ") || "<none>";
    throw new OciConfigError(
      `OCI profile "${profileName}" not found in ${configPath}. ` +
        `Available profiles: ${available}.`,
    );
  }

  const required = ["user", "tenancy", "fingerprint", "key_file"] as const;
  const missing = required.filter((key) => !section.get(key));
  if (missing.length > 0) {
    throw new OciConfigError(
      `OCI profile "${profileName}" missing required keys: ${missing.join(", ")}.`,
    );
  }

  const keyFileRaw = section.get("key_file") as string;
  const profile: OciProfile = Object.freeze({
    profileName,
    user: section.get("user") as string,
    tenancy: section.get("tenancy") as string,
    fingerprint: section.get("fingerprint") as string,
    keyFile: expandHome(keyFileRaw, options.homeDir),
    ...(section.get("region") ? { region: section.get("region") as string } : {}),
    ...(section.get("pass_phrase") ? { passPhrase: section.get("pass_phrase") as string } : {}),
  });
  return profile;
}

/** Default `~/.oci/config` resolution. */
export function defaultOciConfigPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".oci", "config");
}

export class OciConfigError extends Error {
  readonly code = "OCI_CONFIG";
  constructor(message: string, options?: { cause?: Error }) {
    super(message, options);
    this.name = "OciConfigError";
  }
}

/**
 * Parse an INI document into a `Map<sectionName, Map<key, value>>`.
 *
 * - Lines that match `[section]` start a new section.
 * - Lines before the first section are silently ignored (matches OCI CLI
 *   behaviour; the file format does not require an unnamed default).
 * - `;` and `#` introduce comments to end-of-line.
 * - `key=value` lines are trimmed on both sides.
 * - Duplicate keys: last one wins (OCI CLI is silent on this; this matches).
 */
function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const stripped = stripInlineComment(rawLine).trim();
    if (stripped.length === 0) {
      continue;
    }
    const sectionMatch = stripped.match(/^\[(.+?)\]\s*$/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      current = sections.get(name) ?? new Map<string, string>();
      sections.set(name, current);
      continue;
    }
    if (!current) {
      continue;
    }
    const eq = stripped.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = stripped.slice(0, eq).trim();
    const value = stripped.slice(eq + 1).trim();
    if (key.length === 0) {
      continue;
    }
    current.set(key, value);
  }
  return sections;
}

function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if ((ch === "#" || ch === ";") && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function expandHome(path: string, homeDir?: string): string {
  if (path.startsWith("~/")) {
    return join(homeDir ?? homedir(), path.slice(2));
  }
  if (path === "~") {
    return homeDir ?? homedir();
  }
  return path;
}
