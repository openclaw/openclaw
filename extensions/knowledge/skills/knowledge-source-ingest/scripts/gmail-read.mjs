#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const USAGE =
  "Usage: node gmail-read.mjs check [--account ID]\n" +
  "       node gmail-read.mjs list --after EPOCH_SECONDS [--sent] [--account ID] --output PATH\n" +
  "       node gmail-read.mjs threads --id THREAD_ID [--id THREAD_ID ...] [--account ID] --output-dir DIR\n\n" +
  "Reads Gmail for the Learn from Mail scribe through the Composio CLI (composio on PATH), and only\n" +
  "with read-only Composio Gmail tools: GMAIL_GET_PROFILE, GMAIL_LIST_THREADS and\n" +
  "GMAIL_FETCH_MESSAGE_BY_THREAD_ID. It never runs any other tool, so it can't send, draft, label,\n" +
  "archive or delete mail.\n\n" +
  "check     Confirms the CLI is installed and signed in and Gmail is linked; prints {ok, account}.\n" +
  "list      Lists threads with mail after EPOCH_SECONDS, leaving out promotions, social and forums\n" +
  "          mail, chats and drafts, and the owner's sent mail unless --sent also lists threads\n" +
  "          with mail they sent. Writes {account, after, queries, threads} with threads as\n" +
  "          {id, historyId, snippet}, oldest change first.\n" +
  "threads   Fetches every page of each thread's messages and writes <THREAD_ID>.json per thread.\n\n" +
  "--account picks a Composio connected account (an id or alias) when several are linked.\n" +
  "A failure prints {ok: false, problem, detail} and exits 2. problem is cli-missing, signed-out,\n" +
  "gmail-not-linked, temporary (the CLI says the same command can safely run again) or gmail-error.\n";

// The only Composio tools this script runs. Each reads Gmail and changes nothing.
const READS = Object.freeze({
  profile: "GMAIL_GET_PROFILE",
  threads: "GMAIL_LIST_THREADS",
  thread: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
});
// Threads one list call asks for, and the most pages one listing reads.
const PAGE_SIZE = 50;
const MAX_PAGES = 40;
// Threads fetched at once.
const FETCHES_AT_ONCE = 4;
// Gmail IDs are hexadecimal; anything else is refused before the CLI sees it.
const GMAIL_ID = /^[0-9a-f]{6,32}$/i;

class ReadError extends Error {
  constructor(problem, detail) {
    super(detail);
    this.problem = problem;
  }
}

// One CLI call without a shell. Resolves with exit code, stdout and stderr.
const cli = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "composio",
      args,
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 },
      (error, stdout, stderr) => {
        if (error && error.code === "ENOENT") {
          reject(new ReadError("cli-missing", "The Composio CLI (composio) is not on PATH."));
          return;
        }
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });

// The first line of what the CLI said, without the rest of its output.
const firstLine = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 300) ?? "";

const LINK_WORDS =
  /\b(?:no (?:active )?connected account|not connected|composio link|connect(?:ion)? (?:required|not found)|link gmail)\b/i;
const LOGIN_WORDS =
  /\b(?:composio login|not (?:logged|signed) in|log in again|unauthori[sz]ed|api key)\b/i;

// Run one allowlisted read and return its data. `tool` is a key of READS, never a slug.
async function read(tool, input, account) {
  const slug = READS[tool];
  if (!slug) {
    throw new ReadError("gmail-error", "Not a read this script runs: " + tool);
  }
  const args = ["execute", slug, "-d", JSON.stringify(input)];
  if (account) {
    args.push("--account", account);
  }
  const { code, stdout, stderr } = await cli(args);
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    result = undefined;
  }
  const error =
    typeof result?.error === "string" ? result.error : JSON.stringify(result?.error ?? "");
  const said = firstLine(result?.error ? error : "") || firstLine(stderr) || firstLine(stdout);
  if (code === 75) {
    throw new ReadError("temporary", said || slug + " can safely run again");
  }
  if (code !== 0 || !result || result.successful === false) {
    const problem = LINK_WORDS.test(said)
      ? "gmail-not-linked"
      : LOGIN_WORDS.test(said)
        ? "signed-out"
        : "gmail-error";
    throw new ReadError(problem, slug + ": " + (said || "exit " + code));
  }
  if (!("data" in result) && "data_preview" in result) {
    throw new ReadError("gmail-error", slug + ": the answer was too large and came back shortened");
  }
  const data = "data" in result ? result.data : result;
  return data?.response_data ?? data;
}

// The connected Gmail address, after the CLI confirms it is signed in.
async function check(account) {
  // `composio whoami` exits 0 with nothing on stdout when signed out.
  const whoami = await cli(["whoami"]);
  if (whoami.code !== 0 || !whoami.stdout.trim()) {
    throw new ReadError(
      "signed-out",
      "composio whoami reports no signed-in user; run composio login.",
    );
  }
  const profile = await read("profile", { user_id: "me" }, account);
  const address = typeof profile?.emailAddress === "string" ? profile.emailAddress.trim() : "";
  if (!address.includes("@")) {
    throw new ReadError("gmail-error", READS.profile + ": the answer had no email address");
  }
  return address.toLowerCase();
}

