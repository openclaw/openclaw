#!/usr/bin/env node
/**
 * Proof script for PR #93878: verify that memory embeddings route to the
 * configured baseURL instead of the default api.openai.com.
 *
 * Usage: node scripts/verify-baseurl-routing.mjs
 *
 * Starts a minimal HTTP server on localhost:19999 and verifies OpenClaw
 * routes embedding requests to the configured endpoint.
 */
import { createServer } from "node:http";

const PORT = 19999;
const PATH = "/v1/embeddings";

const receivedRequests = [];

const server = createServer((req, res) => {
  const timestamp = new Date().toISOString();
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const entry = {
      timestamp,
      method: req.method,
      url: req.url,
      headers: {
        "content-type": req.headers["content-type"],
        authorization: req.headers["authorization"]
          ? `${req.headers["authorization"].slice(0, 15)}...`
          : "(none)",
      },
      bodyPreview: body.slice(0, 200),
    };
    receivedRequests.push(entry);
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    console.log(`  Authorization: ${entry.headers.authorization}`);
    console.log(`  Body: ${entry.bodyPreview}`);

    // Return a mock embedding response
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { object: "embedding", embedding: Array(128).fill(0.1), index: 0 },
      ],
      model: "mock-embedding",
      usage: { prompt_tokens: 4, total_tokens: 4 },
    }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`=== baseURL routing verification server ===`);
  console.log(`Listening on http://127.0.0.1:${PORT}${PATH}`);
  console.log("");
  console.log("Configure OpenClaw with:");
  console.log(`  models.providers.openai.baseUrl = "http://127.0.0.1:${PORT}/v1"`);
  console.log(`  memorySearch.provider = "openai"`);
  console.log("");
  console.log("Then trigger a memory embedding request.");
  console.log("The request should arrive at THIS server, not api.openai.com.");
  console.log("");
  console.log("Press Ctrl+C to stop.");
  console.log("");
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log(`\nTotal requests received: ${receivedRequests.length}`);
  receivedRequests.forEach((r, i) => {
    console.log(`  [${i + 1}] ${r.timestamp} ${r.method} ${r.url}`);
  });
  if (receivedRequests.length === 0) {
    console.log("  (No requests — trigger an embedding request and re-run)");
  }
  server.close();
  process.exit(0);
});
