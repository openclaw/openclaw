import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

const root = fileURLToPath(new URL("../", import.meta.url));
const scripts = path.join(root, "skills/knowledge-source-ingest/scripts");
const manifestScript = path.join(scripts, "source-manifest.mjs");
const discrawlScript = path.join(scripts, "discrawl-normalize.mjs");
const run = (script: string, args: string[], options = {}) =>
  execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", ...options });
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
// Expand {name: value} into CLI flags, in insertion order.
const flags = (options: Record<string, string>) =>
  Object.entries(options).flatMap(([name, value]) => ["--" + name, value]);

// Snapshot one Discord channel's rows covering [start, end), observed at `observed`.
async function snapshot(
  dir: string,
  name: string,
  rows: unknown[],
  [start, end, observed]: string[],
  completeness = "complete",
  env = process.env,
) {
  const input = path.join(dir, name + ".jsonl");
  const output = path.join(dir, name + ".manifest.jsonl.gz");
  const summary = path.join(dir, name + ".summary.json");
  await writeFile(input, jsonl(rows));
  const coverage = { "coverage-start": start!, "coverage-end": end!, "observed-at": observed! };
  run(
    manifestScript,
    [
      "snapshot",
      ...flags({ provider: "discord", "source-key": "discord:guild:channel", ...coverage }),
      ...flags({ completeness, input, output, summary }),
    ],
    { env },
  );
  return { output, summary };
}

// Plan a current snapshot against prior snapshots and return the parsed plan.
async function plan(dir: string, current: string, ...previous: string[]) {
  const output = path.join(dir, "plan.json");
  const priors = previous.flatMap((prior) => ["--previous", prior]);
  run(manifestScript, ["plan", "--current", current, ...priors, "--output", output]);
  return JSON.parse(await readFile(output, "utf8"));
}

it("source manifests are deterministic, content-private, and produce overlap-aware plans", async () => {
  const dir = tempDirs.make("knowledge-source-ingest-");
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
    ["2026-09-21T00:00:00-07:00", "2026-09-28T00:00:00-07:00", "2026-09-28T00:05:00-07:00"],
  );
  const rows = [
    { id: "a", occurred_at: "2026-09-25T08:00:00Z", payload: { text: "same" } },
    { id: "b", occurred_at: "2026-09-26T08:00:00Z", payload: { text: "new" } },
    { id: "d", occurred_at: "2026-09-29T08:00:00Z", payload: { text: "added" } },
  ];
  const window = [
    "2026-09-25T00:00:00-07:00",
    "2026-10-01T00:00:00-07:00",
    "2026-10-01T00:05:00-07:00",
  ];
  const current = await snapshot(dir, "current", rows, window);
  const result = await plan(dir, current.output, old.output);
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
  expect(gunzipSync(await readFile(current.output)).toString()).not.toMatch(/same|new|added/);
  const summary = JSON.parse(await readFile(current.summary, "utf8"));
  expect(summary.manifest_sha256).toMatch(/^[a-f0-9]{64}$/);
  const repeated = await snapshot(dir, "current-repeat", rows.toReversed(), window);
  expect(await readFile(repeated.output)).toStrictEqual(await readFile(current.output));
  await expect(snapshot(dir, "duplicate", [rows[0], rows[0]], window)).rejects.toThrow(
    /Duplicate item id/,
  );
  const scratch = tempDirs.make("knowledge-source-missing-");
  expect(() =>
    run(manifestScript, ["plan", "--current", path.join(scratch, "missing.gz")], {
      timeout: 10_000,
      env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    }),
  ).toThrow(/ENOENT/);
  expect(await readdir(scratch)).toEqual([]);
});

it("payload hashes are independent of locale and object key order", async () => {
  const dir = tempDirs.make("knowledge-source-locale-");
  const window = ["2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", "2026-11-02T01:00:00Z"];
  const payloads = [
    { a: 1, ä: [{ "2": "two", "10": "ten", a: 1 }, true, null], z: 3 },
    { z: 3, ä: [{ a: 1, "10": "ten", "2": "two" }, true, null], a: 1 },
  ];
  const outputs: string[] = [];
  for (const [index, locale] of ["en_US.UTF-8", "sv_SE.UTF-8"].entries()) {
    const result = await snapshot(
      dir,
      String(index),
      [{ id: "item", payload: payloads[index] }],
      window,
      "complete",
      { ...process.env, LANG: locale, LC_ALL: locale },
    );
    const content = gunzipSync(await readFile(result.output)).toString();
    // SHA-256 of {"a":1,"z":3,"ä":[{"10":"ten","2":"two","a":1},true,null]}.
    expect(JSON.parse(content.trim().split("\n")[1]!).sha256).toBe(
      "ed2694e52b2fe820bd83b6f77118d0be33a57d9087ca71284b5705006b3d519a",
    );
    outputs.push(result.output);
  }
  expect(await readFile(outputs[0]!)).toEqual(await readFile(outputs[1]!));
  const result = await plan(dir, outputs[1]!, outputs[0]!);
  expect(result.items.changed).toEqual([]);
  expect(result.items.unchanged).toEqual(["item"]);
});

