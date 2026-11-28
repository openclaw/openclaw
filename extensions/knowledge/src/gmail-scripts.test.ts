import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

const scripts = fileURLToPath(
  new URL("../skills/knowledge-source-ingest/scripts/", import.meta.url),
);
const run = (script: string, args: string[], cwd?: string) =>
  execFileSync(process.execPath, [path.join(scripts, script), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd,
  });

const b64 = (text: string) => Buffer.from(text).toString("base64url");
// A thread as Composio returns it: Ann asks, the owner answers above the quoted ask, a draft.
const contract = {
  threadId: "18c0ffee0001",
  historyId: "900",
  messages: [
    {
      messageId: "18c0ffee0002",
      threadId: "18c0ffee0001",
      messageTimestamp: "2026-11-21T09:00:00Z",
      labelIds: ["SENT"],
      sender: "Owner <owner@example.com>",
      to: "ann@acme.example",
      subject: "Re: Pilot contract",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "In-Reply-To", value: "<a1@acme.example>" }],
        parts: [
          {
            mimeType: "text/plain",
            body: {
              data: b64(
                "Will do, I'll send it Thursday.\n\nOn Thu, Nov 20, 2026 at 9:00 AM Ann Lee <ann@acme.example>\nwrote:\n> Can you send the signed pilot contract by Friday?\n",
              ),
            },
          },
          { mimeType: "application/pdf", filename: "pilot.pdf", body: {} },
        ],
      },
    },
    {
      messageId: "18c0ffee0001",
      threadId: "18c0ffee0001",
      messageTimestamp: "2026-11-20T17:00:00Z",
      labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
      sender: "Ann Lee <ann@acme.example>",
      to: "owner@example.com",
      subject: "Pilot contract",
      messageText: "Can you send the signed pilot contract by Friday?",
      payload: {
        headers: [
          { name: "Message-ID", value: "<a1@acme.example>" },
          { name: "Cc", value: '"Lee, Bo" <bo@acme.example>' },
        ],
      },
    },
    {
      messageId: "18c0ffee0003",
      threadId: "18c0ffee0001",
      messageTimestamp: "2026-11-21T10:00:00Z",
      labelIds: ["DRAFT"],
      sender: "owner@example.com",
      messageText: "unsent",
    },
  ],
};
const mail = (id: string, message: Record<string, unknown>) => ({
  threadId: id,
  messages: [
    {
      messageId: id,
      threadId: id,
      messageTimestamp: "2026-11-22T10:00:00Z",
      labelIds: ["INBOX"],
      subject: "Hello",
      messageText: "Hi",
      ...message,
    },
  ],
});

