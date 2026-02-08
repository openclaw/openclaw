#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const replyQueueScript = path.join(repoRoot, "scripts", "reply-queue.mjs");
const contactsScript = path.join(repoRoot, "scripts", "contacts-map.mjs");
const dispatchScript = path.join(repoRoot, "scripts", "dispatch-approved-replies.mjs");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-batch-tests-"));
const queuePath = path.join(tempRoot, "reply-queue.json");
const contactsPath = path.join(tempRoot, "contacts.json");

const env = {
  ...process.env,
  OPENCLAW_REPLY_QUEUE: queuePath,
  OPENCLAW_CONTACTS_MAP: contactsPath,
};

function resetStateFiles() {
  try {
    fs.unlinkSync(queuePath);
  } catch {}
  try {
    fs.unlinkSync(contactsPath);
  } catch {}
}

function runNode(scriptPath, args = [], opts = {}) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env,
    input: opts.input,
  });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
  };
}

function runNodeAsync(scriptPath, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      resolve({ status: 1, stdout: stdout.trim(), stderr: `${stderr}\n${String(err)}`.trim() });
    });

    child.on("close", (code) => {
      resolve({ status: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

function parseJson(text) {
  return JSON.parse(text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("queue add/list/digest", () => {
  resetStateFiles();

  const addA = runNode(replyQueueScript, ["add-json"], {
    input: JSON.stringify({
      channel: "whatsapp",
      from: "+15550001111",
      text: "Need price and ETA",
      drafts: ["Sending details now.", "Let me confirm ETA and revert."],
    }),
  });
  assert(addA.status === 0, `add-json A failed: ${addA.stderr || addA.stdout}`);
  const addAJson = parseJson(addA.stdout);
  assert(addAJson.ok === true, "add-json A did not return ok=true");

  const addB = runNode(replyQueueScript, ["add-json"], {
    input: JSON.stringify({
      channel: "whatsapp",
      from: "+15550002222",
      text: "Can we talk tomorrow morning?",
      drafts: ["Yes, tomorrow morning works.", "Sure, what time suits you?"],
    }),
  });
  assert(addB.status === 0, `add-json B failed: ${addB.stderr || addB.stdout}`);

  const list = runNode(replyQueueScript, ["list", "--json"]);
  assert(list.status === 0, `list failed: ${list.stderr || list.stdout}`);
  const listJson = parseJson(list.stdout);
  assert(listJson.ok === true, "list did not return ok=true");
  assert(listJson.pending === 2, `expected 2 pending, got ${listJson.pending}`);
  assert(Array.isArray(listJson.items) && listJson.items.length === 2, "list items length mismatch");

  const digest = runNode(replyQueueScript, ["digest", "--limit", "1"]);
  assert(digest.status === 0, `digest failed: ${digest.stderr || digest.stdout}`);
  assert(digest.stdout.includes("BATCH REPLY DIGEST (1 pending)"), "digest header missing");
  assert(digest.stdout.includes("1)"), "digest item index missing");
});

test("contacts upsert/resolve supports alias+normalized lookup", () => {
  resetStateFiles();

  const upsert = runNode(contactsScript, [
    "upsert",
    "--name",
    "Alice Cooper",
    "--target",
    "+15551234567",
    "--alias",
    "Ali",
    "--alias",
    "A-l.i_ce",
    "--json",
  ]);
  assert(upsert.status === 0, `upsert failed: ${upsert.stderr || upsert.stdout}`);
  const upsertJson = parseJson(upsert.stdout);
  assert(upsertJson.ok === true, "upsert did not return ok=true");
  assert(upsertJson.aliases.length === 2, "expected two aliases");

  const resolveNorm = runNode(contactsScript, ["resolve", "--name", "ALICE-COOPER", "--json"]);
  assert(resolveNorm.status === 0, `normalized resolve failed: ${resolveNorm.stderr || resolveNorm.stdout}`);
  const resolveNormJson = parseJson(resolveNorm.stdout);
  assert(resolveNormJson.target === "+15551234567", "normalized resolve target mismatch");

  const resolveAliasNorm = runNode(contactsScript, ["resolve", "--name", "a li ce", "--json"]);
  assert(
    resolveAliasNorm.status === 0,
    `alias normalized resolve failed: ${resolveAliasNorm.stderr || resolveAliasNorm.stdout}`,
  );
  const resolveAliasNormJson = parseJson(resolveAliasNorm.stdout);
  assert(resolveAliasNormJson.target === "+15551234567", "alias normalized resolve target mismatch");

  const textResolve = runNode(contactsScript, ["text", "Ali", "--json"]);
  assert(textResolve.status === 0, `text resolve failed: ${textResolve.stderr || textResolve.stdout}`);
  const textJson = parseJson(textResolve.stdout);
  assert(textJson.ok === true && textJson.action === "text", "text command did not resolve alias");

  const missing = runNode(contactsScript, ["text", "Unknown", "--json"]);
  assert(missing.status === 1, `expected text missing status 1, got ${missing.status}`);
  const missingJson = parseJson(missing.stdout);
  assert(missingJson.error === "contact_not_found", "missing text error mismatch");
  assert(
    String(missingJson.suggest || "").includes("contacts-map.mjs upsert"),
    "missing resolve suggest command missing",
  );
});

test("approval command parsing in dry-run mode", () => {
  resetStateFiles();

  const seededQueue = {
    version: 1,
    updatedAt: "2026-02-06T00:00:00.000Z",
    items: [
      {
        id: "item-1",
        status: "pending",
        channel: "whatsapp",
        from: "+15550001111",
        thread: "whatsapp:+15550001111",
        text: "Message one",
        preview: "Message one",
        drafts: ["Draft one"],
        priority: "normal",
        createdAt: "2026-02-06T00:00:01.000Z",
        lastSeenAt: "2026-02-06T00:00:01.000Z",
        dedupeKey: "k1",
        sourceMessageId: null,
      },
      {
        id: "item-2",
        status: "pending",
        channel: "whatsapp",
        from: "+15550002222",
        thread: "whatsapp:+15550002222",
        text: "Message two",
        preview: "Message two",
        drafts: ["Draft two"],
        priority: "normal",
        createdAt: "2026-02-06T00:00:02.000Z",
        lastSeenAt: "2026-02-06T00:00:02.000Z",
        dedupeKey: "k2",
        sourceMessageId: null,
      },
    ],
  };
  fs.writeFileSync(queuePath, JSON.stringify(seededQueue, null, 2) + "\n");

  const dryRunSendRewrite = runNode(dispatchScript, [
    "--command",
    "send 1 and rewrite 2: Updated draft",
    "--dry-run",
  ]);
  assert(
    dryRunSendRewrite.status === 0,
    `dispatch dry-run send/rewrite failed: ${dryRunSendRewrite.stderr || dryRunSendRewrite.stdout}`,
  );
  const dryRunJson = parseJson(dryRunSendRewrite.stdout);
  assert(dryRunJson.ok === true, "dispatch dry-run should be ok=true");
  assert(dryRunJson.dryRun === true, "dispatch dryRun flag missing");
  assert(dryRunJson.results.length === 2, "dispatch result count mismatch");
  assert(dryRunJson.results[0].type === "send", "expected first action send");
  assert(dryRunJson.results[1].type === "rewrite", "expected second action rewrite");

  const dryRunSkipSend = runNode(dispatchScript, [
    "--command",
    "skip 1 and send 2",
    "--dry-run",
  ]);
  assert(
    dryRunSkipSend.status === 0,
    `dispatch dry-run skip/send failed: ${dryRunSkipSend.stderr || dryRunSkipSend.stdout}`,
  );
  const skipSendJson = parseJson(dryRunSkipSend.stdout);
  assert(skipSendJson.ok === true, "dispatch skip/send dry-run should be ok=true");
  assert(skipSendJson.results.length === 2, "skip/send result count mismatch");
  assert(skipSendJson.results[0].type === "skip", "expected first action skip");
  assert(skipSendJson.results[1].type === "send", "expected second action send");

  const queueAfter = parseJson(fs.readFileSync(queuePath, "utf8"));
  const pendingAfter = queueAfter.items.filter((item) => item.status === "pending").length;
  assert(pendingAfter === 2, "dry-run should not mutate queue statuses");
});

test("contacts concurrent upserts are atomic", async () => {
  resetStateFiles();

  const workers = [];
  for (let i = 1; i <= 12; i += 1) {
    workers.push(
      runNodeAsync(contactsScript, [
        "upsert",
        "--name",
        `User ${i}`,
        "--target",
        `+1555${String(i).padStart(7, "0")}`,
        "--alias",
        `u-${i}`,
        "--json",
      ]),
    );
  }

  const results = await Promise.all(workers);
  const failures = results.filter((r) => r.status !== 0);
  assert(failures.length === 0, `concurrent contact upsert failures: ${JSON.stringify(failures)}`);

  const list = runNode(contactsScript, ["list", "--json"]);
  assert(list.status === 0, `contacts list failed: ${list.stderr || list.stdout}`);
  const listJson = parseJson(list.stdout);
  assert(listJson.count === 12, `expected 12 contacts, got ${listJson.count}`);

  const resolveAlias = runNode(contactsScript, ["resolve", "--name", "u 7", "--json"]);
  assert(resolveAlias.status === 0, `alias resolve failed after concurrent writes: ${resolveAlias.stderr}`);
  const resolveAliasJson = parseJson(resolveAlias.stdout);
  assert(resolveAliasJson.name === "User 7", "alias should resolve to User 7");
});

test("queue concurrent adds are atomic", async () => {
  resetStateFiles();

  const workers = [];
  for (let i = 1; i <= 20; i += 1) {
    workers.push(
      runNodeAsync(replyQueueScript, ["add-json"], {
        input: JSON.stringify({
          channel: "whatsapp",
          from: `+1556${String(i).padStart(7, "0")}`,
          text: `Concurrent message ${i}`,
          drafts: [`Draft ${i}`, `Draft alt ${i}`],
        }),
      }),
    );
  }

  const results = await Promise.all(workers);
  const failures = results.filter((r) => r.status !== 0);
  assert(failures.length === 0, `concurrent queue add failures: ${JSON.stringify(failures)}`);

  const list = runNode(replyQueueScript, ["list", "--json"]);
  assert(list.status === 0, `queue list failed: ${list.stderr || list.stdout}`);
  const listJson = parseJson(list.stdout);
  assert(listJson.pending === 20, `expected 20 pending, got ${listJson.pending}`);

  const rawQueue = fs.readFileSync(queuePath, "utf8");
  const parsedQueue = JSON.parse(rawQueue);
  assert(Array.isArray(parsedQueue.items), "queue file is invalid JSON after concurrent writes");
});

let passed = 0;
let failed = 0;

for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`PASS ${t.name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${t.name}`);
    console.log(String(err instanceof Error ? err.message : err));
  }
}

console.log(`SUMMARY ${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
