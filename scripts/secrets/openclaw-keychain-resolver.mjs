#!/usr/bin/env node
/**
 * openclaw-keychain-resolver — Native OS keychain exec SecretRef resolver
 *
 * Resolves SecretRef ids from the OS-native keychain:
 *   - macOS: Keychain Services (Security.framework)
 *   - Linux: libsecret / GNOME Keyring / KWallet
 *   - Windows: Windows Credential Manager (DPAPI)
 *
 * Requires the `keytar` npm package. Install via one of:
 *   npm install -g keytar
 *   npm install -g openclaw-keychain-resolver   (also provides the `ckg` CLI)
 *
 * SecretRef exec provider protocol: reads JSON request from stdin,
 * writes JSON response to stdout.
 *
 * Usage in openclaw.json:
 *   {
 *     "secrets": {
 *       "providers": {
 *         "keychain": {
 *           "source": "exec",
 *           "command": "/usr/local/bin/openclaw-keychain-resolver",
 *           "jsonOnly": true
 *         }
 *       }
 *     }
 *   }
 *
 * Store secrets with the companion CLI:
 *   ckg set ANTHROPIC_API_KEY sk-ant-your-key-here
 *   ckg set OPENAI_API_KEY    sk-your-openai-key
 *   ckg list
 */

import { createRequire } from "node:module";

const SERVICE_NAME = "openclaw-keychain";

const require = createRequire(import.meta.url);

/** @type {import("keytar")} */
let keytar;
try {
  keytar = require("keytar");
} catch {
  process.stderr.write(
    "openclaw-keychain-resolver: 'keytar' package not found.\n" +
      "Install it with: npm install -g keytar\n" +
      "Or install the full package: npm install -g openclaw-keychain-resolver\n",
  );
  process.exit(1);
}

const readStdin = () =>
  new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk.toString();
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });

const parseRequest = (input) => {
  try {
    return JSON.parse(input || "{}");
  } catch (error) {
    throw new Error(`Failed to parse request JSON: ${error.message}`, { cause: error });
  }
};

const main = async () => {
  const request = parseRequest(await readStdin());
  if (request.protocolVersion !== 1) {
    throw new Error("Unsupported SecretRef protocolVersion");
  }

  const ids = Array.isArray(request.ids)
    ? request.ids.filter((id) => typeof id === "string" && id.length > 0)
    : [];
  if (ids.length === 0) {
    process.stdout.write(JSON.stringify({ protocolVersion: 1, values: {}, errors: {} }));
    return;
  }

  const values = {};
  const errors = {};

  await Promise.all(
    ids.map(async (id) => {
      try {
        const value = await keytar.getPassword(SERVICE_NAME, id);
        if (value !== null) {
          values[id] = value;
        } else {
          errors[id] = { message: `not found (service: ${SERVICE_NAME}, account: ${id})` };
        }
      } catch (error) {
        errors[id] = { message: `keychain access failed: ${error.message}` };
      }
    }),
  );

  process.stdout.write(JSON.stringify({ protocolVersion: 1, values, errors }));
};

main().catch(
  /** @param {unknown} error */ (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  },
);
