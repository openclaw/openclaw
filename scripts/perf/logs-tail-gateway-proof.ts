// After pnpm build:runtime: node --import ./scripts/tsx.mjs scripts/perf/logs-tail-gateway-proof.ts <new fixture directory>
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../../packages/gateway-client/src/client.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";

const root = path.resolve(process.argv[2]!);
await fs.mkdir(root);
const file = path.join(root, "synthetic-day.log");
const line =
  JSON.stringify({
    message: "request completed",
    password: "synthetic-password",
    fields: Array.from(
      { length: 100 },
      (_, index) => `https://example.test/api?token=synthetic-${index}-abcdefghijklmnop`,
    ),
  }) + "\n";
const handle = await fs.open(file, "wx");
for (let index = 0; index < Math.ceil(320_000_000 / Buffer.byteLength(line.repeat(100))); index++) {
  await handle.write(line.repeat(100));
}
await handle.close();
const gateway = await createOpenClawTestInstance({
  name: "log-tail-worker-proof",
  config: { logging: { file, level: "silent", consoleLevel: "silent" } },
});
let client: GatewayClient | undefined;
try {
  await gateway.startGateway();
  const connected = Promise.withResolvers<void>();
  client = new GatewayClient({
    url: gateway.url,
    clientName: "gateway-client",
    clientDisplayName: "synthetic-log-tail-proof",
    mode: "backend",
    role: "operator",
    scopes: ["operator.read"],
    token: gateway.gatewayToken,
    deviceIdentity: null,
    onHelloOk: () => connected.resolve(),
    onConnectError: (error) => connected.reject(error),
  });
  client.start();
  await connected.promise;
  let cursor: number | undefined;
  for (let poll = 0; poll < 6; poll++) {
    if (poll > 0) {
      await fs.appendFile(file, line.repeat(Math.floor(250_000 / Buffer.byteLength(line))));
      await delay(2000);
    }
    const started = performance.now();
    let pending = true;
    const healthMs: number[] = [];
    const heartbeat = (async () => {
      for (;;) {
        if (!pending) {
          break;
        }
        const before = performance.now();
        await client!.request("health", {});
        healthMs.push(performance.now() - before);
        await delay(20);
      }
    })();
    let response;
    try {
      response = await client.request<{ lines: string[]; cursor: number; size: number }>(
        "logs.tail",
        { cursor, limit: 500, maxBytes: 250_000 },
      );
    } finally {
      pending = false;
      await heartbeat;
    }
    assert(response.lines.length > 0);
    for (const raw of response.lines) {
      assert.equal(JSON.parse(raw).password, "***");
      assert(!raw.includes("synthetic-password"));
      assert(!raw.includes("abcdefghijklmnop"));
    }
    assert.equal(response.cursor, response.size);
    cursor = response.cursor;
    console.log(
      JSON.stringify({
        poll,
        wallMs: performance.now() - started,
        maxHealthMs: Math.max(...healthMs),
        healthCalls: healthMs.length,
        lines: response.lines.length,
        size: response.size,
      }),
    );
  }
} finally {
  client?.stop();
  await gateway.cleanup();
  await fs.rm(root, { recursive: true });
}
