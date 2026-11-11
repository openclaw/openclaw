const fs = require("node:fs");
const readline = require("node:readline");

const mode = process.env.MCP_CUSTODY_MODE;
const record = (method) =>
  fs.appendFileSync("/proof/requests.jsonl", `${JSON.stringify({ method })}\n`);
const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const markReady = (value) => {
  // The directory watcher must never observe a partially written ready marker.
  fs.writeFileSync("/proof/ready.tmp", value);
  fs.renameSync("/proof/ready.tmp", "/proof/ready");
};

// Background work survives stdin EOF, as it can in a real MCP server. Container
// removal must come from the transport's Docker custody, not this fixture.
setInterval(() => {}, 1000);
process.on("SIGTERM", () => record("fixture/sigterm-ignored"));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  record(request.method);
  if (request.id === undefined) {
    return;
  }
  if (request.method === "initialize") {
    if (mode === "timeout") {
      markReady("initialize-withheld");
      return;
    }
    reply(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "docker-custody-fixture", version: "1.0.0" },
    });
  } else if (request.method === "tools/list") {
    // Let the external test inspect the real ID and injected labels before the
    // CLI finishes discovery and immediately closes its transport.
    let released = false;
    const release = () => {
      if (released || !fs.existsSync("/proof/release")) {
        return;
      }
      released = true;
      watcher.close();
      reply(request.id, { tools: [] });
    };
    const watcher = fs.watch("/proof", release);
    markReady("tools/list");
    release();
  } else if (request.method === "ping") {
    reply(request.id, {});
  }
});
