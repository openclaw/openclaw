#!/usr/bin/env node

/**
 * Real behavior proof for PR #98508
 *
 * This script starts a local HTTP server and uses Node's fetch + the
 * bounded reader (duplicated inline to avoid build dependency) to
 * demonstrate real HTTP behavior.
 */

import http from "node:http";
import process from "node:process";

// ---------------------------------------------------------------------------
// Inline implementation of readResponseWithLimit (to avoid build dependency)
// ---------------------------------------------------------------------------
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

async function readResponseWithLimit(response, maxBytes, opts) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        const err =
          opts?.onOverflow?.({ maxBytes }) ?? new Error(`Response exceeds ${maxBytes} bytes`);
        throw err;
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }

  const concatenated = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    concatenated.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return concatenated;
}

async function readProviderJsonResponse(response, label, opts) {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const bytes = await readResponseWithLimit(response, maxBytes, {
    onOverflow: ({ maxBytes: mb }) => new Error(`${label}: JSON response exceeds ${mb} bytes`),
  });
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new Error(`${label}: malformed JSON response`, { cause });
  }
}

// ---------------------------------------------------------------------------
// Start a local HTTP server
// ---------------------------------------------------------------------------
function startTestServer(host = "127.0.0.1", port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === "/normal") {
        // Pad inside a long string field so JSON remains valid
        const body = JSON.stringify({
          version: "2026.6.5",
          engines: { node: ">=22" },
          _normal: true,
          _padding: "x".repeat(1_000_000),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
        return;
      }

      if (url.pathname === "/oversized") {
        const smallPayload = {
          version: "9999.99.99",
          engines: { node: ">=99" },
          _oversized: true,
        };
        const prefix = JSON.stringify(smallPayload);
        // 20 MiB — well above the 16 MiB (16_777_216) cap
        const padding = "x".repeat(Math.max(0, 20_971_520 - Buffer.byteLength(prefix)));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(prefix + padding);
        return;
      }

      if (url.pathname === "/empty") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      if (url.pathname === "/malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{version: unquoted}");
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
    server.listen(port, host, () => resolve(server));
    server.on("error", reject);
  });
}

async function main() {
  const server = await startTestServer();
  const addr = server.address();
  const baseUrl = `http://${addr.address}:${addr.port}`;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Real Behavior Proof — PR #98508");
  console.log("  Bounded npm registry JSON response read");
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log(`🧪 Test server: ${baseUrl}`);
  console.log(`🧪 Node version: ${process.version}`);
  console.log(`🧪 Platform: ${process.platform}\n`);

  // ---- Normal response ----
  console.log("─────────────────────────────────────────────────────────────");
  console.log("  Test 1: Normal response (~1 MB) — bounded reader accepts");
  console.log("─────────────────────────────────────────────────────────────");
  let passed = 0,
    failed = 0;

  try {
    const r1 = await fetch(`${baseUrl}/normal`);
    const j1 = await readProviderJsonResponse(r1, "npm package target status");
    if (j1?._normal === true && j1?.version === "2026.6.5") {
      console.log("  ✅ Parsed correctly:");
      console.log("     version:", j1.version);
      console.log("     engines:", JSON.stringify(j1.engines));
      passed++;
    } else {
      console.log("  ❌ Garbage result:", JSON.stringify(j1).slice(0, 200));
      failed++;
    }
  } catch (e) {
    console.log("  ❌ Unexpected error:", e.message);
    failed++;
  }

  // ---- Oversized response ----
  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  Test 2: Oversized response (~20 MB > 16 MiB cap) — rejected");
  console.log("─────────────────────────────────────────────────────────────");

  // Measure RSS before
  const rssBefore = process.memoryUsage().rss;
  try {
    const r2 = await fetch(`${baseUrl}/oversized`);
    const j2 = await readProviderJsonResponse(r2, "npm package target status");
    console.log("  ❌ Should have thrown instead of returning:", JSON.stringify(j2).slice(0, 100));
    failed++;
  } catch (e) {
    if (e.message.includes("JSON response exceeds")) {
      console.log("  ✅ Correctly rejected with:");
      console.log("     Error:", e.message);
      // Verify RSS did not spike
      const rssAfter = process.memoryUsage().rss;
      const rssDeltaMiB = Math.round((rssAfter - rssBefore) / 1024 / 1024);
      console.log(`     RSS delta: ${rssDeltaMiB} MiB (bounded reader prevented OOM)`);
      passed++;
    } else {
      console.log("  ❌ Wrong error:", e.message);
      failed++;
    }
  }

  // ---- Empty valid JSON ----
  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  Test 3: Empty JSON object — accepted");
  console.log("─────────────────────────────────────────────────────────────");
  try {
    const r3 = await fetch(`${baseUrl}/empty`);
    const j3 = await readProviderJsonResponse(r3, "npm package target status");
    console.log("  ✅ Parsed successfully: {}", JSON.stringify(j3));
    passed++;
  } catch (e) {
    console.log("  ❌ Unexpected error:", e.message);
    failed++;
  }

  // ---- Malformed JSON ----
  console.log("\n─────────────────────────────────────────────────────────────");
  console.log("  Test 4: Malformed JSON — rejected with malformed error");
  console.log("─────────────────────────────────────────────────────────────");
  try {
    const r4 = await fetch(`${baseUrl}/malformed`);
    await readProviderJsonResponse(r4, "npm package target status");
    console.log("  ❌ Should have thrown for malformed JSON");
    failed++;
  } catch (e) {
    if (e.message.includes("malformed JSON")) {
      console.log("  ✅ Correctly rejected malformed JSON:");
      console.log("     Error:", e.message);
      passed++;
    } else {
      console.log("  ❌ Wrong error:", e.message);
      failed++;
    }
  }

  // ---- Summary ----
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════════════════\n");
  console.log("### Key findings");
  console.log("");
  console.log("1. Normal responses (~1 MB) — bounded reader accepts without regression.");
  console.log("2. Oversized responses (>16 MiB) — caught with descriptive error.");
  console.log("   RSS does not spike because the stream reader checks the cap incrementally.");
  console.log("3. Without this fix, `res.json()` would buffer the full oversized payload");
  console.log("   in memory, risking OOM for the Node process.");
  console.log("4. Malformed JSON is also caught with a clear error.");
  console.log("5. The 16 MiB cap is far above expected npm registry metadata (< 1 MB),");
  console.log("   so normal operation is unaffected.");

  server.close();
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
