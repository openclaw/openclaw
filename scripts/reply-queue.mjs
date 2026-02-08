#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withFileLockSync, writeJsonAtomicSync } from "./lib/json-state-lock.mjs";

const queuePath =
  process.env.OPENCLAW_REPLY_QUEUE ||
  path.join(process.cwd(), "memory", "reply-queue.json");

function nowIso() {
  return new Date().toISOString();
}

function readQueue() {
  try {
    const raw = fs.readFileSync(queuePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid queue");
    if (!Array.isArray(parsed.items)) parsed.items = [];
    return parsed;
  } catch {
    // Start from an empty queue if the file is missing/corrupt.
    return { version: 1, updatedAt: nowIso(), items: [] };
  }
}

function writeQueue(queue) {
  queue.updatedAt = nowIso();
  writeJsonAtomicSync(queuePath, queue);
}

function stableHash(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function parseArgs(tokens) {
  // Tiny flag parser for this script's limited CLI surface.
  const out = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = tokens[i + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) i += 1;
    if (out[key] === undefined) {
      out[key] = value;
    } else if (Array.isArray(out[key])) {
      out[key].push(value);
    } else {
      out[key] = [out[key], value];
    }
  }
  return out;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function getPending(queue) {
  // Pending items are rendered in stable FIFO order for digest indices.
  return queue.items
    .filter((item) => item.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function oneLine(text, maxLen = 220) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}...`;
}

function requireField(obj, key) {
  if (!obj[key] || typeof obj[key] !== "string") {
    throw new Error(`missing required string field: ${key}`);
  }
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function addJson() {
  const raw = readStdin();
  const payload = JSON.parse(raw);
  requireField(payload, "channel");
  requireField(payload, "from");
  requireField(payload, "text");

  const drafts = (payload.drafts || [])
    .map((d) => String(d || "").trim())
    .filter(Boolean)
    .slice(0, 2);
  if (drafts.length === 0) {
    throw new Error("at least one draft is required in drafts[]");
  }

  const thread = payload.thread || `${payload.channel}:${payload.from}`;
  // Dedupe on (thread + message text) so retries don't create duplicate queue entries.
  const key = stableHash(`${thread}\n${payload.text}`);

  let result;
  withFileLockSync(queuePath, () => {
    const queue = readQueue();
    const existing = queue.items.find(
      (item) => item.status === "pending" && item.dedupeKey === key,
    );

    if (existing) {
      const mergedDrafts = [...existing.drafts, ...drafts];
      existing.drafts = [...new Set(mergedDrafts)].slice(0, 2);
      existing.lastSeenAt = nowIso();
      existing.preview = oneLine(payload.text);
      writeQueue(queue);
      result = {
        ok: true,
        action: "updated",
        id: existing.id,
        pending: getPending(queue).length,
      };
      return;
    }

    const createdAt = nowIso();
    const id = `${Date.now()}-${key.slice(0, 8)}`;
    queue.items.push({
      id,
      status: "pending",
      channel: payload.channel,
      from: payload.from,
      thread,
      text: payload.text,
      preview: oneLine(payload.text),
      drafts,
      priority: payload.priority || "normal",
      createdAt,
      lastSeenAt: createdAt,
      dedupeKey: key,
      sourceMessageId: payload.sourceMessageId || null,
    });

    writeQueue(queue);
    result = {
      ok: true,
      action: "added",
      id,
      pending: getPending(queue).length,
    };
  });

  console.log(JSON.stringify(result));
}

function listCommand(args) {
  const queue = readQueue();
  const pending = getPending(queue);
  const withIndex = pending.map((item, idx) => ({
    index: idx + 1,
    id: item.id,
    channel: item.channel,
    from: item.from,
    createdAt: item.createdAt,
    preview: item.preview,
    drafts: item.drafts,
  }));

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          pending: withIndex.length,
          items: withIndex,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (withIndex.length === 0) {
    console.log("NO_PENDING_REPLIES");
    return;
  }

  for (const item of withIndex) {
    console.log(`${item.index}) [${item.channel}] ${item.from} :: ${item.preview}`);
  }
}

function digestCommand(args) {
  const queue = readQueue();
  const limit = Number(args.limit || 20);
  const pending = getPending(queue).slice(0, Number.isFinite(limit) ? limit : 20);

  if (pending.length === 0) {
    console.log("NO_PENDING_REPLIES");
    return;
  }

  const lines = [];
  lines.push(`BATCH REPLY DIGEST (${pending.length} pending)`);
  lines.push("");
  pending.forEach((item, idx) => {
    lines.push(`${idx + 1}) ${item.from} [${item.channel}] ${item.createdAt}`);
    lines.push(`msg: ${item.preview}`);
    lines.push(`draft a: ${oneLine(item.drafts[0] || "", 280)}`);
    if (item.drafts[1]) lines.push(`draft b: ${oneLine(item.drafts[1], 280)}`);
    lines.push("");
  });
  lines.push("Reply commands:");
  lines.push("send 1,3");
  lines.push("rewrite 2: <your exact text>");
  lines.push("skip 4");
  lines.push("send 1 and rewrite 2: <text>");

  console.log(lines.join("\n"));
}

function parseIndexList(values) {
  const flat = asArray(values)
    .flatMap((v) => String(v).split(","))
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v > 0);
  return [...new Set(flat)];
}

function markCommand(args) {
  const status = String(args.status || "").trim();
  if (!["sent", "skipped"].includes(status)) {
    throw new Error("mark requires --status sent|skipped");
  }

  const indexes = parseIndexList(args.index);
  const ids = asArray(args.id).map((v) => String(v));

  let result;
  withFileLockSync(queuePath, () => {
    const queue = readQueue();
    const pending = getPending(queue);

    const targetIds = new Set(ids);
    for (const idx of indexes) {
      // Indices are 1-based over current pending list, matching digest output.
      const item = pending[idx - 1];
      if (item) targetIds.add(item.id);
    }

    if (targetIds.size === 0) {
      throw new Error("mark requires --index or --id");
    }

    const changed = [];
    for (const item of queue.items) {
      if (targetIds.has(item.id) && item.status === "pending") {
        item.status = status;
        item.resolvedAt = nowIso();
        changed.push(item.id);
      }
    }

    writeQueue(queue);
    result = {
      ok: true,
      status,
      changed,
      pending: getPending(queue).length,
    };
  });

  console.log(JSON.stringify(result));
}

function usage() {
  const text = [
    "reply-queue.mjs",
    "  add-json        (read JSON payload from stdin)",
    "  list [--json]",
    "  digest [--limit 20]",
    "  mark --status sent|skipped [--index 1,2] [--id <queue-id>]",
  ].join("\n");
  console.error(text);
  process.exit(1);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "add-json") return addJson();
  if (command === "list") return listCommand(args);
  if (command === "digest") return digestCommand(args);
  if (command === "mark") return markCommand(args);

  return usage();
}

try {
  main();
} catch (err) {
  console.error(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
}
