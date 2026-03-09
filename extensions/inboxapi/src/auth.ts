/**
 * JWT credential management for InboxAPI.
 * Loads credentials from file or config, handles token resolution.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { InboxApiCredentials, ResolvedInboxApiAccount } from "./types.js";

/**
 * Expand ~ to home directory in paths.
 */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return resolve(homedir(), p.slice(2));
  }
  return p;
}

/**
 * Load credentials from the InboxAPI credentials file.
 * Returns null if file doesn't exist or can't be parsed.
 */
export async function loadCredentialsFile(
  credentialsPath: string,
): Promise<InboxApiCredentials | null> {
  try {
    const fullPath = expandHome(credentialsPath);
    const raw = await readFile(fullPath, "utf-8");
    return JSON.parse(raw) as InboxApiCredentials;
  } catch {
    return null;
  }
}

/**
 * Resolve the access token for an account.
 * Resolution order: config accessToken → env INBOXAPI_ACCESS_TOKEN → credentials file
 */
export async function resolveAccessToken(account: ResolvedInboxApiAccount): Promise<string> {
  // 1. Direct config value
  if (account.accessToken) {
    return account.accessToken;
  }

  // 2. Environment variable (already merged in resolveAccount, but double-check)
  if (process.env.INBOXAPI_ACCESS_TOKEN) {
    return process.env.INBOXAPI_ACCESS_TOKEN;
  }

  // 3. Credentials file
  const creds = await loadCredentialsFile(account.credentialsPath);
  if (creds?.accessToken) {
    return creds.accessToken;
  }

  return "";
}

/**
 * Resolve the domain for an account.
 * Resolution order: config domain → env INBOXAPI_DOMAIN → credentials file
 */
export async function resolveDomain(account: ResolvedInboxApiAccount): Promise<string> {
  if (account.domain) {
    return account.domain;
  }

  if (process.env.INBOXAPI_DOMAIN) {
    return process.env.INBOXAPI_DOMAIN;
  }

  const creds = await loadCredentialsFile(account.credentialsPath);
  if (creds?.domain) {
    return creds.domain;
  }

  return "";
}
