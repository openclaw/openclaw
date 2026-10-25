#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const HASH = /^[a-f0-9]{64}$/;
const FORMAT = "knowledge-source-manifest-v1";
const argv = process.argv.slice(2);
const command = argv.shift();
const options = new Map();
for (let index = 0; index < argv.length; index++) {
  const key = argv[index];
  if (!key.startsWith("--")) {
    throw new Error("Unexpected argument: " + key);
  }
  const value = argv[++index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("Missing value for " + key);
  }
  const name = key.slice(2);
  options.set(name, name === "previous" ? [...(options.get(name) ?? []), value] : value);
}
const need = (name) => {
  const value = options.get(name);
  if (!value) {
    throw new Error("--" + name + " is required");
  }
  return value;
};
const canonical = (value) => {
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => JSON.stringify(key) + ":" + canonical(child))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const instant = (value, name) => {
  if (
    typeof value !== "string" ||
    !/(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(name + " must be an RFC3339 timestamp with an explicit offset");
  }
  return new Date(value).toISOString();
};
const inputStream = (filename) => {
  const raw = filename === "-" ? process.stdin : createReadStream(filename);
  return filename.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
};
// Yields JSONL lines split on \n only; readline would also split on U+2028 inside JSON strings.
async function* lines(filename) {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of inputStream(filename)) {
    const parts = (pending + decoder.decode(chunk, { stream: true })).split("\n");
    pending = parts.pop();
    yield* parts;
  }
  pending += decoder.decode();
  if (pending) {
    yield pending;
  }
}
function payloadFor(row) {
  if (row.payload !== undefined) {
    return row.payload;
  }
  if (row.data !== undefined) {
    return row.data;
  }
  const { id: _id, sha256: _sha256, occurred_at: _occurredAt, ...payload } = row;
  return payload;
}
async function writeManifest(filename, header, database) {
  if (filename !== "-") {
    await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  }
  const destination = filename === "-" ? process.stdout : createWriteStream(filename);
  const gzip = filename.endsWith(".gz") ? createGzip({ level: 9, mtime: 0 }) : null;
  const hash = createHash("sha256");
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  if (gzip) {
    gzip.pipe(meter).pipe(destination);
  } else {
    meter.pipe(destination);
  }
  const sink = gzip ?? meter;
  const write = (text) =>
    new Promise((resolve, reject) => {
      sink.write(text, (/** @type {Error | null | undefined} */ error) =>
        error ? reject(error) : resolve(),
      );
    });
  await write(JSON.stringify(header) + "\n");
  for (const row of database
    .prepare("SELECT id,sha256,occurred_at FROM items ORDER BY id")
    .iterate()) {
    await write(
      JSON.stringify({
        kind: "item",
        id: row.id,
        sha256: row.sha256,
        ...(row.occurred_at ? { occurred_at: row.occurred_at } : {}),
      }) + "\n",
    );
  }
  sink.end();
  await finished(meter);
  if (destination !== process.stdout) {
    await finished(destination);
  }
  return hash.digest("hex");
}
async function snapshot() {
  const provider = need("provider");
  const sourceKey = need("source-key");
  const input = need("input");
  const output = need("output");
  const start = instant(need("coverage-start"), "coverage-start");
  const end = instant(need("coverage-end"), "coverage-end");
  if (Date.parse(start) >= Date.parse(end)) {
    throw new Error("coverage-start must precede coverage-end");
  }
  const observedAt = instant(options.get("observed-at") ?? new Date().toISOString(), "observed-at");
  const completeness = options.get("completeness") ?? "complete";
  if (!["complete", "partial", "unknown"].includes(completeness)) {
    throw new Error("completeness must be complete, partial, or unknown");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "knowledge-source-manifest-"));
  const database = new DatabaseSync(path.join(directory, "items.sqlite"));
  try {
    database.exec(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE items(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,occurred_at TEXT) WITHOUT ROWID; BEGIN",
    );
    const insert = database.prepare("INSERT INTO items(id,sha256,occurred_at) VALUES(?,?,?)");
    let count = 0;
    for await (const line of lines(input)) {
      if (!line.trim()) {
        continue;
      }
      const row = JSON.parse(line);
      if (!row || typeof row.id !== "string" || !row.id.length) {
        throw new Error("Item " + (count + 1) + " has no stable string id");
      }
      const occurredAt =
        row.occurred_at === undefined
          ? null
          : instant(row.occurred_at, "item " + row.id + " occurred_at");
      const sha256 = row.sha256 ?? digest(canonical(payloadFor(row)));
      if (!HASH.test(sha256)) {
        throw new Error("Item " + row.id + " has an invalid sha256");
      }
      try {
        insert.run(row.id, sha256, occurredAt);
      } catch {
        throw new Error("Duplicate item id: " + row.id);
      }
      count++;
    }
    database.exec("COMMIT");
    const header = {
      format: FORMAT,
      source: { provider, key: sourceKey },
      coverage: { start, end, completeness },
      observed_at: observedAt,
      item_count: count,
      ...(options.get("source-revision")
        ? { source_revision: options.get("source-revision") }
        : {}),
      ...(options.get("watermark") ? { watermark: options.get("watermark") } : {}),
    };
    const sha256 = await writeManifest(output, header, database);
    const summary = { ...header, manifest_sha256: sha256, output };
    if (options.get("summary")) {
      await writeFile(options.get("summary"), JSON.stringify(summary, null, 2) + "\n");
    }
    (output === "-" ? process.stderr : process.stdout).write(JSON.stringify(summary) + "\n");
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function loadManifest(filename, database, manifestIndex, role) {
  let header = null;
  let count = 0;
  const insert = database.prepare(
    "INSERT INTO manifest_items(role,manifest_index,manifest_observed,id,sha256,occurred_at) VALUES(?,?,?,?,?,?)",
  );
  database.exec("BEGIN");
  for await (const line of lines(filename)) {
    if (!line.trim()) {
      continue;
    }
    const row = JSON.parse(line);
    if (!header) {
      if (
        row.format !== FORMAT ||
        !row.source?.provider ||
        !row.source?.key ||
        !row.coverage?.start ||
        !row.coverage?.end
      ) {
        throw new Error("Invalid manifest header: " + filename);
      }
      instant(row.coverage.start, "coverage start");
      instant(row.coverage.end, "coverage end");
      instant(row.observed_at, "observed_at");
      if (!["complete", "partial", "unknown"].includes(row.coverage.completeness)) {
        throw new Error("Invalid manifest completeness: " + filename);
      }
      header = row;
      continue;
    }
    if (row.kind !== "item" || typeof row.id !== "string" || !HASH.test(row.sha256)) {
      throw new Error("Invalid manifest item in " + filename);
    }
    const occurredAt =
      row.occurred_at === undefined
        ? null
        : instant(row.occurred_at, "item " + row.id + " occurred_at");
    insert.run(role, manifestIndex, Date.parse(header.observed_at), row.id, row.sha256, occurredAt);
    count++;
  }
  database.exec("COMMIT");
  if (!header) {
    throw new Error("Empty manifest: " + filename);
  }
  if (header.item_count !== count) {
    throw new Error("Manifest item count mismatch: " + filename);
  }
  return header;
}
function coveragePlan(current, previous) {
  const start = Date.parse(current.coverage.start);
  const end = Date.parse(current.coverage.end);
  const intervals = previous
    .filter((item) => item.coverage.completeness === "complete")
    .map((item) => [
      Math.max(start, Date.parse(item.coverage.start)),
      Math.min(end, Date.parse(item.coverage.end)),
    ])
    .filter(([a, b]) => a < b)
    .toSorted((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) {
      last[1] = Math.max(last[1], interval[1]);
    } else {
      merged.push([...interval]);
    }
  }
  const uncovered = [];
  let cursor = start;
  for (const [a, b] of merged) {
    if (cursor < a) {
      uncovered.push([cursor, a]);
    }
    cursor = Math.max(cursor, b);
  }
  if (cursor < end) {
    uncovered.push([cursor, end]);
  }
  const render = (ranges) =>
    ranges.map(([a, b]) => ({ start: new Date(a).toISOString(), end: new Date(b).toISOString() }));
  return { covered: render(merged), uncovered: render(uncovered) };
}
async function plan() {
  const currentFile = need("current");
  const previousFiles = options.get("previous") ?? [];
  const output = options.get("output") ?? "-";
  const directory = await mkdtemp(path.join(tmpdir(), "knowledge-source-plan-"));
  const database = new DatabaseSync(path.join(directory, "plan.sqlite"));
  try {
    database.exec(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; CREATE TABLE manifest_items(role TEXT,manifest_index INTEGER,manifest_observed INTEGER,id TEXT,sha256 TEXT,occurred_at TEXT,PRIMARY KEY(role,manifest_index,id)) WITHOUT ROWID;",
    );
    const current = await loadManifest(currentFile, database, 0, "current");
    const previous = [];
    for (let index = 0; index < previousFiles.length; index++) {
      previous.push(await loadManifest(previousFiles[index], database, index, "previous"));
    }
    for (const header of previous) {
      if (
        header.source.provider !== current.source.provider ||
        header.source.key !== current.source.key
      ) {
        throw new Error("All manifests must describe the same provider/source key");
      }
    }
    database.exec("CREATE INDEX manifest_items_id ON manifest_items(id,role,manifest_index);");
    const latest =
      "WITH ranked AS (SELECT id,sha256,occurred_at,ROW_NUMBER() OVER(PARTITION BY id ORDER BY manifest_observed DESC,manifest_index DESC) AS n FROM manifest_items WHERE role='previous') SELECT id,sha256,occurred_at FROM ranked WHERE n=1";
    const added = [],
      changed = [],
      unchanged = [],
      deleted = [],
      unresolvedMissing = [];
    const compare =
      "SELECT c.id,c.sha256 AS current_hash,p.sha256 AS previous_hash FROM manifest_items c LEFT JOIN (" +
      latest +
      ") p ON p.id=c.id WHERE c.role='current' ORDER BY c.id";
    for (const row of database.prepare(compare).iterate()) {
      if (!row.previous_hash) {
        added.push(row.id);
      } else if (row.previous_hash === row.current_hash) {
        unchanged.push(row.id);
      } else {
        changed.push(row.id);
      }
    }
    const missing =
      "SELECT p.id,p.occurred_at FROM (" +
      latest +
      ") p LEFT JOIN manifest_items c ON c.role='current' AND c.id=p.id WHERE c.id IS NULL ORDER BY p.id";
    for (const row of database.prepare(missing).iterate()) {
      if (!row.occurred_at || current.coverage.completeness !== "complete") {
        unresolvedMissing.push(row.id);
      } else if (
        Date.parse(row.occurred_at) >= Date.parse(current.coverage.start) &&
        Date.parse(row.occurred_at) < Date.parse(current.coverage.end)
      ) {
        deleted.push(row.id);
      }
    }
    const coverage = coveragePlan(current, previous);
    const result = {
      format: "knowledge-source-plan-v1",
      source: current.source,
      current: {
        coverage: current.coverage,
        observed_at: current.observed_at,
        item_count: current.item_count,
      },
      previous: previous.map((header, index) => ({
        index,
        coverage: header.coverage,
        observed_at: header.observed_at,
        item_count: header.item_count,
      })),
      coverage,
      summary: {
        added: added.length,
        changed: changed.length,
        deleted: deleted.length,
        unchanged: unchanged.length,
        unresolved_missing: unresolvedMissing.length,
      },
      items: { added, changed, deleted, unchanged, unresolved_missing: unresolvedMissing },
    };
    const text = JSON.stringify(result, null, 2) + "\n";
    if (output === "-") {
      process.stdout.write(text);
    } else {
      await writeFile(output, text);
    }
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
function usage() {
  console.error(
    "Usage:\n  source-manifest.mjs snapshot --provider P --source-key K --coverage-start RFC3339 --coverage-end RFC3339 --input normalized.jsonl --output manifest.jsonl[.gz] [--summary summary.json]\n  source-manifest.mjs plan --current manifest.jsonl[.gz] [--previous old.jsonl[.gz] ...] [--output plan.json]\n\nNormalized input rows require id and may include occurred_at, sha256, and payload/data. Without sha256, the canonical payload is hashed. Manifests retain identities and hashes, not source content.",
  );
}
try {
  if (command === "snapshot") {
    await snapshot();
  } else if (command === "plan") {
    await plan();
  } else {
    usage();
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
