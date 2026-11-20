import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

const scripts = fileURLToPath(
  new URL("../skills/knowledge-source-ingest/scripts/", import.meta.url),
);
const run = (script: string, args: string[]) =>
  execFileSync(process.execPath, [path.join(scripts, script), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

// A history page, a later page that reads the root again after an edit, and the thread's replies.
const history = {
  ok: true,
  channelId: "C1",
  hasMore: false,
  messages: [
    { ts: "1790000100.000200", user: "U2", text: "ack <@U1>" },
    {
      ts: "1790000000.000100",
      user: "U1",
      text: "Ship plan\nsecond line",
      thread_ts: "1790000000.000100",
      reply_count: 1,
    },
  ],
};
const edited = {
  channelId: "C1",
  hasMore: false,
  messages: [
    {
      ts: "1790000000.000100",
      user: "U1",
      text: "Ship plan v2",
      thread_ts: "1790000000.000100",
      reply_count: 1,
      edited: { ts: "1790000500.000000" },
    },
  ],
};
const replies = {
  channelId: "C1",
  threadId: "1790000000.000100",
  hasMore: false,
  messages: [
    {
      ts: "1790000200.000300",
      bot_id: "B9",
      username: "deploybot",
      text: "deployed",
      thread_ts: "1790000000.000100",
      files: [{ id: "F1" }],
    },
  ],
};

it("normalizes saved Slack read results into chat JSONL the transcript and manifest tools read", async () => {
  const dir = tempDirs.make("slack-read-normalize-");
  const file = (name: string) => path.join(dir, name);
  await writeFile(file("history.json"), JSON.stringify(history));
  await writeFile(file("pages.jsonl"), `${JSON.stringify(edited)}\n${JSON.stringify(replies)}\n`);
  await writeFile(file("users.json"), JSON.stringify({ U1: "Ann", U2: "Bo" }));
  const args = ["--team", "T1", "--channel", "C1", "--users", file("users.json")];
  const inputs = ["--input", file("history.json"), "--input", file("pages.jsonl")];
  const normalize = (output: string) =>
    execFileSync(
      process.execPath,
      [path.join(scripts, "slack-read-normalize.mjs"), ...args, ...inputs, "--output", output],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  expect(normalize(file("messages.jsonl"))).toBe("");
  const rows = (await readFile(file("messages.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.map((row) => [row.id, row.occurred_at])).toStrictEqual([
    ["C1/1790000000.000100", "2026-09-21T14:13:20.000100Z"],
    ["C1/1790000100.000200", "2026-09-21T14:15:00.000200Z"],
    ["C1/1790000200.000300", "2026-09-21T14:16:40.000300Z"],
  ]);
  expect(rows[0].payload).toMatchObject({
    author_id: "U1",
    author_name: "Ann",
    content: "Ship plan v2",
    edited_at: "2026-09-21T14:21:40.000000Z",
    reply_count: 1,
  });
  expect(rows[0].payload.thread_id).toBeUndefined();
  expect(rows[2].payload).toMatchObject({
    thread_id: "C1/1790000000.000100",
    thread_name: "Ship plan v2",
    reply_to_message_id: "C1/1790000000.000100",
    author_id: "B9",
    author_name: "deploybot",
    author_bot: 1,
    has_attachments: 1,
    attachments: "F1",
  });

  // The same reads in another order give the same bytes.
  await writeFile(file("history.json"), JSON.stringify([replies, history]));
  await writeFile(file("pages.jsonl"), JSON.stringify(edited));
  normalize(file("again.jsonl"));
  expect(await readFile(file("again.jsonl"), "utf8")).toBe(
    await readFile(file("messages.jsonl"), "utf8"),
  );

  const transcript = file("transcript");
  run("chat-transcript.mjs", [
    "--input",
    file("messages.jsonl"),
    "--output-dir",
    transcript,
    "--channel",
    "#launch",
    "--source-key",
    "slack:T1/C1",
  ]);
  const day = await readFile(path.join(transcript, "2026-09-21.txt"), "utf8");
  expect(day).toContain("14:15 Bo: ack @Ann");
  expect(day).toMatch(/## Thread: Ship plan v2\n14:16 deploybot \(bot\) ↩ Ann 14:13: deployed/);

  const summary = file("snapshot.json");
  run("source-manifest.mjs", [
    "snapshot",
    "--provider",
    "slack",
    "--source-key",
    "slack:T1/C1",
    "--coverage-start",
    "2026-09-21T00:00:00Z",
    "--coverage-end",
    "2026-09-22T00:00:00Z",
    "--input",
    file("messages.jsonl"),
    "--output",
    file("manifest.jsonl.gz"),
    "--summary",
    summary,
  ]);
  expect(JSON.parse(await readFile(summary, "utf8"))).toMatchObject({ item_count: 3 });
});

it("rejects a read result from another channel and a message without a Slack ts", async () => {
  const dir = tempDirs.make("slack-read-normalize-");
  const input = path.join(dir, "read.json");
  const normalize = () =>
    run("slack-read-normalize.mjs", ["--team", "T1", "--channel", "C2", "--input", input]);
  await writeFile(input, JSON.stringify(history));
  expect(normalize).toThrow(/belongs to channel C1, not C2/);
  await writeFile(input, JSON.stringify({ messages: [{ ts: "17900", text: "x" }] }));
  expect(normalize).toThrow(/has no Slack ts/);
  expect(run("slack-read-normalize.mjs", ["--help"])).toMatch(
    /Usage: node slack-read-normalize\.mjs/,
  );
});
