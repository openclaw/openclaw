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
    {
      ts: "1790000100.000200",
      user: "U2",
      user_profile: { display_name: "Bo" },
      text: "ack <@U1>",
    },
    {
      ts: "1790000000.000100",
      user: "U1",
      user_profile: { display_name: "Ann" },
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
      user_profile: { display_name: "Ann" },
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
  const args = ["--team", "T1", "--channel", "C1"];
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

it("names mentioned users from the read without changing the message or its hash", async () => {
  const dir = tempDirs.make("slack-read-mentions-");
  const file = (name: string) => path.join(dir, name);
  const message = { ts: "1790000100.000200", user: "U2", text: "<@U7> and <@U8|old> please look" };
  // A thread root and a reply two days later, which quotes its root.
  const root = {
    ts: "1790000300.000300",
    user: "U2",
    text: "<@U7> costs",
    thread_ts: "1790000300.000300",
  };
  const reply = { ts: "1790172800.000400", user: "U2", text: "done", thread_ts: root.ts };
  const normalize = async (name: string, read: object) => {
    await writeFile(file(`${name}.json`), JSON.stringify(read));
    run("slack-read-normalize.mjs", [
      "--team",
      "T1",
      "--channel",
      "C1",
      "--input",
      file(`${name}.json`),
      "--output",
      file(`${name}.jsonl`),
    ]);
    const [first] = (await readFile(file(`${name}.jsonl`), "utf8")).split("\n");
    return JSON.parse(first ?? "");
  };
  const named = await normalize("named", {
    channelId: "C1",
    messages: [message, root, reply],
    userProfiles: { U7: { display_name: "Cy", name: "cy" } },
  });
  const bare = await normalize("bare", { channelId: "C1", messages: [message] });
  expect(named.payload.content).toBe(message.text);
  expect(named.payload.mention_names).toStrictEqual({ U7: "Cy" });
  expect(bare.payload.mention_names).toBeUndefined();
  expect(named.sha256).toBe(bare.sha256);
  run("chat-transcript.mjs", [
    "--input",
    file("named.jsonl"),
    "--output-dir",
    file("transcript"),
    "--channel",
    "#launch",
    "--source-key",
    "slack:T1/C1",
  ]);
  const day = await readFile(path.join(file("transcript"), "2026-09-21.txt"), "utf8");
  // A user no read named keeps Slack's mention.
  expect(day).toContain("14:15 U2: @Cy and <@U8|old> please look");
  // Thread names and reply quotes name mentioned users too.
  const later = await readFile(path.join(file("transcript"), "2026-09-23.txt"), "utf8");
  expect(later).toContain("## Thread: @Cy costs");
  expect(later).toContain('↩ U2 2026-09-21 14:18 "@Cy costs": done');
});

it("keeps same-named authors and mentioned users apart in the transcript", async () => {
  const dir = tempDirs.make("slack-read-mention-names-");
  const file = (name: string) => path.join(dir, name);
  await writeFile(
    file("read.json"),
    JSON.stringify({
      channelId: "C1",
      messages: [{ ts: "1790000100.000200", user: "U1", text: "ask <@U2> and <@U3>" }],
      userProfiles: { U2: { display_name: "Sam" }, U3: { display_name: "Sam" } },
    }),
  );
  run("slack-read-normalize.mjs", [
    "--team",
    "T1",
    "--channel",
    "C1",
    "--input",
    file("read.json"),
    "--output",
    file("m.jsonl"),
  ]);
  const rows = (await readFile(file("m.jsonl"), "utf8")).replace(
    '"author_name":"U1"',
    '"author_name":"Sam"',
  );
  await writeFile(file("m.jsonl"), rows);
  run("chat-transcript.mjs", [
    "--input",
    file("m.jsonl"),
    "--output-dir",
    file("tx"),
    "--channel",
    "#c",
    "--source-key",
    "slack:T1/C1",
  ]);
  const day = await readFile(path.join(file("tx"), "2026-09-21.txt"), "utf8");
  expect(day).toContain("14:15 Sam#U1: ask @Sam#U2 and @Sam#U3");
});

it("names an author whose own lookup failed from a later read's mention", async () => {
  const dir = tempDirs.make("slack-read-author-fallback-");
  const file = (name: string) => path.join(dir, name);
  await writeFile(
    file("first.json"),
    JSON.stringify({
      channelId: "C1",
      messages: [{ ts: "1790000100.000200", user: "U1", text: "hello" }],
    }),
  );
  await writeFile(
    file("second.json"),
    JSON.stringify({
      channelId: "C1",
      messages: [
        {
          ts: "1790000200.000300",
          user: "U2",
          user_profile: { display_name: "Bo" },
          text: "thanks <@U1>",
        },
      ],
      userProfiles: { U1: { display_name: "Sam" } },
    }),
  );
  run("slack-read-normalize.mjs", [
    "--team",
    "T1",
    "--channel",
    "C1",
    "--input",
    file("first.json"),
    "--input",
    file("second.json"),
    "--output",
    file("m.jsonl"),
  ]);
  run("chat-transcript.mjs", [
    "--input",
    file("m.jsonl"),
    "--output-dir",
    file("tx"),
    "--channel",
    "#c",
    "--source-key",
    "slack:T1/C1",
  ]);
  const day = await readFile(path.join(file("tx"), "2026-09-21.txt"), "utf8");
  expect(day).toContain("14:15 Sam: hello");
  expect(day).toContain("14:16 Bo: thanks @Sam");
});

it("keeps an unchanged reply's hash whether or not its root was read, and changes it on an edit", async () => {
  const dir = tempDirs.make("slack-read-normalize-");
  const file = (name: string) => path.join(dir, name);
  // Normalize the reads, snapshot them, and return the manifest path.
  const snapshot = async (name: string, reads: unknown[]) => {
    await writeFile(file(`${name}.json`), JSON.stringify(reads));
    const args = ["--team", "T1", "--channel", "C1", "--input", file(`${name}.json`)];
    run("slack-read-normalize.mjs", [...args, "--output", file(`${name}.jsonl`)]);
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
      file(`${name}.jsonl`),
      "--output",
      file(`${name}.manifest.jsonl.gz`),
    ]);
    return file(`${name}.manifest.jsonl.gz`);
  };
  const first = await snapshot("first", [history, replies]);
  // A later run re-reads only the thread (its root is outside the history read), and the root
  // gained a reply count; the root text itself is edited.
  const later = await snapshot("later", [
    { ...replies, messages: [{ ...replies.messages[0], username: "Deploy Bot" }] },
    { ...edited, messages: [{ ...edited.messages[0], reply_count: 2 }] },
  ]);
  run("source-manifest.mjs", [
    "plan",
    "--current",
    later,
    "--previous",
    first,
    "--output",
    file("plan.json"),
  ]);
  const plan = JSON.parse(await readFile(file("plan.json"), "utf8"));
  expect(plan.items.unchanged).toStrictEqual(["C1/1790000200.000300"]);
  expect(plan.items.changed).toStrictEqual(["C1/1790000000.000100"]);
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
