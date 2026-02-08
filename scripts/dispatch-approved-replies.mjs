#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const queuePath =
  process.env.OPENCLAW_REPLY_QUEUE ||
  path.join(process.cwd(), "memory", "reply-queue.json");

function nowIso() {
  return new Date().toISOString();
}

function readQueue() {
  const raw = fs.readFileSync(queuePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error("Invalid queue file format");
  }
  return parsed;
}

function writeQueue(queue) {
  queue.updatedAt = nowIso();
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
}

function getPending(queue) {
  return queue.items
    .filter((item) => item.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function parseArgs(tokens) {
  const out = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.startsWith("--")) continue;
    const key = t.slice(2);
    const next = tokens[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function parseIndexList(text) {
  const matches = String(text).match(/\d+/g) || [];
  return [...new Set(matches.map((v) => Number(v)).filter((n) => n > 0))];
}

function normalizeCommand(raw) {
  return String(raw || "")
    .replace(/,\s*(send|skip|rewrite)\b/gi, " and $1")
    .trim();
}

function parseApprovalCommand(raw) {
  const command = normalizeCommand(raw);
  if (!command) throw new Error("Empty command");

  const actions = [];
  const clauses = command.split(/\s+and\s+/i).map((v) => v.trim()).filter(Boolean);
  for (const clause of clauses) {
    let m = clause.match(/^send\s+(.+)$/i);
    if (m) {
      const indexes = parseIndexList(m[1]);
      if (indexes.length === 0) throw new Error(`Invalid send clause: "${clause}"`);
      for (const index of indexes) actions.push({ type: "send", index });
      continue;
    }

    m = clause.match(/^skip\s+(.+)$/i);
    if (m) {
      const indexes = parseIndexList(m[1]);
      if (indexes.length === 0) throw new Error(`Invalid skip clause: "${clause}"`);
      for (const index of indexes) actions.push({ type: "skip", index });
      continue;
    }

    m = clause.match(/^rewrite\s+(\d+)\s*:\s*(.+)$/i);
    if (m) {
      actions.push({
        type: "rewrite",
        index: Number(m[1]),
        text: m[2].trim(),
      });
      continue;
    }

    throw new Error(`Unsupported clause: "${clause}"`);
  }

  return actions;
}

function resolveActionTargets(actions, pending) {
  return actions.map((action) => {
    const item = pending[action.index - 1];
    if (!item) {
      throw new Error(`Queue index ${action.index} not found`);
    }

    if (action.type === "send") {
      const draft = String(item.drafts?.[0] || "").trim();
      if (!draft) throw new Error(`Queue index ${action.index} has no draft`);
      return { ...action, itemId: item.id, to: item.from, text: draft };
    }

    if (action.type === "rewrite") {
      if (!action.text) throw new Error(`Rewrite for index ${action.index} is empty`);
      return { ...action, itemId: item.id, to: item.from };
    }

    return { ...action, itemId: item.id };
  });
}

function runSend(to, message, dryRun) {
  const cmd = [
    "message",
    "send",
    "--channel",
    "whatsapp",
    "--target",
    to,
    "--message",
    message,
    "--json",
  ];
  if (dryRun) {
    return { ok: true, dryRun: true, cmd: ["openclaw", ...cmd] };
  }
  const res = spawnSync("openclaw", cmd, { encoding: "utf8" });
  if (res.status !== 0) {
    return {
      ok: false,
      error: (res.stderr || res.stdout || `exit ${res.status}`).trim(),
    };
  }
  return { ok: true, output: (res.stdout || "").trim() };
}

function applyState(queue, op) {
  const item = queue.items.find((x) => x.id === op.itemId && x.status === "pending");
  if (!item) return;
  if (op.type === "skip") {
    item.status = "skipped";
    item.resolvedAt = nowIso();
    return;
  }
  item.status = "sent";
  item.resolvedAt = nowIso();
  if (op.type === "rewrite") {
    item.drafts = [op.text, ...(item.drafts || []).filter((d) => d !== op.text)].slice(0, 2);
  }
}

function usage() {
  console.error(
    [
      "dispatch-approved-replies.mjs",
      "  --command \"send 1 and rewrite 2: <text>\"",
      "  [--dry-run]",
    ].join("\n"),
  );
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command;
  const dryRun = Boolean(args["dry-run"]);
  if (!command) usage();

  const queue = readQueue();
  const pending = getPending(queue);
  const actions = parseApprovalCommand(command);
  const ops = resolveActionTargets(actions, pending);

  const results = [];
  for (const op of ops) {
    if (op.type === "skip") {
      if (!dryRun) applyState(queue, op);
      results.push({ ok: true, type: "skip", index: op.index, itemId: op.itemId });
      continue;
    }

    const text = op.text;
    const sendRes = runSend(op.to, text, dryRun);
    if (!sendRes.ok) {
      results.push({
        ok: false,
        type: op.type,
        index: op.index,
        itemId: op.itemId,
        error: sendRes.error,
      });
      if (!dryRun) {
        // Fail-fast on first send error to avoid partial unknown state.
        break;
      }
      continue;
    }
    if (!dryRun) applyState(queue, op);
    results.push({
      ok: true,
      type: op.type,
      index: op.index,
      itemId: op.itemId,
      to: op.to,
      dryRun: Boolean(sendRes.dryRun),
    });
  }

  if (!dryRun) writeQueue(queue);

  console.log(
    JSON.stringify(
      {
        ok: results.every((r) => r.ok),
        dryRun,
        pendingAfter: getPending(queue).length,
        results,
      },
      null,
      2,
    ),
  );
}

try {
  main();
} catch (err) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
