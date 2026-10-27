#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { finished } from "node:stream/promises";

/** Run the command; the help branch returns so stdout drains before Node exits. */
async function run(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: node discrawl-normalize.mjs --config PATH --channel ID_OR_NAME --since RFC3339 --before RFC3339 [--guild ID] [--threads include] [--output PATH|-]\n\n" +
        "Exports deterministic normalized Discord message JSONL from a configured read-only Discrawl archive. Bounds are half-open [since,before). Use a stable channel ID when names are ambiguous. --threads include adds messages from threads and forum posts under the channel.\n",
    );
    return;
  }
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) {
      throw new Error("Arguments must be --name value pairs");
    }
    options.set(argv[index].slice(2), argv[index + 1]);
  }
  const need = (name) => {
    const value = options.get(name);
    if (!value) {
      throw new Error("--" + name + " is required");
    }
    return value;
  };
  const timestamp = (value, name) => {
    if (!/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new Error("--" + name + " must be RFC3339 with an explicit offset");
    }
    // Discrawl stores UTC timestamps with nine fractional digits. Comparing a
    // caller's offset string directly in SQLite shifts the requested interval.
    const fraction = value.match(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/)?.[1] ?? "";
    if (fraction.length > 9) {
      throw new Error("--" + name + " supports at most nanosecond precision");
    }
    return new Date(value).toISOString().slice(0, 19) + "." + fraction.padEnd(9, "0") + "Z";
  };
  const config = need("config");
  const requestedChannel = need("channel");
  const since = timestamp(need("since"), "since");
  const before = timestamp(need("before"), "before");
  if (Date.parse(since) >= Date.parse(before)) {
    throw new Error("--since must precede --before");
  }
  const status = spawnSync("discrawl", ["--config", config, "--json", "status"], {
    encoding: "utf8",
    env: { ...process.env, DISCRAWL_NO_AUTO_UPDATE: "1", DISCRAWL_NO_UPDATE_CHECK: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (status.status !== 0) {
    throw new Error(status.stderr || "discrawl status failed");
  }
  const databasePath = JSON.parse(status.stdout).database_path;
  if (!databasePath) {
    throw new Error("Discrawl status did not return database_path");
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const output = options.get("output") ?? "-";
  const destination = output === "-" ? process.stdout : createWriteStream(output);
  try {
    let channel;
    if (/^\d+$/.test(requestedChannel)) {
      channel = database
        .prepare("SELECT id,guild_id,name FROM channels WHERE id=?")
        .get(requestedChannel);
    } else {
      const name = requestedChannel.replace(/^#/, "");
      const rows = options.get("guild")
        ? database
            .prepare(
              "SELECT id,guild_id,name FROM channels WHERE name=? AND guild_id=? ORDER BY id",
            )
            .all(name, options.get("guild"))
        : database
            .prepare("SELECT id,guild_id,name FROM channels WHERE name=? ORDER BY id")
            .all(name);
      if (rows.length !== 1) {
        throw new Error(
          "Channel name resolved to " +
            rows.length +
            " rows; supply --channel with the stable channel ID" +
            (rows.length ? ": " + rows.map((row) => row.id).join(", ") : ""),
        );
      }
      channel = rows[0];
    }
    if (!channel) {
      throw new Error("Channel not found in the approved Discrawl archive");
    }
    if (options.get("guild") && channel.guild_id !== options.get("guild")) {
      throw new Error("Channel does not belong to the requested guild");
    }
    const threads = options.get("threads");
    if (threads !== undefined && threads !== "include") {
      throw new Error('--threads accepts only "include"');
    }
    // Threads and forum posts are their own channels whose thread_parent_id is the parent channel.
    const scope = threads
      ? "SELECT id FROM channels WHERE id=?1 OR thread_parent_id=?1"
      : "SELECT ?1";
    const sql =
      "SELECT m.id,t.id AS thread_id,t.name AS thread_name,m.guild_id,m.channel_id,m.author_id,u.username AS author_username,u.global_name AS author_global_name,u.display_name AS author_display_name,u.nick AS author_nick,u.bot AS author_bot,m.message_type,m.created_at,m.edited_at,m.deleted_at,m.content,m.normalized_content,m.reply_to_message_id,m.pinned,m.has_attachments,(SELECT group_concat(value, '|') FROM (SELECT a.attachment_id || ':' || coalesce(a.content_sha256,'') || ':' || coalesce(a.fetch_status,'') AS value FROM message_attachments a WHERE a.message_id=m.id ORDER BY a.attachment_id)) AS attachments FROM messages m LEFT JOIN members u ON u.guild_id=m.guild_id AND u.user_id=m.author_id LEFT JOIN channels t ON t.id=m.channel_id AND t.id<>?1 WHERE m.channel_id IN (" +
      scope +
      ") AND m.created_at>=?2 AND m.created_at<?3 ORDER BY m.created_at,m.id";
    const statement = database.prepare(sql);
    let count = 0;
    let watermark = null;
    for (const row of statement.iterate(channel.id, since, before)) {
      const payload = {
        guild_id: row.guild_id,
        channel_id: row.channel_id,
        ...(row.thread_id ? { thread_id: row.thread_id, thread_name: row.thread_name } : {}),
        author_id: row.author_id,
        author_name:
          row.author_display_name ||
          row.author_global_name ||
          row.author_nick ||
          row.author_username ||
          row.author_id,
        author_username: row.author_username,
        author_global_name: row.author_global_name,
        author_display_name: row.author_display_name,
        author_nick: row.author_nick,
        author_bot: row.author_bot,
        message_type: row.message_type,
        created_at: row.created_at,
        edited_at: row.edited_at,
        deleted_at: row.deleted_at,
        content: row.content,
        normalized_content: row.normalized_content,
        reply_to_message_id: row.reply_to_message_id,
        pinned: row.pinned,
        has_attachments: row.has_attachments,
        attachments: row.attachments,
      };
      if (
        !destination.write(
          JSON.stringify({ id: String(row.id), occurred_at: row.created_at, payload }) + "\n",
        )
      ) {
        await once(destination, "drain");
      }
      count++;
      watermark = String(row.id);
    }
    if (destination !== process.stdout) {
      destination.end();
      await finished(destination);
    }
    process.stderr.write(
      JSON.stringify({
        provider: "discord",
        source_key: "discord:" + channel.guild_id + ":" + channel.id,
        guild_id: channel.guild_id,
        channel_id: channel.id,
        channel_name: channel.name,
        coverage_start: since,
        coverage_end: before,
        item_count: count,
        watermark,
        database_path: databasePath,
      }) + "\n",
    );
  } finally {
    database.close();
  }
}

await run(process.argv.slice(2));
