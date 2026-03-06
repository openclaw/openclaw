#!/usr/bin/env node

/**
 * Bitwarden exec resolver for OpenClaw secrets protocol v1.
 *
 * Accepts protocol-v1 JSON on stdin:
 *   { "protocolVersion": 1, "provider": "bw", "ids": ["item/field", ...] }
 *
 * Outputs protocol-v1 JSON on stdout:
 *   { "protocolVersion": 1, "values": { "item/field": "secret", ... } }
 *
 * Ref ID format: "item-name/field-name" or "item-name" (defaults to password).
 * Supported fields: password, username, notes, uri, or any custom field name.
 *
 * Requires: bw CLI installed and vault unlocked (BW_SESSION in env).
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Run a bw CLI command and return trimmed stdout.
 * @param {string[]} args - Arguments to pass to bw CLI.
 * @returns {Promise<string>} Trimmed stdout output.
 */
export function runBw(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "bw",
      [...args, "--nointeraction", "--raw"],
      {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * Parse a ref ID into item query and field name.
 * Format: "item-name/field-name" or "item-name" (defaults to password).
 * @param {string} id - The ref ID to parse.
 * @returns {{ itemQuery: string, field: string }}
 */
export function parseRef(id) {
  const slashIdx = id.lastIndexOf("/");
  if (slashIdx === -1) {
    return { itemQuery: id, field: "password" };
  }
  return {
    itemQuery: id.substring(0, slashIdx),
    field: id.substring(slashIdx + 1),
  };
}

/**
 * Extract a specific field from a Bitwarden item JSON object.
 * @param {object} item - Parsed Bitwarden item JSON.
 * @param {string} field - Field name to extract.
 * @returns {string|null} The field value, or null if not found.
 */
export function extractField(item, field) {
  switch (field) {
    case "password":
      return item.login?.password ?? null;
    case "username":
      return item.login?.username ?? null;
    case "notes":
      return item.notes ?? "";
    case "uri":
      return item.login?.uris?.[0]?.uri ?? "";
    default: {
      const custom = item.fields?.find((f) => f.name === field);
      return custom ? String(custom.value) : null;
    }
  }
}

/**
 * Group ref IDs by item name to minimize bw CLI calls.
 * @param {string[]} ids - Array of ref IDs.
 * @returns {Map<string, Array<{id: string, field: string}>>}
 */
export function groupByItem(ids) {
  const byItem = new Map();
  for (const id of ids) {
    const { itemQuery, field } = parseRef(id);
    if (!byItem.has(itemQuery)) {
      byItem.set(itemQuery, []);
    }
    byItem.get(itemQuery).push({ id, field });
  }
  return byItem;
}

/**
 * Resolve multiple secret refs via Bitwarden CLI.
 * @param {string[]} ids - Array of ref IDs.
 * @returns {Promise<{values: Record<string, string>, errors: Record<string, {message: string}>}>}
 */
export async function resolveSecrets(ids) {
  const values = {};
  const errors = {};
  const byItem = groupByItem(ids);

  for (const [itemQuery, fields] of byItem) {
    try {
      const raw = await runBw(["get", "item", itemQuery]);
      const item = JSON.parse(raw);
      for (const { id, field } of fields) {
        const value = extractField(item, field);
        if (value === null) {
          errors[id] = { message: `Field "${field}" not found in item "${itemQuery}"` };
        } else {
          values[id] = value;
        }
      }
    } catch (err) {
      for (const { id } of fields) {
        errors[id] = { message: err.message };
      }
    }
  }

  return { values, errors };
}

/**
 * Main entrypoint: read protocol-v1 JSON from stdin, resolve, write response.
 */
async function main() {
  const input = readFileSync(0, "utf8");
  const req = JSON.parse(input);

  if (req.protocolVersion !== 1) {
    process.stdout.write(
      JSON.stringify({
        protocolVersion: 1,
        values: {},
        errors: { _protocol: { message: "Unsupported protocol version" } },
      }),
    );
    process.exit(1);
  }

  const ids = req.ids ?? [];
  const { values, errors } = await resolveSecrets(ids);

  process.stdout.write(
    JSON.stringify({
      protocolVersion: 1,
      values,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    }),
  );
}

main().catch((err) => {
  process.stdout.write(
    JSON.stringify({
      protocolVersion: 1,
      values: {},
      errors: { _fatal: { message: err.message } },
    }),
  );
  process.exit(1);
});
