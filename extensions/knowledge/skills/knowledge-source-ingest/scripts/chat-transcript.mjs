#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USAGE =
  "Usage: node chat-transcript.mjs --input PATH --output-dir DIR --channel LABEL [--source-key KEY] [--max-bytes N]\n\n" +
  "Splits normalized chat JSONL (discrawl-normalize output) into one readable, line-stable transcript per UTC day,\n" +
  "with threads as sections. Days larger than --max-bytes (default 48000) split into parts at thread and message\n" +
  "boundaries. Writes <day>[-partN].txt, the day's rows as <day>.jsonl, and chunks.json describing every file.\n";
/** Run the command; the help branch returns so stdout drains before Node exits. */
async function run(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
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
  const maxBytes = Number(options.get("max-bytes") ?? 48000);
  if (!Number.isInteger(maxBytes) || maxBytes < 1000) {
    throw new Error("--max-bytes must be an integer of at least 1000");
  }
  const channel = need("channel");
  const sourceKey = options.get("source-key");
  const outputDir = need("output-dir");
  const sha256 = (text) => createHash("sha256").update(text).digest("hex");
  const bytes = (text) => Buffer.byteLength(text);
  const clock = (iso) => iso.slice(11, 16);

  // Reads all rows in time order. Splits on \n only: message text may contain U+2028, which readline treats as a line break.
  async function readRows(filename) {
    const rows = (await readFile(filename, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    rows.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));
    return rows;
  }

  // Gives each author a display label; display names shared by different IDs get an ID suffix.
  function authorLabels(rows) {
    const names = new Map();
    for (const { payload } of rows) {
      names.set(payload.author_id, payload.author_name || payload.author_id);
    }
    const counts = new Map();
    for (const name of names.values()) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return new Map(
      [...names].map(([id, name]) => [id, counts.get(name) > 1 ? name + "#" + id.slice(-4) : name]),
    );
  }

  // Renders one message as transcript lines: time, author, reply target, then the text.
  function messageLines(row, byId, labels, day) {
    const { payload } = row;
    const author = labels.get(payload.author_id) + (payload.author_bot ? " (bot)" : "");
    let reply = "";
    const target = payload.reply_to_message_id && byId.get(payload.reply_to_message_id);
    if (target) {
      const when =
        target.occurred_at.slice(0, 10) === day
          ? clock(target.occurred_at)
          : target.occurred_at.slice(0, 10) + " " + clock(target.occurred_at);
      const quote =
        target.occurred_at.slice(0, 10) === day
          ? ""
          : ' "' + (target.payload.content || "").replace(/\s+/g, " ").slice(0, 80) + '"';
      reply = " ↩ " + labels.get(target.payload.author_id) + " " + when + quote;
    } else if (payload.reply_to_message_id) {
      reply = " ↩ earlier message";
    }
    // Discord user mentions (<@id>, <@!id>) read as @name when the author appears in the export.
    let text = payload.deleted_at
      ? "[deleted]"
      : (payload.content || "[no text]").replace(/<@!?(\d+)>/g, (mention, id) =>
          labels.has(id) ? "@" + labels.get(id) : mention,
        );
    if (payload.has_attachments) {
      text += " [attachment]";
    }
    const [first, ...rest] = text.split(/\r\n|[\n\r\u2028\u2029]/);
    return [
      clock(row.occurred_at) + " " + author + reply + ": " + first,
      ...rest.map((line) => "      " + line),
    ];
  }

  // Groups a day's messages into sections: the channel itself first, then each thread by first message.
  function sections(dayRows) {
    const groups = new Map();
    for (const row of dayRows) {
      const key = row.payload.thread_id ?? "";
      if (!groups.has(key)) {
        groups.set(key, { title: key ? "Thread: " + row.payload.thread_name : channel, rows: [] });
      }
      groups.get(key).rows.push(row);
    }
    const main = groups.get("");
    groups.delete("");
    return [...(main ? [main] : []), ...groups.values()];
  }

  // Packs sections into parts under the byte budget. A section that would overflow the current part
  // starts a new one; a section larger than the budget splits between messages.
  function pack(dayRows, byId, labels, day) {
    const parts = [];
    let current = null;
    const open = () => {
      current = { lines: [], rows: [], size: 0 };
      parts.push(current);
    };
    const push = (lines, row) => {
      current.lines.push(...lines);
      if (row) {
        current.rows.push(row);
      }
      current.size += bytes(lines.join("\n") + "\n");
    };
    open();
    for (const section of sections(dayRows)) {
      const blocks = section.rows.map((row) => ({
        row,
        lines: messageLines(row, byId, labels, day),
      }));
      const sectionSize = blocks.reduce(
        (sum, block) => sum + bytes(block.lines.join("\n") + "\n"),
        0,
      );
      if (current.rows.length && current.size + sectionSize > maxBytes && sectionSize <= maxBytes) {
        open();
      }
      push(["", "## " + section.title]);
      for (const block of blocks) {
        if (current.rows.length && current.size + bytes(block.lines.join("\n") + "\n") > maxBytes) {
          open();
          push(["", "## " + section.title + " (continued)"]);
        }
        push(block.lines, block.row);
      }
    }
    return parts;
  }

  // Writes the day's transcript parts and raw rows, returning their chunk descriptions. Labels cover the whole export.
  async function writeDay(day, dayRows, byId, labels) {
    const parts = pack(dayRows, byId, labels, day);
    const raw = dayRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(path.join(outputDir, day + ".jsonl"), raw);
    const chunks = [];
    for (const [index, part] of parts.entries()) {
      const file = day + (parts.length > 1 ? "-part" + (index + 1) : "") + ".txt";
      const authors = [...new Set(part.rows.map((row) => row.payload.author_id))];
      const header = [
        "Channel: " + channel + (sourceKey ? " (" + sourceKey + ")" : ""),
        "Day: " +
          day +
          " (times UTC)" +
          (parts.length > 1 ? " · part " + (index + 1) + " of " + parts.length : ""),
        "Authors: " + authors.map((id) => labels.get(id) + " = " + id).join("; "),
      ];
      const text = [...header, ...part.lines].join("\n") + "\n";
      await writeFile(path.join(outputDir, file), text);
      chunks.push({
        file,
        day,
        part: index + 1,
        parts: parts.length,
        raw: day + ".jsonl",
        raw_sha256: sha256(raw),
        sha256: sha256(text),
        bytes: bytes(text),
        lines: text.split("\n").length - 1,
        messages: part.rows.length,
        first_message_id: part.rows[0]?.id ?? null,
        last_message_id: part.rows.at(-1)?.id ?? null,
        coverage_start: day + "T00:00:00.000Z",
        coverage_end: new Date(Date.parse(day) + 86400000).toISOString(),
        authors: authors.map((id) => ({
          id,
          name: labels.get(id),
          messages: part.rows.filter((row) => row.payload.author_id === id).length,
        })),
      });
    }
    return chunks;
  }

  const rows = await readRows(need("input"));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const days = new Map();
  for (const row of rows) {
    if (!row.occurred_at?.endsWith("Z")) {
      throw new Error("Row " + row.id + " needs a UTC occurred_at");
    }
    const day = row.occurred_at.slice(0, 10);
    if (!days.has(day)) {
      days.set(day, []);
    }
    days.get(day).push(row);
  }
  await mkdir(outputDir, { recursive: true });
  const chunks = [];
  const labels = authorLabels(rows);
  for (const [day, dayRows] of days) {
    chunks.push(...(await writeDay(day, dayRows, byId, labels)));
  }
  await writeFile(
    path.join(outputDir, "chunks.json"),
    JSON.stringify(
      { channel, source_key: sourceKey ?? null, max_bytes: maxBytes, chunks },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    JSON.stringify({ days: days.size, chunks: chunks.length, messages: rows.length }) + "\n",
  );
}

await run(process.argv.slice(2));
