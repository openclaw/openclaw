import { createHash } from "node:crypto";
import { compareAscii } from "./lib/canonical-json.mjs";

export type NativeI18nSurface = "android" | "apple";
export type NativeI18nSite = { kind: string; path: string };
export type NativeI18nInventoryEntry = {
  id: string;
  source: string;
  surface: NativeI18nSurface;
  sites: NativeI18nSite[];
};

export function serializeNativeI18nInventory(entries: readonly NativeI18nInventoryEntry[]): string {
  const pathHashes = new Map<string, string>();
  const rows = entries.flatMap(({ id, source, surface, sites }) =>
    sites.map(({ path, kind }) => {
      const hash = pathHashes.get(path) ?? createHash("sha256").update(path).digest("hex");
      pathHashes.set(path, hash);
      return { hash, row: { path, kind, surface, id, source } };
    }),
  );
  // One line per site clusters a PR's rows beside its touched files; path-hash ordering
  // keeps new sibling files out of the same insertion gap. Each position depends only
  // on its row, so Git (including GitHub's server-side merge) combines independent edits
  // cleanly and produces the same bytes as a fresh baseline.
  rows.sort(
    (left, right) =>
      compareAscii(left.hash, right.hash) ||
      compareAscii(left.row.path, right.row.path) ||
      compareAscii(left.row.kind, right.row.kind) ||
      compareAscii(left.row.surface, right.row.surface) ||
      compareAscii(left.row.source, right.row.source),
  );
  return [
    "{",
    '  "version": 3,',
    '  "sites": [',
    ...rows.map(
      ({ row }, index) => `    ${JSON.stringify(row)}${index === rows.length - 1 ? "" : ","}`,
    ),
    "  ]",
    "}",
    "",
  ].join("\n");
}

function invalidInventory(reason: string): never {
  throw new Error(
    `invalid native app i18n inventory: ${reason}; run \`pnpm native:i18n:baseline\``,
  );
}

export function parseNativeI18nInventory(raw: string): NativeI18nInventoryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalidInventory("malformed JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 3 ||
    !("sites" in parsed) ||
    !Array.isArray(parsed.sites)
  ) {
    invalidInventory("expected version 3 and a sites array");
  }
  const entries = new Map<string, NativeI18nInventoryEntry>();
  for (const value of parsed.sites) {
    const row: unknown = value;
    if (
      !row ||
      typeof row !== "object" ||
      !("path" in row) ||
      typeof row.path !== "string" ||
      !("kind" in row) ||
      typeof row.kind !== "string" ||
      !("id" in row) ||
      typeof row.id !== "string" ||
      !("source" in row) ||
      typeof row.source !== "string" ||
      !("surface" in row) ||
      (row.surface !== "android" && row.surface !== "apple")
    ) {
      invalidInventory("invalid site row");
    }
    const entry = entries.get(row.id) ?? {
      id: row.id,
      source: row.source,
      surface: row.surface,
      sites: [],
    };
    if (entry.source !== row.source || entry.surface !== row.surface) {
      invalidInventory(`inconsistent source or surface for ${row.id}`);
    }
    entry.sites.push({ kind: row.kind, path: row.path });
    entries.set(row.id, entry);
  }
  for (const entry of entries.values()) {
    entry.sites.sort(
      (left, right) => compareAscii(left.path, right.path) || compareAscii(left.kind, right.kind),
    );
  }
  return [...entries.values()].toSorted(
    (left, right) =>
      compareAscii(left.surface, right.surface) || compareAscii(left.source, right.source),
  );
}
