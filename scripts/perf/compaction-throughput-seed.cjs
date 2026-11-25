"use strict";
// usage: node seed.cjs <sessionsDir> <sessionKey> <targetMB> <cwd> [activeMB]
// [activeMB] (adaptation): after <targetMB> of history, append a compaction entry and <activeMB> more of turns, so the history before it is an obsolete archive.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [dir, key, mbS, cwd, activeS] = process.argv.slice(2);
const target = Number(mbS) * 1048576;
fs.mkdirSync(dir, { recursive: true });
// Deterministic content; only the session header cwd is fixture-local.
let ctr = 0;
const seedKey = process.env.SEED || key + ":" + mbS + ":" + (activeS || "");
const prng = (n) => {
  const out = [];
  let got = 0;
  while (got < n) {
    const h = crypto
      .createHash("sha512")
      .update(seedKey + ":" + ctr++)
      .digest();
    out.push(h);
    got += h.length;
  }
  return Buffer.concat(out).subarray(0, n);
};
const sidHex = prng(16).toString("hex");
const sid = [
  sidHex.slice(0, 8),
  sidHex.slice(8, 12),
  "4" + sidHex.slice(13, 16),
  "8" + sidHex.slice(17, 20),
  sidHex.slice(20, 32),
].join("-");
const file = path.join(dir, sid + ".jsonl");
const fd = fs.openSync(file, "w");
let t = Date.parse("2026-09-01T00:00:00Z");
const ts = () => new Date((t += 1500)).toISOString();
const id = () => prng(4).toString("hex");
let parent = null,
  bytes = 0,
  events = 0;
const w = (o) => {
  const s = JSON.stringify(o) + "\n";
  fs.writeSync(fd, s);
  events++;
  return s.length;
};
bytes += w({ type: "session", version: 3, id: sid, timestamp: ts(), cwd });
const usage = {
  input: 1000,
  output: 200,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const rnd = (n) =>
  prng(Math.ceil((n * 3) / 4))
    .toString("base64")
    .slice(0, n);
const sizes = [2000, 6000, 12000, 20000, 40000, 80000, 190000];
let turn = 0;
const turnLoop = (targetBytes) => {
  while (bytes < targetBytes) {
    turn++;
    const u = {
      type: "message",
      id: id(),
      parentId: parent,
      timestamp: ts(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "Turn " + turn + ": please check the repro state. " + rnd(300) },
        ],
        timestamp: t,
      },
    };
    bytes += w(u);
    parent = u.id;
    for (let k = 0; k < 3 && bytes < targetBytes; k++) {
      const cid = "call_" + turn + "_" + k;
      const a = {
        type: "message",
        id: id(),
        parentId: parent,
        timestamp: ts(),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Running step " + k + ". " + rnd(200) },
            {
              type: "toolCall",
              id: cid,
              name: "exec",
              arguments: { command: "cat /tmp/repro-" + turn + "-" + k + ".log" },
            },
          ],
          api: "openai-completions",
          provider: "fixture",
          model: "fixture",
          usage,
          stopReason: "toolUse",
          timestamp: t,
        },
      };
      bytes += w(a);
      parent = a.id;
      const sz = sizes[(turn * 7 + k * 3) % sizes.length];
      const r = {
        type: "message",
        id: id(),
        parentId: parent,
        timestamp: ts(),
        message: {
          role: "toolResult",
          toolCallId: cid,
          toolName: "exec",
          content: [{ type: "text", text: rnd(sz) }],
          isError: false,
          timestamp: t,
        },
      };
      bytes += w(r);
      parent = r.id;
    }
    const f = {
      type: "message",
      id: id(),
      parentId: parent,
      timestamp: ts(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done with turn " + turn + ". " + rnd(600) }],
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        usage,
        stopReason: "stop",
        timestamp: t,
      },
    };
    bytes += w(f);
    parent = f.id;
  }
};
turnLoop(target);
let archiveEvents = null;
if (activeS) {
  archiveEvents = events;
  const lastUser = parent;
  const c = {
    type: "compaction",
    id: id(),
    parentId: parent,
    timestamp: ts(),
    summary: "## Goal\nSeeded archive boundary.\n## Progress\n- earlier turns summarized",
    firstKeptEntryId: lastUser,
    tokensBefore: 150000000,
  };
  bytes += w(c);
  parent = c.id;
  turnLoop(bytes + Number(activeS) * 1048576);
}
fs.closeSync(fd);
const store = path.join(dir, "sessions.json");
let s = {};
try {
  s = JSON.parse(fs.readFileSync(store, "utf8"));
} catch {}
s[key] = { sessionId: sid, updatedAt: t, sessionFile: file, chatType: "direct" };
fs.writeFileSync(store, JSON.stringify(s, null, 1));
console.log(
  JSON.stringify({
    sid,
    file,
    events,
    archiveEvents,
    MB: Math.round(bytes / 1048576),
    turns: turn,
  }),
);
