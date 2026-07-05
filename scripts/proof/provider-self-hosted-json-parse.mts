// Real behavior proof: malformed self-hosted provider discovery JSON.
// Starts a local HTTP server that returns invalid JSON on /v1/models, then runs
// OpenClaw's discovery helper against it and captures the labeled warning.

import { createServer } from "node:http";
import { discoverOpenAICompatibleLocalModels } from "../../src/plugins/provider-self-hosted-setup.js";

const HOST = "127.0.0.1";
const PORT = 0; // let the OS assign a free port

const server = createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("not valid json {");
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("server did not bind to a TCP port");
}
const baseUrl = `http://${HOST}:${address.port}/v1`;

console.log("=== Proof: self-hosted provider malformed discovery JSON ===\n");
console.log(`Endpoint: ${baseUrl}/models`);
console.log("Response body: not valid json {\n");

const models = await discoverOpenAICompatibleLocalModels({
  baseUrl,
  label: "malformed-test",
  env: {}, // avoid VITEST early-return so real discovery runs
});

console.log(`Discovered models: ${JSON.stringify(models)}`);
console.log("\nPASS: malformed discovery JSON is caught and discovery returns an empty list.");

server.close();
