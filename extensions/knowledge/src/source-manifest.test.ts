import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { expect, it } from "vitest";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestScript = path.join(
  root,
  "skills/knowledge-source-ingest/scripts/source-manifest.mjs",
);
const discrawlScript = path.join(
  root,
  "skills/knowledge-source-ingest/scripts/discrawl-normalize.mjs",
);
const run = (script: any, args: any, options = {}) =>
  execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", ...options });
const jsonl = (rows: any) => rows.map((row: any) => JSON.stringify(row)).join("\n") + "\n";

async function fixture() {
  const dir = tempDirs.make("knowledge-source-ingest-");

  return dir;
}

function snapshot(
  dir: any,
  name: any,
  rows: any,
  start: any,
  end: any,
  observed: any,
  completeness = "complete",
) {
  const input = path.join(dir, name + ".jsonl");
  const output = path.join(dir, name + ".manifest.jsonl.gz");
  const summary = path.join(dir, name + ".summary.json");
  return writeFile(input, jsonl(rows)).then(() => {
    run(manifestScript, [
      "snapshot",
      "--provider",
      "discord",
      "--source-key",
      "discord:guild:channel",
      "--coverage-start",
      start,
      "--coverage-end",
      end,
      "--observed-at",
      observed,
      "--completeness",
      completeness,
      "--input",
      input,
      "--output",
      output,
      "--summary",
      summary,
    ]);
    return { output, summary };
  });
}

async function gunzip(filename: any, output: any) {
  await pipeline(createReadStream(filename), createGunzip(), createWriteStream(output));
}

