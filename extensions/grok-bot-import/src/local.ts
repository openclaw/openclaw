import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type GrokBotRosterAgent = {
  id: string;
  name: string;
  title?: string;
  avatarShape?: string;
  avatarColor?: string;
  avatarVersion?: string;
  avatarPhoto?: string;
  harness?: string;
  origin?: string;
};

export type GrokBotLocalRoster = {
  sourceRoot: string;
  accounts: Array<{ scope: string; agents: GrokBotRosterAgent[] }>;
};

const MAX_ENTRIES = 4096;
const MAX_ROSTER_BYTES = 8 * 1024 * 1024;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeKey(file: string): string | undefined {
  if (!/^[a-z2-7]+\.blob$/iu.test(file)) {
    return undefined;
  }
  const encoded = file.slice(0, -5).toUpperCase();
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const character of encoded) {
    accumulator = (accumulator << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  if (accumulator !== 0) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: The guard excludes null, arrays, and primitives; property values remain unknown.
  return value as Record<string, unknown>;
}

function parseRoster(value: unknown): GrokBotRosterAgent[] {
  const root = record(value);
  const rows = record(root?.value)?.rows;
  if (root?.schemaVersion !== 4 || !Array.isArray(rows)) {
    throw new Error("Unsupported Grok Bot roster cache. Open the current Grok Bot app and retry.");
  }
  return rows.map((entry) => {
    const row = record(entry);
    if (typeof row?.id !== "string" || !row.id || typeof row.name !== "string") {
      throw new Error("Invalid Grok Bot roster entry. Open Grok Bot to refresh its roster.");
    }
    const agent: GrokBotRosterAgent = { id: row.id, name: row.name };
    for (const key of [
      "title",
      "avatarShape",
      "avatarColor",
      "avatarVersion",
      "avatarPhoto",
      "harness",
      "origin",
    ] as const) {
      if (typeof row[key] === "string") {
        agent[key] = row[key];
      }
    }
    return agent;
  });
}

/** root is the Grok Bot user-data directory; only roster blobs are opened. */
export async function discoverGrokBotRoster(
  options: { root?: string; homeDir?: string } = {},
): Promise<GrokBotLocalRoster> {
  const sourceRoot = path.resolve(
    options.root ??
      path.join(options.homeDir ?? os.homedir(), "Library/Application Support/Grok Bot"),
  );
  const directory = path.join(sourceRoot, "sand-client-persistence");
  const result: GrokBotLocalRoster = { sourceRoot, accounts: [] };
  let entries: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    entries = await fs.opendir(directory);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return result;
    }
    throw new Error("Could not read the Grok Bot roster directory.", { cause: error });
  }
  let count = 0;
  for await (const entry of entries) {
    if (++count > MAX_ENTRIES) {
      throw new Error(
        "Grok Bot cache exceeds the discovery limit. Use an exported recipe instead.",
      );
    }
    if (!entry.isFile()) {
      continue;
    }
    const key = decodeKey(entry.name);
    const scope =
      key && /^sand\.client\.slice\.account\.(.+)\.roster\.last-roster$/u.exec(key)?.[1];
    if (!scope) {
      continue;
    }
    const handle = await fs.open(
      path.join(directory, entry.name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_ROSTER_BYTES) {
        throw new Error("Grok Bot roster exceeds the discovery size limit.");
      }
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (bytesRead === 0) {
          break;
        }
        length += bytesRead;
      }
      if (length > stat.size) {
        throw new Error("Grok Bot roster changed during discovery. Retry.");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
        );
      } catch {
        throw new Error("Grok Bot roster is unreadable. Open Grok Bot to refresh it.");
      }
      result.accounts.push({ scope, agents: parseRoster(decoded) });
    } finally {
      await handle.close();
    }
  }
  result.accounts.sort((a, b) => a.scope.localeCompare(b.scope));
  return result;
}
