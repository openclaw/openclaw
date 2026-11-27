#!/usr/bin/env node
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { finished } from "node:stream/promises";

const USAGE =
  "Usage: node slack-read-normalize.mjs --team TEAM_ID --channel CHANNEL_ID --input PATH [--input PATH ...] [--output PATH|-]\n\n" +
  "Converts saved results of the Slack plugin's `read` message action (channel history pages and thread\n" +
  "replies of one channel) into deterministic normalized chat JSONL, the format discrawl-normalize.mjs\n" +
  "writes, for chat-transcript.mjs and source-manifest.mjs. Each input is a JSON read result\n" +
  "({messages, hasMore}), an array of them, or JSON Lines of them. Item IDs are CHANNEL_ID/ts; replies\n" +
  "carry thread_id and reply_to_message_id of their root. Authors are named from the profile or bot name\n" +
  "the read returned, otherwise by user ID, and mentioned users from the read's userProfiles as\n" +
  "mention_names. Each row's sha256 covers the message itself, not the labels that depend on what else\n" +
  "was read (author, mention and thread names, reply counts), so an unchanged message\n" +
  "keeps its hash across overlapping reads. A message read more than once keeps its latest edit.\n" +
  "Prints the source key and counts to stderr.\n";

/** Run the command; the help branch returns so stdout drains before Node exits. */
async function run(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const options = new Map();
  const inputs = [];
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error("Arguments must be --name value pairs");
    }
    if (argv[index] === "--input") {
      inputs.push(argv[index + 1]);
    } else {
      options.set(argv[index].slice(2), argv[index + 1]);
    }
  }
  const need = (name) => {
    const value = options.get(name);
    if (!value) {
      throw new Error("--" + name + " is required");
    }
    return value;
  };
  const team = need("team");
  const channel = need("channel");
  if (!inputs.length) {
    throw new Error("--input is required");
  }

  // Slack ts is "<seconds>.<microseconds>"; it becomes RFC3339 UTC with microseconds.
  const instant = (ts, what) => {
    const match = typeof ts === "string" ? /^(\d+)\.(\d{6})$/.exec(ts) : null;
    if (!match) {
      throw new Error(what + " has no Slack ts: " + JSON.stringify(ts));
    }
    return new Date(Number(match[1]) * 1000).toISOString().slice(0, 19) + "." + match[2] + "Z";
  };

  // Every read result in the inputs: a result, an array of results, or JSON Lines of results.
  const results = [];
  const collect = (value, file) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => collect(entry, file));
    } else if (value && Array.isArray(value.messages)) {
      results.push(value);
    } else if (value && value.details && Array.isArray(value.details.messages)) {
      results.push(value.details);
    } else {
      throw new Error(file + " holds something other than Slack read results");
    }
  };
  for (const file of inputs) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
    let parsed;
    try {
      parsed = [JSON.parse(text)];
    } catch {
      parsed = text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    }
    parsed.forEach((value) => collect(value, file));
  }

  // One message per ts. A message read twice keeps its latest edit; a tie keeps the later read.
  const messages = new Map();
  // Mentioned users' names from every read, by user ID.
  const mentionNames = new Map();
  for (const result of results) {
    for (const [userId, profile] of Object.entries(result.userProfiles ?? {})) {
      const name = profile?.display_name || profile?.real_name || profile?.name;
      if (name) {
        mentionNames.set(userId, name);
      }
    }
    const read = result.channelId;
    if (read !== undefined && read !== channel) {
      throw new Error("A read result belongs to channel " + read + ", not " + channel);
    }
    for (const message of result.messages) {
      instant(message.ts, "A message");
      const previous = messages.get(message.ts);
      const edited = (value) => Number(value?.edited?.ts ?? 0);
      if (!previous || edited(message) >= edited(previous)) {
        messages.set(message.ts, message);
      }
    }
  }

  const id = (ts) => channel + "/" + ts;
  // A thread is named by the first line of its root, when the root was read.
  const threadName = (threadTs) => {
    const root = messages.get(threadTs);
    const line = (root?.text ?? "").split("\n")[0].trim();
    return line ? [...line].slice(0, 60).join("") : "thread " + threadTs;
  };
  // Names for the users a message's text mentions, when a read named them.
  const mentionsOf = (text) => {
    const named = {};
    for (const [, userId] of (text ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) {
      if (mentionNames.has(userId)) {
        named[userId] = mentionNames.get(userId);
      }
    }
    return Object.keys(named).length ? named : undefined;
  };
  const rows = [...messages.values()].map((message) => {
    const reply = Boolean(message.thread_ts) && message.thread_ts !== message.ts;
    // A reply also names the users its thread's name mentions.
    const mentioned = mentionsOf(
      reply ? message.text + " " + threadName(message.thread_ts) : message.text,
    );
    const author = message.user ?? message.bot_id ?? "unknown";
    const occurredAt = instant(message.ts, "A message");
    const files = Array.isArray(message.files) ? message.files : [];
    return {
      id: id(message.ts),
      occurred_at: occurredAt,
      payload: {
        team_id: team,
        channel_id: channel,
        ts: message.ts,
        ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
        ...(reply
          ? { thread_id: id(message.thread_ts), thread_name: threadName(message.thread_ts) }
          : {}),
        author_id: author,
        author_name:
          message.user_profile?.display_name ||
          message.user_profile?.real_name ||
          message.username ||
          message.bot_profile?.name ||
          author,
        author_bot: message.bot_id || message.subtype === "bot_message" ? 1 : 0,
        message_type: message.subtype ?? "message",
        created_at: occurredAt,
        edited_at: message.edited?.ts ? instant(message.edited.ts, "An edit") : null,
        deleted_at: null,
        content: message.text ?? "",
        ...(mentioned ? { mention_names: mentioned } : {}),
        reply_to_message_id: reply ? id(message.thread_ts) : null,
        reply_count: message.reply_count ?? 0,
        has_attachments: files.length || message.attachments?.length ? 1 : 0,
        attachments: files.map((file) => file.id).join("|") || null,
      },
    };
  });
  // The hash leaves out labels that depend on the rest of the batch or change with later replies.
  for (const row of rows) {
    const {
      thread_name: _threadName,
      author_name: _authorName,
      mention_names: _mentionNames,
      reply_count: _replyCount,
      ...source
    } = row.payload;
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(source).toSorted(([a], [b]) => (a < b ? -1 : 1))),
    );
    row.sha256 = createHash("sha256").update(canonical).digest("hex");
  }
  rows.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));

  const output = options.get("output") ?? "-";
  const destination = output === "-" ? process.stdout : createWriteStream(output);
  try {
    for (const row of rows) {
      if (!destination.write(JSON.stringify(row) + "\n")) {
        await once(destination, "drain");
      }
    }
    if (destination !== process.stdout) {
      destination.end();
      await finished(destination);
    }
  } finally {
    if (destination !== process.stdout) {
      destination.destroy();
    }
  }
  const top = rows.filter((row) => !row.payload.thread_id);
  process.stderr.write(
    JSON.stringify({
      provider: "slack",
      source_key: "slack:" + team + "/" + channel,
      team_id: team,
      channel_id: channel,
      item_count: rows.length,
      threads: new Set(rows.flatMap((row) => row.payload.thread_id ?? [])).size,
      oldest_ts: rows[0]?.payload.ts ?? null,
      newest_ts: rows.at(-1)?.payload.ts ?? null,
      watermark: top.at(-1)?.payload.ts ?? null,
    }) + "\n",
  );
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