it("newest prior observation wins independent of argument order and partial snapshots do not prove deletion", async () => {
  const dir = tempDirs.make("knowledge-source-ingest-");
  const at = (n: number) => [
    "2026-09-25T00:00:00Z",
    "2026-09-27T00:00:00Z",
    `2026-09-27T0${n}:00:00Z`,
  ];
  const row = (n: number) => [{ id: "a", occurred_at: "2026-09-26T00:00:00Z", payload: { n } }];
  const older = await snapshot(dir, "older", row(1), at(1));
  const newer = await snapshot(dir, "newer", row(2), at(2));
  const current = await snapshot(dir, "partial", [], at(3), "partial");
  const result = await plan(dir, current.output, newer.output, older.output);
  expect(result.items.deleted).toStrictEqual([]);
  expect(result.items.unresolved_missing).toStrictEqual(["a"]);
});

const DISCRAWL_SCHEMA =
  "CREATE TABLE channels(id TEXT,guild_id TEXT,name TEXT,thread_parent_id TEXT); CREATE TABLE members(guild_id TEXT,user_id TEXT,username TEXT,global_name TEXT,display_name TEXT,nick TEXT,bot INTEGER); CREATE TABLE messages(id TEXT,guild_id TEXT,channel_id TEXT,author_id TEXT,message_type TEXT,created_at TEXT,edited_at TEXT,deleted_at TEXT,content TEXT,normalized_content TEXT,reply_to_message_id TEXT,pinned INTEGER,has_attachments INTEGER); CREATE TABLE message_attachments(message_id TEXT,attachment_id TEXT,content_sha256 TEXT,fetch_status TEXT);";

// Seed a guild-10 Discrawl archive and put a fake `discrawl` CLI reporting it on
// PATH; returns an exporter that runs the adapter and parses its JSONL output.
async function archive(seed: (db: DatabaseSync) => void) {
  const dir = tempDirs.make("knowledge-source-ingest-");
  const database = path.join(dir, "discrawl.sqlite");
  const db = new DatabaseSync(database);
  db.exec(DISCRAWL_SCHEMA);
  seed(db);
  db.close();
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  const report = JSON.stringify({ database_path: database });
  await writeFile(path.join(bin, "discrawl"), `#!/bin/sh\nprintf '%s\\n' '${report}'\n`);
  await chmod(path.join(bin, "discrawl"), 0o755);
  const output = path.join(dir, "messages.jsonl");
  return async (channel: string, since: string, before: string, ...extra: string[]) => {
    const stdout = run(
      discrawlScript,
      [
        "--config",
        path.join(dir, "config.yaml"),
        ...flags({ channel, since, before, output }),
        ...extra,
      ],
      {
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(stdout).toBe("");
    const lines = (await readFile(output, "utf8")).trim().split("\n");
    return lines.map((line) => JSON.parse(line));
  };
}

it("Discrawl adapter resolves a stable channel, bounds instants, emits attachment state and includes threads only when asked", async () => {
  const exportRows = await archive((db) => {
    const channel = db.prepare("INSERT INTO channels VALUES(?,?,?,?)");
    channel.run("20", "10", "maintainers", null);
    channel.run("21", "10", "release plan", "20");
    channel.run("22", "10", "elsewhere", "99");
    const member = db.prepare("INSERT INTO members VALUES(?,?,?,?,?,?,?)");
    member.run("10", "40", "handle", "Global Name", "Display Name", "Nick", 0);
    const message = db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    // Offset bounds must select the actual instants, including the exact lower
    // boundary and excluding the upper boundary at archive nanosecond precision.
    for (const [id, channelId, at] of [
      ["30", "20", "2026-09-27T10:00:00Z"],
      ["thread", "21", "2026-09-27T11:00:00Z"],
      ["foreign", "22", "2026-09-27T12:00:00Z"],
      ["before", "20", "2026-09-27T06:59:59.999999999Z"],
      ["start", "20", "2026-09-27T07:00:00.000000000Z"],
      ["last", "20", "2026-09-28T06:59:59.999999999Z"],
      ["end", "20", "2026-09-28T07:00:00.000000000Z"],
    ] as const) {
      message.run(id, "10", channelId, "40", "default", at, null, null, id, id, null, 0, 0);
    }
    const attachment = db.prepare("INSERT INTO message_attachments VALUES(?,?,?,?)");
    attachment.run("30", "b", "bb", "fetched");
    attachment.run("30", "a", "aa", "fetched");
  });
  const named = await exportRows("#maintainers", "2026-09-27T00:00:00Z", "2026-09-28T00:00:00Z");
  const row = named.find((candidate) => candidate.id === "30");
  expect(row.payload.author_name).toBe("Display Name");
  expect(row.payload.author_username).toBe("handle");
  expect(row.payload.author_bot).toBe(0);
  expect(row.payload.attachments).toBe("a:aa:fetched|b:bb:fetched");
  const day = ["20", "2026-09-27T00:00:00-07:00", "2026-09-28T00:00:00-07:00"] as const;
  expect((await exportRows(...day)).map((message) => message.id)).toStrictEqual([
    "start",
    "30",
    "last",
  ]);
  const threaded = await exportRows(...day, "--threads", "include");
  expect(
    threaded.map((message) => [message.id, message.payload.thread_name ?? null]),
  ).toStrictEqual([
    ["start", null],
    ["30", null],
    ["thread", "release plan"],
    ["last", null],
  ]);
});

it("Discrawl adapter exposes usable help without requiring paired arguments", () => {
  const help = run(discrawlScript, ["--help"]);
  expect(help).toMatch(/Usage: node discrawl-normalize\.mjs/);
  expect(help).toMatch(/half-open \[since,before\)/);
});
