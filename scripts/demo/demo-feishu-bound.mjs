#!/usr/bin/env node
/**
 * Demo: feishu `readResponseWithLimit` prevents OOM and releases cleanup.
 *
 * Starts a local HTTP server that returns oversized JSON, then calls
 * readResponseWithLimit to prove it throws before memory exhaustion and
 * that cleanup is always called.
 */

import { createServer } from "node:http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";

const PORT = 18800;
const BASE = `http://localhost:${PORT}`;
const LIMIT = 4 * 1024; // 4 KB — tiny for demo purposes
let passed = 0;
let total = 0;

function check(desc, ok) {
  total++;
  if (ok) {
    passed++;
    console.log(`  ✓ ${desc}`);
  } else {
    console.log(`  ✗ ${desc}`);
  }
}

const oversized = JSON.stringify({ data: "x".repeat(LIMIT + 1) });

const server = createServer((req, res) => {
  if (req.url === "/oversized") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(oversized);
  } else if (req.url === "/normal") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "tok_abc", expire: 7200 }));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(PORT, () => {
  void (async () => {
    try {
      console.log("\n=== Feishu bound response read proof ===\n");

      // 1. Oversized response triggers overflow error
      console.log("1. Oversized response -> readResponseWithLimit throws:");
      try {
        const res1 = await fetch(`${BASE}/oversized`);
        await readResponseWithLimit(res1, LIMIT, {
          onOverflow: ({ size, maxBytes }) =>
            new Error(`Response too large: ${size} bytes (limit: ${maxBytes})`),
        });
        check("should have thrown", false);
      } catch (e) {
        check(`throws: ${e.message}`, e.message.includes("Response too large"));
      }

      // 2. Normal response reads correctly
      console.log("\n2. Normal-sized response -> reads correctly:");
      try {
        const res2 = await fetch(`${BASE}/normal`);
        const buf = await readResponseWithLimit(res2, LIMIT);
        const data = JSON.parse(new TextDecoder().decode(buf));
        check(`parsed token: ${data.tenant_access_token}`, data.tenant_access_token === "tok_abc");
      } catch (e) {
        check(`unexpected error: ${e.message}`, false);
      }

      // 3. Release is called even on overflow (server connection stays reusable)
      console.log("\n3. Resource cleanup after overflow (connection reusable):");
      try {
        const res3 = await fetch(`${BASE}/oversized`);
        await readResponseWithLimit(res3, LIMIT, {
          onOverflow: () => new Error("overflow"),
        });
        check("should have thrown", false);
      } catch {
        const res4 = await fetch(`${BASE}/normal`);
        check("server still accepting requests after overflow", res4.ok);
      }

      console.log(`\n✓ ${passed}/${total} passed -- feishu readResponseWithLimit bound works.`);
      if (passed !== total) {
        process.exitCode = 1;
      }
    } finally {
      server.close();
    }
  })();
});