it("prefilters Gmail threads and asks the decision model about the rest", async () => {
  const dir = tempDirs.make("gmail-triage-");
  const threads = {
    contract,
    receipt: mail("18c0ffee00a1", {
      sender: "Acme <billing@acme.example>",
      payload: { headers: [{ name: "List-Unsubscribe", value: "<mailto:u@acme.example>" }] },
    }),
    alert: mail("18c0ffee00a2", { sender: "Bank <no-reply@bank.example>" }),
    // A calendar request is known by its MIME part, whatever its subject says.
    invite: mail("18c0ffee00a3", {
      sender: "Ann Lee <ann@acme.example>",
      subject: "Project sync",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "text/calendar",
            headers: [
              { name: "Content-Type", value: "text/calendar; charset=UTF-8; method=REQUEST" },
            ],
            body: { data: b64("BEGIN:VCALENDAR") },
          },
        ],
      },
    }),
    promo: mail("18c0ffee00a4", {
      sender: "Shop <hello@shop.example>",
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
    }),
    // Updates are not bulk mail: contracts and document requests arrive there.
    update: mail("18c0ffee00a5", {
      sender: "Docs <docs@sign.example>",
      labelIds: ["INBOX", "CATEGORY_UPDATES"],
    }),
    // An HTML-only reply: the quoted commitment is not the sender's new text.
    html: mail("18c0ffee00a6", {
      sender: "Ann Lee <ann@acme.example>",
      messageText: undefined,
      payload: {
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/html",
            body: {
              data: b64(
                '<div>Thanks.</div><div class="gmail_quote"><div>On Fri, Bo wrote:</div><blockquote type="cite"><div>I will send the contract Friday.</div></blockquote></div>',
              ),
            },
          },
        ],
      },
    }),
  };
  const inputs = [];
  for (const [name, thread] of Object.entries(threads)) {
    await writeFile(path.join(dir, name + ".json"), JSON.stringify(thread));
    inputs.push("--input", path.join(dir, name + ".json"));
  }
  const rows = run("gmail-normalize.mjs", ["triage", "--account", "Owner@Example.com", ...inputs])
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.map((row) => [row.thread_id, row.prefilter])).toStrictEqual([
    ["18c0ffee0001", null],
    ["18c0ffee00a1", "list-mail"],
    ["18c0ffee00a2", "automated-sender"],
    ["18c0ffee00a3", "calendar-notice"],
    ["18c0ffee00a4", "bulk-category"],
    ["18c0ffee00a5", null],
    ["18c0ffee00a6", null],
  ]);
  expect(rows[6].decision.state.value.messages[0].text).toBe("Thanks.");
  // The owner replied, so the promotions label does not leave the thread out; the draft is no message.
  expect(rows[0]).toMatchObject({
    history_id: "900",
    newest_message_id: "18c0ffee0002",
    message_count: 2,
    owner_wrote: true,
    link: "https://mail.google.com/mail/?authuser=owner%40example.com#all/18c0ffee0001",
  });
  expect(rows[1].decision).toBeUndefined();
  // The message digest follows which messages the thread holds, not their labels.
  const opened = structuredClone(contract);
  opened.messages[1]!.labelIds = ["INBOX"];
  const pruned = { ...structuredClone(contract), messages: contract.messages.slice(0, 1) };
  const digest = async (thread: unknown) => {
    await writeFile(path.join(dir, "again.json"), JSON.stringify(thread));
    return JSON.parse(
      run("gmail-normalize.mjs", [
        "triage",
        "--account",
        "owner@example.com",
        "--input",
        path.join(dir, "again.json"),
      ]),
    ).messages_digest;
  };
  expect(await digest(opened)).toBe(rows[0].messages_digest);
  expect(await digest(pruned)).not.toBe(rows[0].messages_digest);
  const { decision } = rows[0];
  expect(Object.keys(decision)).toStrictEqual(["contractVersion", "state", "questions"]);
  expect(decision.contractVersion).toBe(2);
  expect(decision.questions.ingest.type).toBe("boolean");
  expect(Object.keys(decision.questions.kind.criteria)).toContain("commitment");
  expect(decision.state).toStrictEqual({
    type: "json",
    value: {
      subject: "Pilot contract",
      message_count: 2,
      owner_wrote: true,
      labels: ["CATEGORY_PROMOTIONS"],
      messages: [
        {
          from: "Ann Lee <ann@acme.example>",
          by_owner: false,
          owner_in_to: true,
          date: "2026-11-20",
          text: "Can you send the signed pilot contract by Friday?",
        },
        {
          from: "Owner <owner@example.com>",
          by_owner: true,
          owner_in_to: false,
          date: "2026-11-21",
          text: "Will do, I'll send it Thursday.",
        },
      ],
    },
  });
});

