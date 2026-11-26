const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_MODELS = 512;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export type AgyCatalog = readonly Readonly<{ id: string; label: string }>[];

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

/** Decode only agy's supported machine-readable catalog; an unparseable result is not empty. */
export function decodeAgyCatalog(stdout: string): AgyCatalog {
  if (Buffer.byteLength(stdout) > MAX_CATALOG_BYTES) {
    throw new Error("Antigravity model catalog exceeds the native size limit.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Antigravity did not return a machine-readable model catalog.");
  }
  const command = field(parsed, "command");
  const rows = field(field(command, "data"), "models");
  if (field(command, "name") !== "models" || !Array.isArray(rows) || rows.length > MAX_MODELS) {
    throw new Error("Antigravity returned an invalid model catalog envelope.");
  }
  const ids = new Set<string>();
  const entries: { id: string; label: string }[] = [];
  for (const row of rows) {
    const id = field(row, "id");
    const label = field(row, "label");
    if (
      typeof id !== "string" ||
      !MODEL_ID.test(id) ||
      ids.has(id) ||
      typeof label !== "string" ||
      !label.trim() ||
      label.length > 256 ||
      /\p{Cc}/u.test(label)
    ) {
      throw new Error("Antigravity model catalog has an invalid or ambiguous model row.");
    }
    ids.add(id);
    entries.push({ id, label });
  }
  return entries;
}
