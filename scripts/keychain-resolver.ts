#!/usr/bin/env npx tsx
/**
 * macOS Keychain exec provider for OpenClaw secrets management.
 *
 * Implements the exec provider protocol:
 *   stdin:  { "protocolVersion": 1, "provider": "keychain", "ids": ["KEY_NAME", ...] }
 *   stdout: { "protocolVersion": 1, "values": { "KEY_NAME": "secret_value" } }
 *
 * Errors (missing secrets) are returned per-id, not as a top-level failure.
 *
 * Prerequisites: macOS with the `security` CLI (bundled with macOS).
 *
 * Store a secret:
 *   security add-generic-password -U -a "openclaw" -s "TELEGRAM_BOT_TOKEN" -w "your-token"
 *
 * OpenClaw config:
 *   {
 *     secrets: {
 *       providers: {
 *         keychain: {
 *           source: "exec",
 *           command: "/path/to/scripts/keychain-resolver.ts",
 *           allowSymlinkCommand: true,   // required if invoked via npx shim
 *           passEnv: ["HOME"],
 *           jsonOnly: true
 *         }
 *       }
 *     }
 *   }
 */

import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

interface ExecProviderRequest {
  protocolVersion: number;
  provider: string;
  ids: string[];
}

interface ExecProviderResponse {
  protocolVersion: number;
  values: Record<string, string>;
  errors?: Record<string, { message: string }>;
}

const KEYCHAIN_ACCOUNT = "openclaw";

function getKeychainSecret(id: string): string | null {
  try {
    const value = execSync(
      `security find-generic-password -a ${JSON.stringify(KEYCHAIN_ACCOUNT)} -s ${JSON.stringify(id)} -w`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // Read all stdin
  const chunks: string[] = [];
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    chunks.push(line);
  }
  const raw = chunks.join("\n").trim();

  let request: ExecProviderRequest;
  try {
    request = JSON.parse(raw);
  } catch {
    process.stderr.write(`keychain-resolver: invalid JSON on stdin\n`);
    process.exit(1);
  }

  if (request.protocolVersion !== 1) {
    process.stderr.write(`keychain-resolver: unsupported protocolVersion ${request.protocolVersion}\n`);
    process.exit(1);
  }

  const values: Record<string, string> = {};
  const errors: Record<string, { message: string }> = {};

  for (const id of request.ids ?? []) {
    const secret = getKeychainSecret(id);
    if (secret !== null) {
      values[id] = secret;
    } else {
      errors[id] = { message: `Secret '${id}' not found in Keychain (account: ${KEYCHAIN_ACCOUNT})` };
    }
  }

  const response: ExecProviderResponse = {
    protocolVersion: 1,
    values,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };

  process.stdout.write(JSON.stringify(response) + "\n");
}

main().catch((err) => {
  process.stderr.write(`keychain-resolver: ${String(err)}\n`);
  process.exit(1);
});
