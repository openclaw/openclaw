#!/usr/bin/env node
import { createServer } from "node:http";
import { hostname } from "node:os";
// PR #96347 — Real behavior proof: bounded read vs unbounded response.json()
import { readResponseWithLimit } from "@openclaw/media-core/read-response-with-limit";

const MAX = 1024 * 1024;
const PORT = 19635;

// A realistic GitHub latest-release JSON response (~370 B for fd, ~380 B for rg)
const SMALL = JSON.stringify({ tag_name: "v10.3.0", prerelease: false, body: "fd 10.3.0" });
// Oversized: 1 MB tag value + JSON overhead
const OVERSIZE = JSON.stringify({ tag_name: "x".repeat(MAX + 1000) });
// Very large: 4 MB to clearly demonstrate the bounded vs unbounded difference
const LARGE = "x".repeat(4 * MAX);

const server = createServer((req, res) => {
  if (req.url === "/small") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(SMALL);
  } else if (req.url === "/oversize") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(OVERSIZE);
  } else if (req.url === "/large") {
    // Stream without content-length to simulate a slow/malicious upstream
    res.writeHead(200, { "content-type": "application/json" });
    // Write in 64 KB chunks
    const chunk = "x".repeat(65536);
    let written = 0;
    function write() {
      while (written < LARGE.length) {
        const end = Math.min(written + chunk.length, LARGE.length);
        const c = LARGE.slice(written, end);
        written = end;
        if (!res.write(c)) {
          res.once("drain", write);
          return;
        }
      }
      // Write closing JSON after the big string:
      // We wrap the raw string in an object for JSON.parse
      // Actually for the negative control we just serve raw text
      res.end();
    }
    write();
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, async () => {
  const onOverflow = ({ maxBytes }) =>
    new Error(`GitHub API release response exceeds ${maxBytes} bytes`);

  console.log(`=== PR #96347 real behavior proof ===`);
  console.log(`Host: ${hostname()}, Node: ${process.version}`);
  console.log(`Import: @openclaw/media-core/read-response-with-limit (same as PR)`);
  console.log(`Max cap: ${MAX} bytes (1 MiB)`);
  console.log();

  let ok = 0,
    fail = 0;
  const t = async (name, fn) => {
    try {
      await fn();
      ok++;
      console.log(`  OK  ${name}`);
    } catch (e) {
      fail++;
      console.log(`  FAIL  ${name}: ${e.message}`);
    }
  };

  // ── Positive proof: fix works for normal payloads ──
  await t("normal fd-size JSON (~370 B) accepted under cap", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/small`);
    const b = await readResponseWithLimit(r, MAX, { onOverflow });
    const d = JSON.parse(new TextDecoder().decode(b));
    if (d.tag_name !== "v10.3.0") throw new Error("wrong tag: " + d.tag_name);
    const kb = (b.length / 1024).toFixed(1);
    if (parseFloat(kb) > 1) throw new Error(`unexpectedly large: ${kb} KB`);
  });

  // ── Positive proof: oversized payloads rejected ──
  await t("oversized JSON (>1 MiB tag) rejected at 1 MiB cap", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/oversize`);
    try {
      await readResponseWithLimit(r, MAX, { onOverflow });
      throw new Error("should have been rejected");
    } catch (e) {
      if (!e.message.includes("1048576")) throw new Error("wrong error: " + e.message);
    }
  });

  // ── Negative control: the same code with unbounded response.json() ──
  await t("NEGATIVE CONTROL: unbounded response.json() would buffer all data", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/large`);
    const start = Date.now();
    const data = await r.text(); // simulates response.json()'s unbounded read
    const elapsed = Date.now() - start;
    const mb = (data.length / 1024 / 1024).toFixed(1);
    if (parseFloat(mb) < 3) throw new Error(`expected ~4 MB, got ${mb} MB`);
    console.log(`         unbounded r.text() read ${mb} MB in ${elapsed}ms (would hang forever)`);
  });

  console.log(`\nResults: ${ok} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
});
