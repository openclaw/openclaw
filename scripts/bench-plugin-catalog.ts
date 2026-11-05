// Run against two isolated, built Gateways with the same catalog credentials.
// node --import ./scripts/tsx.mjs scripts/bench-plugin-catalog.ts
//   --baseline-url ws://127.0.0.1:19080 --candidate-url ws://127.0.0.1:19081
//   --samples 12 --output /absolute/catalog.json
// This calls live ClawHub through the real Gateway; no responses are intercepted.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import type { PluginsCatalogBrowseResult } from "../packages/gateway-protocol/src/schema/plugins.ts";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import { summarizeNumbers } from "./lib/gateway-bench-runtime.ts";
import { createArgReader, createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const args = createArgReader();
const samples = Number(args.get("--samples") ?? 12);
if (!Number.isInteger(samples) || samples < 5 || samples > 100) {
  throw new Error("--samples must be an integer between 5 and 100");
}
const targets = ["baseline", "candidate"].map((label) => {
  const url = args.get(`--${label}-url`);
  if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error(`--${label}-url must select an isolated loopback Gateway`);
  }
  return { label, client: createGatewayWsClient({ url }) };
});
const rows: Array<{
  label: string;
  phase: "first" | "warm";
  iteration: number;
  ms: number;
  count: number;
  hash: string;
}> = [];
const startedAt = new Date().toISOString();
const hostLoad = loadavg();
try {
  await Promise.all(
    targets.map(async ({ client }) => {
      await client.waitOpen();
      const connected = await client.request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "plugin-catalog-benchmark",
          version: "1.0.0",
          platform: process.platform,
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
      });
      if (!connected.ok) {
        throw new Error(`Gateway connect failed: ${JSON.stringify(connected.error)}`);
      }
    }),
  );
  for (let iteration = 0; iteration <= samples; iteration++) {
    for (const { label, client } of iteration % 2 ? targets.toReversed() : targets) {
      const start = performance.now();
      const result = await client.request(
        "plugins.catalog.browse",
        { intent: "all", category: "channels", pageSize: 100 },
        30_000,
      );
      const ms = performance.now() - start;
      if (!result.ok) {
        throw new Error(`Catalog RPC failed: ${JSON.stringify(result.error)}`);
      }
      const payload = result.payload as PluginsCatalogBrowseResult;
      if (payload.remoteError || !payload.items?.length) {
        throw new Error(payload.remoteError ?? "Empty remote catalog");
      }
      const identities = payload.items.map(({ catalog }) => ({
        packageName: catalog.packageName,
        latestVersion: catalog.latestVersion,
        categories: catalog.categories,
      }));
      const row = {
        label,
        phase: iteration === 0 ? ("first" as const) : ("warm" as const),
        iteration,
        ms,
        count: payload.items.length,
        hash: createHash("sha256").update(JSON.stringify(identities)).digest("hex"),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  const summary = Object.fromEntries(
    targets.map(({ label }) => {
      const values = rows
        .filter((row) => row.label === label && row.phase === "warm")
        .map((row) => row.ms)
        .toSorted((a, b) => a - b);
      return [
        label,
        {
          ...summarizeNumbers(values),
          n: values.length,
          p75: values[Math.ceil(values.length * 0.75) - 1],
        },
      ];
    }),
  );
  const report = { startedAt, finishedAt: new Date().toISOString(), hostLoad, rows, summary };
  const output = args.get("--output");
  if (output) {
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  console.log(JSON.stringify(summary, null, 2));
  if (new Set(rows.map((row) => row.hash)).size !== 1) {
    throw new Error("Catalog identities changed during the comparison; inspect the retained rows");
  }
} finally {
  for (const { client } of targets) {
    client.close();
  }
}
