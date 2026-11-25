#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../test/fixtures/mcp-events/callback.mjs";
import { startMcpEventsTestServer } from "../test/fixtures/mcp-events/server.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    state: { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    "control-port": { type: "string" },
    "token-file": { type: "string" },
    "max-ttl-ms": { type: "string" },
    "control-token-file": { type: "string" },
    "loopback-callback-origin": { type: "string" },
    "callback-ca": { type: "string" },
    "tls-key": { type: "string" },
    "tls-cert": { type: "string" },
    url: { type: "string" },
    json: { type: "string" },
    "json-file": { type: "string" },
    help: { type: "boolean" },
  },
});
const command = positionals[0] ?? "serve";
const readToken = (path) => {
  if (!path) {
    throw new Error("Token file is required");
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token) {
    throw new Error("Token file is empty");
  }
  return token;
};
const port = (value) => {
  if (value === undefined) {
    return 0;
  }
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 65535) {
    throw new Error("Invalid TCP port");
  }
  return result;
};
if (values.help) {
  console.log(
    "Usage: node scripts/mcp-events-test-server.mjs serve --state FILE --token-file FILE --control-token-file FILE [--port 0] [--control-port 0]\n" +
      "  Optional finite lease cap: --max-ttl-ms 15000 (default 86400000)\n" +
      "  Optional MCP TLS: --tls-key FILE --tls-cert FILE --host ADDRESS\n" +
      "  Isolated callback TLS: --loopback-callback-origin https://localhost:PORT --callback-ca FILE\n" +
      "  control --url CONTROL_URL --token-file FILE --json-file CONTROL_REQUEST_FILE\n" +
      "  See test/fixtures/mcp-events/README.md.",
  );
} else if (command === "serve") {
  if (Boolean(values["tls-key"]) !== Boolean(values["tls-cert"])) {
    throw new Error("Supply both TLS key and certificate");
  }
  const server = await startMcpEventsTestServer({
    stateFile: values.state,
    token: readToken(values["token-file"]),
    controlToken: readToken(values["control-token-file"]),
    host: values.host,
    port: port(values.port),
    controlPort: port(values["control-port"]),
    maxTtlMs: values["max-ttl-ms"] === undefined ? undefined : Number(values["max-ttl-ms"]),
    loopbackOrigin: values["loopback-callback-origin"],
    ca: values["callback-ca"] ? readFileSync(values["callback-ca"]) : undefined,
    tls: values["tls-key"]
      ? { key: readFileSync(values["tls-key"]), cert: readFileSync(values["tls-cert"]) }
      : undefined,
  });
  console.log(
    JSON.stringify({
      ready: true,
      mcpUrl: server.mcpUrl,
      sseUrl: server.mcpUrl + "-sse",
      controlUrl: server.controlUrl,
      protocolVersion: PROTOCOL_VERSION,
    }),
  );
  const stop = () => {
    void server.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else if (command === "control") {
  if (!values.url) {
    throw new Error("--url is required");
  }
  const url = new URL(values.url);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new Error("Fixture client requires HTTPS except for explicit loopback HTTP");
  }
  const params = JSON.parse(
    values["json-file"] ? readFileSync(values["json-file"], "utf8") : (values.json ?? "{}"),
  );
  const headers = {
    authorization: "Bearer " + readToken(values["token-file"]),
    "content-type": "application/json",
    accept: "application/json",
  };
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(params),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  console.log(await response.text());
  if (!response.ok) {
    process.exitCode = 1;
  }
} else {
  throw new Error("Expected serve or control");
}