it("source manifests are deterministic, content-private, and produce overlap-aware plans", async () => {
  const dir = await fixture();
  const old = await snapshot(
    dir,
    "old",
    [
      { id: "a", occurred_at: "2026-09-25T01:00:00-07:00", payload: { text: "same" } },
      { id: "b", occurred_at: "2026-09-26T01:00:00-07:00", payload: { text: "old" } },
      { id: "c", occurred_at: "2026-09-27T01:00:00-07:00", payload: { text: "deleted" } },
      { id: "x", occurred_at: "2026-09-22T01:00:00-07:00", payload: { text: "outside" } },
      { id: "z", payload: { text: "no date" } },
    ],
    "2026-09-21T00:00:00-07:00",
    "2026-09-28T00:00:00-07:00",
    "2026-09-28T00:05:00-07:00",
  );
  const current = await snapshot(
    dir,
    "current",
    [
      { id: "a", occurred_at: "2026-09-25T08:00:00Z", payload: { text: "same" } },
      { id: "b", occurred_at: "2026-09-26T08:00:00Z", payload: { text: "new" } },
      { id: "d", occurred_at: "2026-09-29T08:00:00Z", payload: { text: "added" } },
    ],
    "2026-09-25T00:00:00-07:00",
    "2026-10-01T00:00:00-07:00",
    "2026-10-01T00:05:00-07:00",
  );
  const plan = path.join(dir, "plan.json");
  run(manifestScript, [
    "plan",
    "--current",
    current.output,
    "--previous",
    old.output,
    "--output",
    plan,
  ]);
  const result = JSON.parse(await readFile(plan, "utf8"));
  expect(result.items.added).toStrictEqual(["d"]);
  expect(result.items.changed).toStrictEqual(["b"]);
  expect(result.items.unchanged).toStrictEqual(["a"]);
  expect(result.items.deleted).toStrictEqual(["c"]);
  expect(result.items.unresolved_missing).toStrictEqual(["z"]);
  expect(result.coverage.covered).toStrictEqual([
    { start: "2026-09-25T07:00:00.000Z", end: "2026-09-28T07:00:00.000Z" },
  ]);
  expect(result.coverage.uncovered).toStrictEqual([
    { start: "2026-09-28T07:00:00.000Z", end: "2026-10-01T07:00:00.000Z" },
  ]);
  const plain = path.join(dir, "manifest.txt");
  await gunzip(current.output, plain);
  const bytes = await readFile(plain, "utf8");
  expect(bytes).not.toMatch(/same|new|added/);
  const summary = JSON.parse(await readFile(current.summary, "utf8"));
  expect(summary.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
  const repeated = await snapshot(
    dir,
    "current-repeat",
    [
      { id: "d", occurred_at: "2026-09-29T08:00:00Z", payload: { text: "added" } },
      { id: "b", occurred_at: "2026-09-26T08:00:00Z", payload: { text: "new" } },
      { id: "a", occurred_at: "2026-09-25T08:00:00Z", payload: { text: "same" } },
    ],
    "2026-09-25T00:00:00-07:00",
    "2026-10-01T00:00:00-07:00",
    "2026-10-01T00:05:00-07:00",
  );
  expect(await readFile(repeated.output)).toStrictEqual(await readFile(current.output));
});

it("newest prior observation wins independent of argument order and partial snapshots do not prove deletion", async () => {
  const dir = await fixture();
  const older = await snapshot(
    dir,
    "older",
    [{ id: "a", occurred_at: "2026-09-26T00:00:00Z", payload: { n: 1 } }],
    "2026-09-25T00:00:00Z",
    "2026-09-27T00:00:00Z",
    "2026-09-27T01:00:00Z",
  );
  const newer = await snapshot(
    dir,
    "newer",
    [{ id: "a", occurred_at: "2026-09-26T00:00:00Z", payload: { n: 2 } }],
    "2026-09-25T00:00:00Z",
    "2026-09-27T00:00:00Z",
    "2026-09-27T02:00:00Z",
  );
  const current = await snapshot(
    dir,
    "partial",
    [],
    "2026-09-25T00:00:00Z",
    "2026-09-27T00:00:00Z",
    "2026-09-27T03:00:00Z",
    "partial",
  );
  const plan = path.join(dir, "plan.json");
  run(manifestScript, [
    "plan",
    "--current",
    current.output,
    "--previous",
    newer.output,
    "--previous",
    older.output,
    "--output",
    plan,
  ]);
  const result = JSON.parse(await readFile(plan, "utf8"));
  expect(result.items.deleted).toStrictEqual([]);
  expect(result.items.unresolved_missing).toStrictEqual(["a"]);
});

it("duplicate stable IDs reject a snapshot", async () => {
  const dir = await fixture(),
    input = path.join(dir, "duplicate.jsonl");
  await writeFile(
    input,
    jsonl([
      { id: "a", payload: 1 },
      { id: "a", payload: 2 },
    ]),
  );
  expect(() =>
    run(manifestScript, [
      "snapshot",
      "--provider",
      "x",
      "--source-key",
      "y",
      "--coverage-start",
      "2026-09-01T00:00:00Z",
      "--coverage-end",
      "2026-09-02T00:00:00Z",
      "--input",
      input,
      "--output",
      path.join(dir, "out.jsonl"),
    ]),
  ).toThrow(/Duplicate item id/);
});

it("Discrawl adapter resolves a stable channel and emits deterministic attachment state", async () => {
  const dir = await fixture(),
    dbPath = path.join(dir, "discrawl.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE channels(id TEXT,guild_id TEXT,name TEXT); CREATE TABLE members(guild_id TEXT,user_id TEXT,username TEXT,global_name TEXT,display_name TEXT,nick TEXT,bot INTEGER); CREATE TABLE messages(id TEXT,guild_id TEXT,channel_id TEXT,author_id TEXT,message_type TEXT,created_at TEXT,edited_at TEXT,deleted_at TEXT,content TEXT,normalized_content TEXT,reply_to_message_id TEXT,pinned INTEGER,has_attachments INTEGER); CREATE TABLE message_attachments(message_id TEXT,attachment_id TEXT,content_sha256 TEXT,fetch_status TEXT);",
  );
  db.prepare("INSERT INTO channels VALUES(?,?,?)").run("20", "10", "maintainers");
  db.prepare("INSERT INTO members VALUES(?,?,?,?,?,?,?)").run(
    "10",
    "40",
    "handle",
    "Global Name",
    "Display Name",
    "Nick",
    0,
  );
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "30",
    "10",
    "20",
    "40",
    "default",
    "2026-09-27T10:00:00Z",
    null,
    null,
    "hello",
    "hello",
    null,
    0,
    1,
  );
  db.prepare("INSERT INTO message_attachments VALUES(?,?,?,?)").run("30", "b", "bb", "fetched");
  db.prepare("INSERT INTO message_attachments VALUES(?,?,?,?)").run("30", "a", "aa", "fetched");
  db.close();
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  const fake = path.join(bin, "discrawl");
  await writeFile(
    fake,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ database_path: dbPath })}'\n`,
  );
  await chmod(fake, 0o755);
  const output = path.join(dir, "messages.jsonl");
  const stderr = run(
    discrawlScript,
    [
      "--config",
      path.join(dir, "config.yaml"),
      "--channel",
      "#maintainers",
      "--since",
      "2026-09-27T00:00:00Z",
      "--before",
      "2026-09-28T00:00:00Z",
      "--output",
      output,
    ],
    {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  expect(stderr).toBe("");
  const row = JSON.parse((await readFile(output, "utf8")).trim());
  expect(row.id).toBe("30");
  expect(row.payload.author_name).toBe("Display Name");
  expect(row.payload.author_username).toBe("handle");
  expect(row.payload.author_bot).toBe(0);
  expect(row.payload.attachments).toBe("a:aa:fetched|b:bb:fetched");

  // Offset bounds must select the actual instants, including the exact lower
  // boundary and excluding the upper boundary at archive nanosecond precision.
  const boundaryDb = new DatabaseSync(dbPath);
  const insert = boundaryDb.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const [id, at] of [
    ["before", "2026-09-27T06:59:59.999999999Z"],
    ["start", "2026-09-27T07:00:00.000000000Z"],
    ["last", "2026-09-28T06:59:59.999999999Z"],
    ["end", "2026-09-28T07:00:00.000000000Z"],
  ] as const) {
    insert.run(id, "10", "20", "40", "default", at, null, null, id, id, null, 0, 0);
  }
  boundaryDb.close();
  run(
    discrawlScript,
    [
      "--config",
      path.join(dir, "config.yaml"),
      "--channel",
      "20",
      "--since",
      "2026-09-27T00:00:00-07:00",
      "--before",
      "2026-09-28T00:00:00-07:00",
      "--output",
      output,
    ],
    {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  expect(
    (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).id),
  ).toStrictEqual(["start", "30", "last"]);
});

