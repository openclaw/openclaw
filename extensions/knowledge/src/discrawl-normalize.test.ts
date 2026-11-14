import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

const script = fileURLToPath(
  new URL("../skills/knowledge-source-ingest/scripts/discrawl-normalize.mjs", import.meta.url),
);

/** Builds a minimal read-only Discrawl archive and a fake `discrawl` CLI that points at it. */
function makeArchive(binDir: string) {
  const dbPath = path.join(binDir, "archive.db");
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE channels (id TEXT PRIMARY KEY, guild_id TEXT, name TEXT, thread_parent_id TEXT);
    CREATE TABLE members (guild_id TEXT, user_id TEXT, username TEXT, global_name TEXT, display_name TEXT, nick TEXT, bot INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, guild_id TEXT, channel_id TEXT, author_id TEXT, message_type TEXT, created_at TEXT, edited_at TEXT, deleted_at TEXT, content TEXT, normalized_content TEXT, reply_to_message_id TEXT, pinned INTEGER, has_attachments INTEGER);
    CREATE TABLE message_attachments (message_id TEXT, attachment_id TEXT, content_sha256 TEXT, fetch_status TEXT);
    INSERT INTO channels VALUES ('100', '9', 'dev', NULL);
  `);
  database.close();
  const fake = path.join(binDir, "discrawl");
  writeFileSync(fake, `#!/bin/sh\nprintf '{"database_path": "${dbPath}"}'\n`);
  chmodSync(fake, 0o755);
  return dbPath;
}

function runNormalize(binDir: string, args: string[]) {
  try {
    return { status: 0, output: runNormalizeCaptured(binDir, args) };
  } catch (error) {
    const failure = error as { status: number; stderr: string };
    return { status: failure.status, output: failure.stderr };
  }
}

function runNormalizeCaptured(binDir: string, args: string[]) {
  return execFileSync(process.execPath, [script, "--config", "unused", ...args], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

it("rejects an unknown channel name with a clean error and preserves the existing output", () => {
  const out = tempDirs.make("discrawl-normalize-");
  const binDir = path.join(out, "bin");
  mkdirSync(binDir, { recursive: true });
  makeArchive(binDir);
  const output = path.join(out, "messages.jsonl");
  const preserved = '{"id":"old","preserved":true}\n';
  writeFileSync(output, preserved);

  const result = runNormalize(binDir, [
    "--channel",
    "no-such-channel",
    "--since",
    "2026-10-01T00:00:00Z",
    "--before",
    "2026-10-02T00:00:00Z",
    "--output",
    output,
  ]);

  expect(result.status).toBe(1);
  // One diagnostic line, not a Node traceback.
  expect(result.output.trim().split("\n")).toHaveLength(1);
  expect(result.output).toContain("Channel name resolved to 0 rows");
  expect(result.output).not.toContain("at run (");
  // The previously preserved raw JSONL survives the rejected export untouched.
  expect(readFileSync(output, "utf8")).toBe(preserved);
});