it("normalizes a Gmail thread into chat JSONL the transcript and manifest tools read", async () => {
  const dir = tempDirs.make("gmail-messages-");
  const file = (name: string) => path.join(dir, name);
  await writeFile(file("thread.json"), JSON.stringify(contract));
  const normalize = (output: string) =>
    spawnSync(
      process.execPath,
      [
        path.join(scripts, "gmail-normalize.mjs"),
        "messages",
        "--account",
        "owner@example.com",
        "--input",
        file("thread.json"),
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
  const first = normalize(file("messages.jsonl"));
  expect(first.status).toBe(0);
  expect(JSON.parse(first.stderr)).toMatchObject({
    provider: "gmail",
    source_key: "gmail:owner@example.com/18c0ffee0001",
    item_count: 2,
    newest_message_id: "18c0ffee0002",
  });
  const rows = (await readFile(file("messages.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.map((row) => [row.id, row.occurred_at])).toStrictEqual([
    ["18c0ffee0001/18c0ffee0001", "2026-11-20T17:00:00.000Z"],
    ["18c0ffee0001/18c0ffee0002", "2026-11-21T09:00:00.000Z"],
  ]);
  expect(rows[0].payload).toMatchObject({
    author_id: "ann@acme.example",
    author_name: "Ann Lee",
    by_owner: 0,
    cc: ["bo@acme.example"],
  });
  expect(rows[1].payload).toMatchObject({
    by_owner: 1,
    content: "Will do, I'll send it Thursday.",
    quoted_lines_removed: 3,
    reply_to_message_id: "18c0ffee0001/18c0ffee0001",
    attachments: "pilot.pdf",
  });

  // Reading it again after it was opened changes labels, not hashes.
  const opened = structuredClone(contract);
  opened.messages[1]!.labelIds = ["INBOX", "CATEGORY_PROMOTIONS"];
  await writeFile(file("thread.json"), JSON.stringify(opened));
  normalize(file("again.jsonl"));
  const again = (await readFile(file("again.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(again.map((row) => row.sha256)).toStrictEqual(rows.map((row) => row.sha256));

  run("chat-transcript.mjs", [
    "--input",
    file("messages.jsonl"),
    "--output-dir",
    file("transcript"),
    "--channel",
    "Email: Pilot contract",
    "--source-key",
    "gmail:owner@example.com/18c0ffee0001",
  ]);
  const day = await readFile(path.join(file("transcript"), "2026-11-21.txt"), "utf8");
  expect(day).toContain("09:00 Owner ↩ Ann Lee 2026-11-20 17:00");
  expect(day).toContain(": Will do, I'll send it Thursday. [attachment]");
  run("source-manifest.mjs", [
    "snapshot",
    "--provider",
    "gmail",
    "--source-key",
    "gmail:owner@example.com/18c0ffee0001",
    "--coverage-start",
    "2026-11-20T17:00:00Z",
    "--coverage-end",
    "2026-11-28T00:00:00Z",
    "--completeness",
    "complete",
    "--input",
    file("messages.jsonl"),
    "--output",
    file("manifest.jsonl.gz"),
    "--summary",
    file("snapshot.json"),
  ]);
  expect(JSON.parse(await readFile(file("snapshot.json"), "utf8"))).toMatchObject({
    item_count: 2,
  });
});

// A stand-in Composio CLI that records each call and answers from a scripted mailbox.
const FAKE_CLI = String.raw`#!/usr/bin/env node
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\n");
const mode = process.env.FAKE_MODE ?? "ok";
if (args[0] === "whoami") {
  process.stdout.write(mode === "signed-out" ? "" : JSON.stringify({ email: "owner@example.com" }));
  process.exit(0);
}
const input = JSON.parse(args[args.indexOf("-d") + 1]);
// In stored mode a thread's answer is saved to a file, as the CLI does for large answers.
const answer = (data) => {
  if (mode !== "stored" || args[1] !== "GMAIL_FETCH_MESSAGE_BY_THREAD_ID") {
    process.stdout.write(JSON.stringify({ successful: true, data }));
    return;
  }
  const folder = path.resolve("saved", input.page_token ?? "first");
  mkdirSync(folder, { recursive: true });
  const outputFilePath = path.join(folder, "answer.json");
  writeFileSync(outputFilePath, JSON.stringify({ successful: true, data }));
  process.stdout.write(JSON.stringify({ successful: true, storedInFile: true, outputFilePath, sizeBytes: 1, tokenCount: 1 }));
};
if (mode === "unlinked") {
  process.stdout.write(JSON.stringify({ successful: false, error: "No connected account found for toolkit gmail. Run composio link gmail" }));
  process.exit(1);
}
if (mode === "busy") {
  process.stderr.write("HTTP 429 Too Many Requests\n");
  process.exit(75);
}
if (args[1] === "GMAIL_GET_PROFILE") {
  answer({ emailAddress: "Owner@Example.com", historyId: "1000" });
} else if (args[1] === "GMAIL_LIST_THREADS") {
  if (input.query.includes("in:sent")) {
    answer({ threads: [{ id: "18c0ffee0001", historyId: "900", snippet: "Will do" }] });
  } else if (!input.page_token) {
    answer({
      threads: [{ id: "18c0ffee00b2", historyId: "1000", snippet: "b" }, { id: "18c0ffee0001", historyId: "900", snippet: "Can you" }],
      nextPageToken: "page-2",
    });
  } else {
    answer({ threads: [{ id: "18c0ffee00b1", historyId: "99", snippet: "a" }] });
  }
} else if (args[1] === "GMAIL_FETCH_MESSAGE_BY_THREAD_ID") {
  answer(
    input.page_token === "more"
      ? { threadId: input.thread_id, messages: [{ messageId: "m2" }] }
      : { threadId: input.thread_id, messages: [{ messageId: "m1" }], nextPageToken: "more" },
  );
} else {
  process.exit(9);
}
`;

it("reads Gmail through the Composio CLI with read-only tools only", async () => {
  const dir = tempDirs.make("gmail-read-");
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "composio"), FAKE_CLI);
  await chmod(path.join(bin, "composio"), 0o755);
  const log = path.join(dir, "calls.jsonl");
  const read = (args: string[], mode = "ok") =>
    spawnSync(process.execPath, [path.join(scripts, "gmail-read.mjs"), ...args], {
      encoding: "utf8",
      cwd: dir,
      env: {
        ...process.env,
        PATH: bin + path.delimiter + path.dirname(process.execPath),
        FAKE_LOG: log,
        FAKE_MODE: mode,
      },
    });
  const calls = async () => {
    const text = await readFile(log, "utf8").catch(() => "");
    await writeFile(log, "");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  };

  const check = read(["check"]);
  expect(JSON.parse(check.stdout)).toStrictEqual({ ok: true, account: "owner@example.com" });
  expect(await calls()).toStrictEqual([
    ["whoami"],
    ["execute", "GMAIL_GET_PROFILE", "-d", JSON.stringify({ user_id: "me" })],
  ]);

  const listed = read(["list", "--after", "1795651200", "--sent", "--output", "list.json"]);
  expect(listed.status).toBe(0);
  const list = JSON.parse(await readFile(path.join(dir, "list.json"), "utf8"));
  // Oldest change first, each thread once across both queries.
  expect(list.threads.map((thread: { id: string }) => thread.id)).toStrictEqual([
    "18c0ffee00b1",
    "18c0ffee0001",
    "18c0ffee00b2",
  ]);
  expect(list.queries).toStrictEqual([
    "after:1795651200 -category:promotions -category:social -category:forums -in:chats -in:draft",
    "after:1795651200 in:sent -in:draft",
  ]);
  const listCalls = await calls();
  expect(listCalls.filter((call) => call[1] === "GMAIL_LIST_THREADS")).toHaveLength(3);
  read(["list", "--after", "1795651200", "--output", "received.json"]);
  const received = JSON.parse(await readFile(path.join(dir, "received.json"), "utf8"));
  expect(received.queries).toStrictEqual([
    "after:1795651200 -category:promotions -category:social -category:forums -in:chats -in:draft -in:sent",
  ]);

  const fetched = read([
    "threads",
    "--id",
    "18c0ffee0001",
    "--id",
    "18c0ffee00b1",
    "--output-dir",
    "t",
  ]);
  expect(JSON.parse(fetched.stdout).files).toHaveLength(2);
  // Every page of a long thread is read into one file.
  expect(
    JSON.parse(await readFile(path.join(dir, "t", "18c0ffee0001.json"), "utf8")),
  ).toStrictEqual({
    threadId: "18c0ffee0001",
    messages: [{ messageId: "m1" }, { messageId: "m2" }],
  });
  // An answer the CLI saved to a file is read whole, and the file and its folder are removed.
  const stored = read(["threads", "--id", "18c0ffee0001", "--output-dir", "s"], "stored");
  expect(stored.status).toBe(0);
  expect(
    JSON.parse(await readFile(path.join(dir, "s", "18c0ffee0001.json"), "utf8")),
  ).toStrictEqual({
    threadId: "18c0ffee0001",
    messages: [{ messageId: "m1" }, { messageId: "m2" }],
  });
  expect(await readdir(path.join(dir, "saved"))).toStrictEqual([]);
  // Every tool the script ran reads Gmail; nothing else reached the CLI.
  const slugs = new Set(
    [...listCalls, ...(await calls())].flatMap((call) =>
      call[0] === "execute" && call[1] ? [call[1]] : [],
    ),
  );
  expect([...slugs].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
    "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    "GMAIL_GET_PROFILE",
    "GMAIL_LIST_THREADS",
  ]);

  // A thread ID that is not one never reaches the CLI.
  const refused = read(["threads", "--id", "../../etc", "--output-dir", "t"]);
  expect(refused.status).toBe(2);
  expect(await calls()).toStrictEqual([]);
  // Each connection failure names its problem.
  const problem = (args: string[], mode: string) => JSON.parse(read(args, mode).stdout).problem;
  expect(problem(["check"], "signed-out")).toBe("signed-out");
  expect(problem(["check"], "unlinked")).toBe("gmail-not-linked");
  expect(problem(["check"], "busy")).toBe("temporary");
  const missing = spawnSync(process.execPath, [path.join(scripts, "gmail-read.mjs"), "check"], {
    encoding: "utf8",
    env: { ...process.env, PATH: path.join(dir, "empty") },
  });
  expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, problem: "cli-missing" });
});