it("Discrawl adapter includes child threads only when asked", async () => {
  const dir = await fixture(),
    dbPath = path.join(dir, "discrawl.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE channels(id TEXT,guild_id TEXT,name TEXT,thread_parent_id TEXT); CREATE TABLE members(guild_id TEXT,user_id TEXT,username TEXT,global_name TEXT,display_name TEXT,nick TEXT,bot INTEGER); CREATE TABLE messages(id TEXT,guild_id TEXT,channel_id TEXT,author_id TEXT,message_type TEXT,created_at TEXT,edited_at TEXT,deleted_at TEXT,content TEXT,normalized_content TEXT,reply_to_message_id TEXT,pinned INTEGER,has_attachments INTEGER); CREATE TABLE message_attachments(message_id TEXT,attachment_id TEXT,content_sha256 TEXT,fetch_status TEXT);",
  );
  for (const row of [
    ["20", "10", "maintainers", null],
    ["21", "10", "release plan", "20"],
    ["22", "10", "elsewhere", "99"],
  ]) {
    db.prepare("INSERT INTO channels VALUES(?,?,?,?)").run(...row);
  }
  for (const [id, channel] of [
    ["1", "20"],
    ["2", "21"],
    ["3", "22"],
  ] as const) {
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      id,
      "10",
      channel,
      "40",
      "default",
      "2026-10-02T10:00:0" + id + "Z",
      null,
      null,
      "m" + id,
      "m" + id,
      null,
      0,
      0,
    );
  }
  db.close();
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "discrawl"),
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ database_path: dbPath })}'\n`,
  );
  await chmod(path.join(bin, "discrawl"), 0o755);
  const output = path.join(dir, "messages.jsonl");
  const exportRows = (extra: any) => {
    run(
      discrawlScript,
      [
        "--config",
        "c",
        "--channel",
        "20",
        "--since",
        "2026-10-02T00:00:00Z",
        "--before",
        "2026-10-03T00:00:00Z",
        "--output",
        output,
        ...extra,
      ],
      {
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return readFile(output, "utf8").then((text) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
  };
  expect((await exportRows([])).map((row) => row.id)).toStrictEqual(["1"]);
  const rows = await exportRows(["--threads", "include"]);
  expect(rows.map((row) => [row.id, row.payload.thread_name ?? null])).toStrictEqual([
    ["1", null],
    ["2", "release plan"],
  ]);
});

it("Discrawl adapter exposes usable help without requiring paired arguments", () => {
  const help = run(discrawlScript, ["--help"]);
  expect(help).toMatch(/Usage: node discrawl-normalize\.mjs/);
  expect(help).toMatch(/half-open \[since,before\)/);
});
