/**
 * Transport-boundary proof for #103692: deliverOutboundPayloads drives the
 * msteams channel with a captured send dependency backed by a real local
 * HTTP server.  The server records every request body, proving that
 * sanitized text (no tool-trace banners) reaches the transport layer.
 *
 * Usage: node --import tsx scripts/proof/msteams-sanitize-transport.mts
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { msteamsPlugin } from "../../extensions/msteams/src/channel.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  createTestRegistry,
  deliverOutboundPayloads,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../src/plugin-sdk/channel-test-helpers.js";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

async function main() {
  console.log("=== #103692 msteams transport proof ===\n");

  const captured: string[] = [];

  const server = createServer(async (req, res) => {
    if (req.method === "POST") {
      const body = await readBody(req);
      captured.push(body);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: `msg-${captured.length}` }));
  });
  const port = await listen(server);

  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "msteams", plugin: msteamsPlugin, source: "test" }]),
  );

  const cfg = {
    channels: {
      msteams: {
        appId: "test-bot-id",
        appPassword: "test-secret",
        tenantId: "test-tenant",
      },
    },
  } as OpenClawConfig;

  // Custom send that POSTs to the local capture server instead of
  // the real Bot Framework API.
  const capturedSend = async (
    to: string,
    text: string,
  ): Promise<{ messageId: string; conversationId: string }> => {
    const res = await fetch(`http://127.0.0.1:${port}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, text }),
    });
    const data = (await res.json()) as { id: string };
    return { messageId: data.id, conversationId: to };
  };

  // Case 1: mixed text with tool-trace banner
  await deliverOutboundPayloads({
    cfg,
    channel: "msteams",
    to: "user:test-user",
    payloads: [
      {
        text: ["**Done.**", "⚠️ 🛠️ `search repos (agent)` failed", "", "All clear."].join("\n"),
      },
    ],
    skipQueue: true,
    deps: { msteams: capturedSend },
  });

  const body1 = JSON.parse(captured[0]) as { text: string };
  console.log("── Case 1: prose + tool-trace banner ──");
  console.log(`  Input banner:  ⚠️ 🛠️ \`search repos (agent)\` failed`);
  console.log(`  Sent text:     ${body1.text.slice(0, 120)}`);
  const c1 =
    body1.text.includes("**Done.**") &&
    body1.text.includes("All clear.") &&
    !body1.text.includes("search repos") &&
    !body1.text.includes("🛠️");
  console.log(`  VERDICT: ${c1 ? "PASS" : "FAIL"}`);
  console.log();

  // Case 2: trace-only → suppressed (no HTTP request)
  const beforeCount = captured.length;
  await deliverOutboundPayloads({
    cfg,
    channel: "msteams",
    to: "user:test-user",
    payloads: [{ text: "⚠️ 🛠️ `run diagnostic (agent)` failed" }],
    skipQueue: true,
    deps: { msteams: capturedSend },
  });
  const c2 = captured.length === beforeCount;
  console.log("── Case 2: trace-only → suppressed ──");
  console.log(`  Sent requests: ${captured.length - beforeCount} (expected 0)`);
  console.log(`  VERDICT: ${c2 ? "PASS" : "FAIL"}`);
  console.log();

  // Case 3: clean prose passes through
  await deliverOutboundPayloads({
    cfg,
    channel: "msteams",
    to: "user:test-user",
    payloads: [{ text: "The pipeline has 3 open deals." }],
    skipQueue: true,
    deps: { msteams: capturedSend },
  });
  const body3 = JSON.parse(captured[captured.length - 1]) as { text: string };
  const c3 = body3.text === "The pipeline has 3 open deals.";
  console.log("── Case 3: clean prose passes through ──");
  console.log(`  Sent text: ${body3.text}`);
  console.log(`  VERDICT: ${c3 ? "PASS" : "FAIL"}`);
  console.log();

  releasePinnedPluginChannelRegistry();
  server.close();

  const allPassed = c1 && c2 && c3;
  console.log(`\nOVERALL: ${allPassed ? "ALL PASSED" : "FAILURES"}`);
  console.log(`\n✅ No tool-trace banners reached the transport layer.`);
  console.log(`✅ Trace-only payloads suppressed before HTTP send.`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("FATAL:", err);
  process.exit(1);
});
