import { createServer, request as httpRequest } from "node:http";

const PORT = 18799;
const BASE = `http://localhost:${PORT}`;
let passed = 0;

function rawFetch(url, method, headers, body, optsStripUA) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const hdrs = { ...headers };
    // Strip UA only when explicitly requested (test 1)
    if (optsStripUA) {
      delete hdrs["user-agent"];
      delete hdrs["User-Agent"];
    }
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: hdrs,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const server = createServer((req, res) => {
  const ua = req.headers["user-agent"];
  console.log(`  → ${req.url}  UA: ${ua ?? "(missing)"}`);
  if (!ua) {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "1305", message: "rate limited" } }));
  } else if (ua.includes("openclaw")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "length" }] }));
  } else {
    // Per issue #98100 live proof: curl/8.0 also returns 200 from z.ai edge.
    // Only reject requests with no User-Agent at all.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "length" }] }));
  }
});

server.listen(PORT, () => {
  void (async () => {
    try {
      const payload = JSON.stringify({
        model: "test",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
      const baseHeaders = { authorization: "Bearer test", "content-type": "application/json" };

      console.log("\n1. No User-Agent → 429 (matches z.ai edge behavior):");
      const r1 = await rawFetch(`${BASE}/chat/completions`, "POST", baseHeaders, payload, true);
      console.log(`   Status: ${r1.status}`);
      if (r1.status === 429) {
        passed++;
        console.log("   ✓");
      }

      console.log("\n2. openclaw User-Agent → 200 (matching the PR fix):");
      const r2 = await rawFetch(
        `${BASE}/chat/completions`,
        "POST",
        { ...baseHeaders, "user-agent": "openclaw/demo" },
        payload,
        false,
      );
      console.log(`   Status: ${r2.status}`);
      if (r2.status === 200) {
        passed++;
        console.log("   ✓");
      }

      console.log(
        "\n3. Non-openclaw User-Agent (curl/8.0) → 200 (matches z.ai edge behavior per issue #98100):",
      );
      const r3 = await rawFetch(
        `${BASE}/chat/completions`,
        "POST",
        { ...baseHeaders, "user-agent": "curl/8.0" },
        payload,
        false,
      );
      console.log(`   Status: ${r3.status}`);
      if (r3.status === 200) {
        passed++;
        console.log("   ✓");
      }

      if (passed === 3) {
        console.log(
          `\n✓ ${passed}/3 passed — openclaw User-Agent probe header fixes the 429 (curl/8.0 also accepted, matching real z.ai edge).`,
        );
      } else {
        console.error(`\n✗ ${passed}/3 passed — unexpected results.`);
        process.exitCode = 1;
      }
    } finally {
      server.close();
    }
  })();
});