// Gmail historyIds are decimal strings too large for a Number; compare them by length, then text.
const historyOrder = (a, b) =>
  a.historyId.length - b.historyId.length ||
  (a.historyId < b.historyId ? -1 : a.historyId > b.historyId ? 1 : 0);

async function list(after, sent, account) {
  const base =
    "after:" +
    after +
    " -category:promotions -category:social -category:forums -in:chats -in:draft";
  const queries = sent ? [base, "after:" + after + " in:sent -in:draft"] : [base + " -in:sent"];
  const threads = new Map();
  for (const query of queries) {
    let pageToken;
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) {
        throw new ReadError(
          "gmail-error",
          "More than " + MAX_PAGES * PAGE_SIZE + " threads match; start from a later date.",
        );
      }
      const data = await read(
        "threads",
        {
          user_id: "me",
          query,
          max_results: PAGE_SIZE,
          verbose: false,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
        account,
      );
      for (const thread of Array.isArray(data?.threads) ? data.threads : []) {
        if (typeof thread?.id === "string" && GMAIL_ID.test(thread.id)) {
          threads.set(thread.id, {
            id: thread.id,
            historyId: String(thread.historyId ?? ""),
            snippet: typeof thread.snippet === "string" ? thread.snippet : "",
          });
        }
      }
      pageToken = data?.nextPageToken ?? data?.next_page_token;
      if (typeof pageToken !== "string" || !pageToken) {
        break;
      }
    }
  }
  return { after, queries, threads: [...threads.values()].toSorted(historyOrder) };
}

async function fetchThreads(ids, account, dir) {
  await mkdir(dir, { recursive: true });
  const queue = [...ids];
  const written = [];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      // A long thread comes in pages; the file holds every message or is not written.
      let data;
      const messages = [];
      for (let pageToken, page = 0; ; page++) {
        if (page === MAX_PAGES) {
          throw new ReadError(
            "gmail-error",
            "Thread " + id + " has more than " + MAX_PAGES + " pages",
          );
        }
        data = await read(
          "thread",
          { user_id: "me", thread_id: id, ...(pageToken ? { page_token: pageToken } : {}) },
          account,
        );
        messages.push(...(Array.isArray(data?.messages) ? data.messages : []));
        pageToken = data?.nextPageToken ?? data?.next_page_token;
        if (typeof pageToken !== "string" || !pageToken) {
          break;
        }
      }
      const { nextPageToken: _next, next_page_token: _nextSnake, ...thread } = data ?? {};
      const file = path.join(dir, id + ".json");
      await writeFile(file, JSON.stringify({ ...thread, messages }));
      written.push(file);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCHES_AT_ONCE, queue.length) }, worker));
  return written.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function run(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return;
  }
  const options = new Map();
  const ids = [];
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    if (name === "--sent") {
      options.set("sent", true);
      continue;
    }
    if (!name?.startsWith("--") || rest[index + 1] === undefined) {
      throw new ReadError("gmail-error", "Arguments must be --name value pairs, or --sent");
    }
    if (name === "--id") {
      ids.push(rest[++index]);
    } else {
      options.set(name.slice(2), rest[++index]);
    }
  }
  const account = options.get("account");
  if (command === "check") {
    process.stdout.write(JSON.stringify({ ok: true, account: await check(account) }) + "\n");
    return;
  }
  if (command === "list") {
    const after = options.get("after");
    const output = options.get("output");
    if (!/^\d{9,11}$/.test(after ?? "") || !output) {
      throw new ReadError("gmail-error", "list needs --after EPOCH_SECONDS and --output PATH");
    }
    const address = await check(account);
    const listed = await list(after, options.get("sent") === true, account);
    await writeFile(output, JSON.stringify({ account: address, ...listed }));
    process.stdout.write(
      JSON.stringify({ ok: true, account: address, threads: listed.threads.length }) + "\n",
    );
    return;
  }
  if (command === "threads") {
    const dir = options.get("output-dir");
    if (!ids.length || !dir || ids.some((id) => !GMAIL_ID.test(id ?? ""))) {
      throw new ReadError(
        "gmail-error",
        "threads needs Gmail thread IDs (--id) and --output-dir DIR",
      );
    }
    const files = await fetchThreads([...new Set(ids)], account, dir);
    process.stdout.write(JSON.stringify({ ok: true, files }) + "\n");
    return;
  }
  throw new ReadError("gmail-error", "Unknown command " + command + "; see --help");
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      problem: error instanceof ReadError ? error.problem : "gmail-error",
      detail: error instanceof Error ? error.message : String(error),
    }) + "\n",
  );
  process.exitCode = 2;
}
