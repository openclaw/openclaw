// Per-agent credential bag (RI-025)
// A credential bag is an explicit, per-agent map of env vars that are allowed
// to flow into the sandbox. Without a bag, sanitize-env-vars.ts blocks all
// credential-shaped vars (defense in depth). With a bag, the bag owner is
// telling the gateway "this specific agent is allowed to have THESE specific
// secrets" — a whitelist override to the deny-by-default sanitizer.
//
// Storage: credential-bags.json in the OpenClaw state dir. Shape:
//   {
//     "version": 1,
//     "bags": [
//       { "agentId": "quinn", "vars": { "ANTHROPIC_API_KEY": "…" } },
//       { "agentId": "jack",  "vars": { "HUBSPOT_API_KEY":  "…" } }
//     ]
//   }
//
// Scope isolation: each sandbox spawn only receives ITS agent's bag. Agent A's
// credentials never appear in agent B's container env.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../../config/config.js";
import { validateEnvVarValue } from "./sanitize-env-vars.js";

export interface CredentialBag {
  agentId: string;
  vars: Record<string, string>;
  updatedAt?: string;
}

export interface CredentialBagFile {
  version: number;
  bags: CredentialBag[];
}

export const CREDENTIAL_BAG_FILE_NAME = "credential-bags.json";

export function resolveDefaultBagFilePath(): string {
  return join(STATE_DIR, CREDENTIAL_BAG_FILE_NAME);
}

export function loadCredentialBagsFile(
  path: string = resolveDefaultBagFilePath(),
): CredentialBagFile {
  if (!existsSync(path)) {
    return { version: 1, bags: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read credential-bags.json at ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `credential-bags.json at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as CredentialBagFile).bags)
  ) {
    throw new Error(
      `credential-bags.json at ${path} is malformed — expected { version, bags: [] }`,
    );
  }
  return parsed as CredentialBagFile;
}

export function loadCredentialBagForAgent(
  agentId: string,
  path: string = resolveDefaultBagFilePath(),
): CredentialBag | null {
  const normalized = agentId.trim().toLowerCase();
  if (!normalized) return null;
  const file = loadCredentialBagsFile(path);
  return (
    file.bags.find((b) => b.agentId.trim().toLowerCase() === normalized) ?? null
  );
}

export interface BuiltBagEnv {
  args: string[];
  applied: string[];
  skipped: { key: string; reason: string }[];
}

/**
 * Convert a credential bag into Docker `--env KEY=VALUE` argv entries,
 * applying the same value-safety checks sanitize-env-vars uses (null-byte +
 * length limit). Keys that aren't valid POSIX env var names are skipped with
 * a recorded reason so the caller can log them. A missing or empty bag
 * returns an empty result.
 */
export function buildBagEnvArgs(bag: CredentialBag | null | undefined): BuiltBagEnv {
  const args: string[] = [];
  const applied: string[] = [];
  const skipped: { key: string; reason: string }[] = [];

  if (!bag || !bag.vars) {
    return { args, applied, skipped };
  }

  for (const [rawKey, value] of Object.entries(bag.vars)) {
    const key = rawKey.trim();
    if (!key) {
      skipped.push({ key: rawKey, reason: "empty key" });
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      skipped.push({ key, reason: "invalid env var name" });
      continue;
    }
    if (typeof value !== "string") {
      skipped.push({ key, reason: "value is not a string" });
      continue;
    }
    const warn = validateEnvVarValue(value);
    if (warn === "Contains null bytes") {
      skipped.push({ key, reason: "contains null bytes" });
      continue;
    }
    if (warn === "Value exceeds maximum length") {
      skipped.push({ key, reason: "value exceeds maximum length" });
      continue;
    }
    args.push("--env", `${key}=${value}`);
    applied.push(key);
  }

  return { args, applied, skipped };
}
