// Real behavior proof: Thread Ownership plugin bounds the 409 conflict JSON body
// read so a misbehaving forwarder cannot OOM the runtime.
//
// A local HTTP server returns HTTP 409 with a JSON body much larger than the
// 16 KiB bound. The plugin's message_sending handler must fail open
// (return undefined, log a warning) instead of buffering the whole payload.

import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const { default: register } = await import(path.join(repoRoot, "extensions/thread-ownership/index.js"));

const hooks: Record<string, Function> = {};
const logger = { info: console.log, warn: console.log, debug: () => {} };
const api = {
  pluginConfig: {},
  config: {
    agents: {
      list: [{ id: "proof-agent", default: true, identity: { name: "ProofBot" } }],
    },
  },
  runtime: {
    config: {
      current: () => api.config,
    },
  },
  id: "thread-ownership",
  name: "Thread Ownership",
  logger,
  on: (hookName: string, handler: Function) => {
    hooks[hookName] = handler;
  },
};

register.register(api);

const PORT = 0;
const HUGE_SIZE = 8 * 1024 * 1024;
const server = http.createServer((req, res) => {
  res.writeHead(409, { "Content-Type": "application/json" });
  // Stream an oversized JSON body without materializing it all at once.
  res.write('{"owner":"other-agent","padding":"');
  const chunk = "x".repeat(64 * 1024);
  let sent = 0;
  function sendChunk(): void {
    if (sent >= HUGE_SIZE) {
      res.end('"}');
      return;
    }
    res.write(chunk);
    sent += chunk.length;
    setImmediate(sendChunk);
  }
  sendChunk();
});

await new Promise<void>((resolve) => { server.listen(PORT, "127.0.0.1", () => { resolve(); }); });
const address = server.address();
const port = address && typeof address === "object" ? address.port : 0;

process.env.SLACK_FORWARDER_URL = `http://127.0.0.1:${port}`;

console.log("=== Proof: thread-ownership 409 JSON response bound ===\n");
console.log(`Local forwarder listening on port ${port}`);
console.log(`Sending ${HUGE_SIZE} bytes of JSON padding in 409 response...\n`);

const startMem = process.memoryUsage.rss();
const start = performance.now();

const result = await hooks.message_sending(
  { content: "hello", replyToId: "1234.5678", metadata: { channelId: "C123" }, to: "C123" },
  { channelId: "slack", conversationId: "C123" },
);

const duration = performance.now() - start;
const endMem = process.memoryUsage.rss();

server.close();
await new Promise<void>((resolve) => { server.once("close", () => { resolve(); }); });

console.log(`Handler returned: ${JSON.stringify(result)}`);
console.log(`Duration: ${duration.toFixed(1)} ms`);
console.log(`RSS delta: ${((endMem - startMem) / 1024 / 1024).toFixed(1)} MB\n`);

if (result === undefined && duration < 5000 && (endMem - startMem) < 64 * 1024 * 1024) {
  console.log("PASS: oversized 409 body was bounded; plugin failed open without OOM.");
} else {
  console.log("FAIL: plugin did not fail open or consumed too much memory.");
  process.exitCode = 1;
}
