// Real behavior proof for PR #98731: gateway MCP loopback bounded read uses
// readProviderTextResponse on live HTTP responses outside Vitest.
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pkgRoot = resolve(import.meta.dirname, "..");
const ownerToken = "proof-owner-token-redacted";

const { verifyCliCronMcpLoopbackPreflight } = await import(
  pathToFileURL(`${pkgRoot}/src/gateway/gateway-cli-backend.live-probe-helpers.ts`).href
);
const { readProviderTextResponse } = await import(
  pathToFileURL(`${pkgRoot}/src/agents/provider-http-errors.ts`).href
);
const { clearActiveMcpLoopbackRuntimeByOwnerToken, setActiveMcpLoopbackRuntime } = await import(
  pathToFileURL(`${pkgRoot}/src/gateway/mcp-http.loopback-runtime.ts`).href
);

let passed = 0;
let failed = 0;

function section(title) {
  const rule = "─".repeat(61);
  console.log(`\n${rule}`);
  console.log(`  ${title}`);
  console.log(rule);
}

function pass(label) {
  passed += 1;
  console.log(`  ok: ${label}`);
}

function fail(label, detail = "") {
  failed += 1;
  console.log(`  FAIL: ${label}${detail ? `\n       ${detail}` : ""}`);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof server did not expose a TCP port");
  }
  return address.port;
}

async function closeServer(server) {
  await new Promise((resolveDone) => {
    server.close(resolveDone);
  });
}

function activateLoopbackRuntime(port) {
  setActiveMcpLoopbackRuntime({
    port,
    ownerToken,
    nonOwnerToken: "proof-non-owner-token-redacted",
  });
}

function preflightParams(port, env = {}) {
  return {
    sessionKey: "proof-session-key",
    port: 65535,
    token: "proof-gateway-token-redacted",
    env,
  };
}

console.log("═══════════════════════════════════════════════════════════════");
console.log("  Real Behavior Proof — PR #98731");
console.log("  Gateway MCP loopback bounded response read");
console.log("═══════════════════════════════════════════════════════════════");
console.log(`  Node version: ${process.version}`);
console.log(`  Platform: ${os.platform()} ${os.release()}`);
console.log(`  Repo root: ${pkgRoot}`);

try {
  section("Test 1: Oversized loopback body (256 B > 64 B cap) → rejected");
  const overflowServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("x".repeat(256));
  });
  const overflowPort = await listen(overflowServer);
  activateLoopbackRuntime(overflowPort);
  try {
    await verifyCliCronMcpLoopbackPreflight(
      preflightParams(overflowPort, { OPENCLAW_MCP_LOOPBACK_PROBE_MAX_BODY_BYTES: "64" }),
    );
    fail("verifyCliCronMcpLoopbackPreflight should reject oversized loopback bodies");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "mcp loopback: text response exceeds 64 bytes") {
      pass(`production preflight rejected with shared helper message: ${message}`);
    } else {
      fail("unexpected overflow error message", message);
    }
  } finally {
    clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
    await closeServer(overflowServer);
  }

  section("Test 2: Normal loopback JSON (~180 B) → accepted via readProviderTextResponse");
  const happyServer = createServer((request, response) => {
    void (async () => {
      const body = JSON.parse(await readRequestBody(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id ?? null,
          result:
            body.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "cron",
                      inputSchema: { type: "object", properties: { action: { type: "string" } } },
                    },
                  ],
                }
              : { protocolVersion: "2025-03-26", capabilities: {} },
        }),
      );
    })();
  });
  const happyPort = await listen(happyServer);
  activateLoopbackRuntime(happyPort);
  try {
    const runtimeResponse = await fetch(`http://127.0.0.1:${happyPort}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        "x-session-key": "proof-session-key",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tools-list",
        method: "tools/list",
      }),
    });
    const text = await readProviderTextResponse(runtimeResponse, "mcp loopback", {
      maxBytes: 1024,
    });
    const parsed = JSON.parse(text);
    const toolNames = (parsed.result?.tools ?? []).map((tool) => tool?.name).filter(Boolean);
    if (toolNames.includes("cron")) {
      pass(`bounded read returned valid tools/list JSON (${Buffer.byteLength(text)} bytes)`);
    } else {
      fail("tools/list JSON missing cron tool", JSON.stringify(parsed));
    }
  } catch (error) {
    fail("happy-path bounded read failed", error instanceof Error ? error.message : String(error));
  } finally {
    clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
    await closeServer(happyServer);
  }

  section("Test 3: file:// container path is not used here; HTTP fetch uses shared cancel+throw");
  const streamServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(32, 97);
    response.write(chunk);
    response.write(chunk);
    response.write(chunk);
    response.end(chunk);
  });
  const streamPort = await listen(streamServer);
  try {
    const streamResponse = await fetch(`http://127.0.0.1:${streamPort}/mcp`);
    try {
      await readProviderTextResponse(streamResponse, "mcp loopback", { maxBytes: 64 });
      fail("128-byte streamed body should exceed 64-byte cap");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "mcp loopback: text response exceeds 64 bytes") {
        pass(`streamed overflow rejected with shared helper message: ${message}`);
      } else {
        fail("unexpected streamed overflow message", message);
      }
    }
  } finally {
    await closeServer(streamServer);
  }
} finally {
  clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
}

const resultRule = "═".repeat(63);
console.log(`\n${resultRule}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${resultRule}\n`);

process.exit(failed === 0 ? 0 : 1);
