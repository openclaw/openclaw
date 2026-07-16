#!/usr/bin/env node
// Local real-behavior proof for PR #105845.
// Drives the production exec-approval forwarder and approval-reaction runtime
// with an astral-boundary approval id, sends the produced payload across an
// HTTP boundary to a capture server, persists it to disk, then reads it back
// and asserts the slug is UTF-16-safe and encodable.

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createExecApprovalForwarder } from "../src/infra/exec-approval-forwarder.js";
import { buildApprovalReactionPendingContentForRequest } from "../src/plugin-sdk/approval-reaction-runtime.js";
import { normalizeApprovalSlug } from "../src/shared/approval-slug.js";

const ASTRAL_BOUNDARY_ID = "1234567😀890";
const EXPECTED_SLUG = "1234567";
const PROOF_DIR = path.join(os.tmpdir(), `openclaw-proof-105845-${process.pid}`);
const RECEIVED_PATH = path.join(PROOF_DIR, "received.jsonl");

function log(...args) {
  console.log(...args);
}

async function ensureProofDir() {
  await fs.rm(PROOF_DIR, { recursive: true, force: true });
  await fs.mkdir(PROOF_DIR, { recursive: true });
}

function startCaptureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end("method not allowed");
        return;
      }
      void (async () => {
        try {
          const chunks = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString("utf8");
          await fs.appendFile(RECEIVED_PATH, `${body}\n`, "utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, receivedAt: Date.now() }));
        } catch (err) {
          console.error(err);
          res.writeHead(500);
          res.end("internal error");
        }
      })();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
    server.on("error", reject);
  });
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 0) {
        return;
      }
    } catch {
      // file may not exist yet
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`Timeout waiting for ${filePath}`);
}

async function readReceivedPayloads() {
  const raw = await fs.readFile(RECEIVED_PATH, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertSlug(payload, label) {
  const slug = payload?.channelData?.execApproval?.approvalSlug;
  const approvalId = payload?.channelData?.execApproval?.approvalId;
  log(`  ${label} approvalId: ${approvalId}`);
  log(`  ${label} approvalSlug: ${JSON.stringify(slug)}`);
  if (slug !== EXPECTED_SLUG) {
    throw new Error(`Expected slug ${EXPECTED_SLUG}, got ${JSON.stringify(slug)}`);
  }
  if (approvalId !== ASTRAL_BOUNDARY_ID) {
    throw new Error(`Expected approvalId ${ASTRAL_BOUNDARY_ID}, got ${approvalId}`);
  }
  const encoded = encodeURIComponent(slug);
  log(`  ${label} encodeURIComponent(slug): ${encoded}`);
}

async function main() {
  log("=== OpenClaw PR #105845 real-behavior proof ===");

  let server;
  try {
    await ensureProofDir();
    const capture = await startCaptureServer();
    server = capture.server;
    const captureUrl = `http://127.0.0.1:${capture.port}`;

    const deliver = async ({ payloads }) => {
      for (const payload of payloads) {
        const res = await fetch(captureUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          throw new Error(`capture server returned ${res.status}`);
        }
      }
      return {
        status: "sent",
        results: [],
        receipt: { id: `proof-receipt-${Date.now()}`, timestamp: Date.now() },
      };
    };

    const nowMs = Date.now();
    const cfg = {
      approvals: {
        exec: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "discord", to: "proof-105845-channel" }],
        },
      },
    };

    const forwarder = createExecApprovalForwarder({
      getConfig: () => cfg,
      deliver,
      nowMs: () => nowMs,
    });

    const request = {
      id: ASTRAL_BOUNDARY_ID,
      request: {
        command: "echo 'proof-105845'",
        commandArgv: ["echo", "proof-105845"],
        agentId: "proof-agent",
        sessionKey: "agent:proof:105845",
        host: "gateway",
        ask: null,
      },
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
    };

    log(`\napproval id: ${ASTRAL_BOUNDARY_ID}`);
    log(`id UTF-16 code-unit length: ${ASTRAL_BOUNDARY_ID.length}`);
    log(`raw id.slice(0, 8): ${JSON.stringify(ASTRAL_BOUNDARY_ID.slice(0, 8))}`);
    log(`raw encodeURIComponent(id.slice(0, 8)):`);
    try {
      log(`  ${encodeURIComponent(ASTRAL_BOUNDARY_ID.slice(0, 8))}`);
    } catch (err) {
      log(`  THROW: ${err.message}`);
    }
    log(`normalizeApprovalSlug(id): ${JSON.stringify(normalizeApprovalSlug(ASTRAL_BOUNDARY_ID))}`);

    log("\n--- driving exec-approval forwarder (pending) ---");
    const forwarded = await forwarder.handleRequested(request);
    log(`forwarder.handleRequested returned: ${forwarded}`);

    await waitForFile(RECEIVED_PATH);
    const pendingPayloads = await readReceivedPayloads();
    log(
      `capture server received ${pendingPayloads.length} payload(s) across HTTP + disk boundary:`,
    );
    log(RECEIVED_PATH);
    for (const payload of pendingPayloads) {
      assertSlug(payload, "pending");
    }

    log("\n--- driving exec-approval forwarder (resolved) ---");
    const resolved = {
      id: ASTRAL_BOUNDARY_ID,
      decision: "allow-once",
      resolvedBy: "proof-user",
      ts: nowMs + 1000,
      request: request.request,
    };
    await forwarder.handleResolved(resolved);

    const resolvedPayloads = await readReceivedPayloads();
    const resolvedPayload = resolvedPayloads[resolvedPayloads.length - 1];
    assertSlug(resolvedPayload, "resolved");

    log("\n--- driving approval-reaction runtime ---");
    const reactionContent = buildApprovalReactionPendingContentForRequest({ request, nowMs });
    const reactionSlug = reactionContent.reactionPayload?.channelData?.execApproval?.approvalSlug;
    const manualSlug =
      reactionContent.manualFallbackPayload?.channelData?.execApproval?.approvalSlug;
    log(`  reactionPayload slug: ${JSON.stringify(reactionSlug)}`);
    log(`  manualFallbackPayload slug: ${JSON.stringify(manualSlug)}`);
    if (reactionSlug !== EXPECTED_SLUG || manualSlug !== EXPECTED_SLUG) {
      throw new Error("Reaction runtime produced unexpected slug");
    }

    log("\n=== proof passed ===");
  } finally {
    server?.close?.();
    await fs.rm(PROOF_DIR, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
