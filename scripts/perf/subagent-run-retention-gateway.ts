/**
 * Cold-restore retention through an isolated built Gateway, with N and 2N settled
 * runs and a fixed 4k-session population. No model calls or live state are used.
 * node --import ./scripts/tsx.mjs scripts/perf/subagent-run-retention-gateway.ts
 *   --entry dist/entry.js --output .local/buf278/base --runs 1000
 * Run the same command against the candidate build with a new output directory.
 * Compare post-GC heap slope and sessions.list identity checksums at each count.
 * Persisted replies contain 32 KiB full results and canonical 4 KiB terminal
 * snapshots; this measures restart residency, not producer-side sliced strings.
 * --restart boots each fixture twice, checks all archived/active session identities,
 * and verifies exact durable completion payloads after both shutdowns, including
 * one suspended undelivered run. This proves addressability and payload survival;
 * active-run resumption needs the detached-recovery integration test separately.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { buildGatewayBenchChildArgs } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

type GatewayResponse = Awaited<ReturnType<ReturnType<typeof createGatewayWsClient>["request"]>>;

const { values } = parseArgs({
  options: {
    entry: { type: "string", default: "dist/entry.js" },
    output: { type: "string" },
    runs: { type: "string", default: "1000" },
    now: { type: "string", default: String(Date.now()) },
    snapshot: { type: "boolean", default: false },
    restart: { type: "boolean", default: false },
  },
});
assert(values.output, "--output must be a new task-owned directory");
const output = path.resolve(values.output);
mkdirSync(output);
const count = parseStrictIntegerOption({
  raw: values.runs,
  label: "--runs",
  min: 1,
  fallback: 1000,
});
const now = parseStrictIntegerOption({
  raw: values.now,
  label: "--now",
  min: 1,
  fallback: Date.now(),
});
const preload = path.join(output, "heap-preload.mjs");
writeFileSync(
  preload,
  `
import { isMainThread } from 'node:worker_threads';
import { getHeapStatistics, writeHeapSnapshot } from 'node:v8';
if (isMainThread) process.on('message', message => {
  if (message?.channel !== 'subagent-retention-heap') return;
  global.gc(); global.gc();
  const heap = getHeapStatistics();
  const memory = process.memoryUsage();
  if (message.snapshot) writeHeapSnapshot(message.snapshot);
  process.send({ channel: message.channel, heap, memory });
});
`,
);
const results = [];
async function durablePayloads(env: NodeJS.ProcessEnv) {
  const previous = process.env;
  try {
    process.env = { ...env };
    const [reader, context, state] = await Promise.all([
      import("../../src/agents/subagents/registry/subagent-registry.store.read.ts"),
      import("../../src/state/openclaw-state-worker-context.ts"),
      import("../../src/state/openclaw-state-db.ts"),
    ]);
    try {
      const rows = await reader.readAllSubagentRunsInWorker(
        context.captureOpenClawStateWorkerContext(),
      );
      const digest = createHash("sha256");
      let undelivered = 0;
      for (const entry of [...rows.values()].toSorted((a, b) => a.runId.localeCompare(b.runId))) {
        if (entry.delivery?.status === "suspended") {
          undelivered++;
          assert.equal(entry.completion?.resultText?.length, 32_768);
          assert.equal(entry.completion?.terminalReply?.disposition, "visible");
        }
        digest.update(
          stableStringify([
            entry.runId,
            entry.completion,
            entry.delivery?.status,
            entry.delivery?.payload?.terminalReply,
          ]),
        );
      }
      return { runs: rows.size, undelivered, sha256: digest.digest("hex") };
    } finally {
      await state.closeOpenClawStateDatabaseAsync();
    }
  } finally {
    process.env = previous;
  }
}
async function freePort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    assert(address && typeof address !== "string");
    await new Promise<void>((resolve, reject) => {
      reservation.close((error) => (error ? reject(error) : resolve()));
    });
    if (address.port >= 40000) {
      return address.port;
    }
  }
  throw new Error("No free loopback port >=40000 found");
}
for (const runs of [count, count * 2]) {
  const port = await freePort();
  const root = path.join(output, `runs-${runs}`);
  const { env } = await generateTeamShapeFixture(
    parseTeamShapeOptions([
      "--state-dir",
      root,
      "--port",
      String(port),
      "--now",
      String(now),
      "--sessions",
      String(Math.max(4000, count * 3)),
      "--runs",
      String(runs),
      "--settled-runs",
      "--approvals",
      "0",
      "--cron",
      "0",
      "--projects",
      "0",
      "--transcript-mib",
      "1",
    ]),
  );
  const priorEnv = process.env;
  try {
    process.env = { ...env };
    const [state, sql, codec, kernel, reply] = await Promise.all([
      import("../../src/state/openclaw-state-db.ts"),
      import("../../src/infra/kysely-sync.ts"),
      import("../../src/agents/subagents/registry/subagent-registry.store.codec.ts"),
      import("../../src/agents/subagents/registry/subagent-registry.store.kernel.ts"),
      import("../../src/agents/agent-run-terminal-reply.ts"),
    ]);
    try {
      state.runOpenClawStateWriteTransaction((database) => {
        const rows = sql.executeSqliteQuerySync(
          database.db,
          sql
            .getNodeSqliteKysely<
              Pick<import("../../src/state/openclaw-state-db.generated.ts").DB, "subagent_runs">
            >(database.db)
            .selectFrom("subagent_runs")
            .selectAll(),
        ).rows;
        assert.equal(rows.length, runs);
        kernel.writeSubagentRunValuesInDatabase(
          database,
          rows.map((row) => {
            const entry = codec.rowToSubagentRunRecord(row);
            assert(entry);
            const text = Buffer.from(
              `${entry.runId}: synthetic reply. `.repeat(1500).slice(0, 32768),
            ).toString();
            return codec.bindSubagentRunRecord({
              ...entry,
              ...(values.restart && entry.runId === "team-shape-run-0"
                ? {
                    delivery: {
                      status: "suspended" as const,
                      suspendedAt: now,
                      suspendedReason: "expiry" as const,
                    },
                  }
                : {}),
              completion: {
                ...entry.completion,
                required: true,
                resultText: text,
                terminalReply: reply.prepareAgentRunTerminalReply({ rawText: text }).terminalReply,
              },
            });
          }),
          [],
        );
      });
    } finally {
      await state.closeOpenClawStateDatabaseAsync();
    }
  } finally {
    process.env = priorEnv;
  }
  const expectedPayloads = values.restart ? await durablePayloads(env) : undefined;
  if (expectedPayloads) {
    assert.equal(expectedPayloads.runs, runs);
    assert.equal(expectedPayloads.undelivered, 1);
  }
  let firstKeys: string[] | undefined;
  for (let boot = 0; boot < (values.restart ? 2 : 1); boot++) {
    const log = createWriteStream(path.join(root, `probe-gateway${boot ? "-restart" : ""}.log`));
    const gateway = spawn(
      process.execPath,
      buildGatewayBenchChildArgs(path.resolve(values.entry), port, [
        "--expose-gc",
        "--import",
        preload,
      ]),
      { env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    gateway.stdout?.pipe(log);
    gateway.stderr?.pipe(log);
    let client: ReturnType<typeof createGatewayWsClient> | undefined;
    try {
      const deadline = Date.now() + 180_000;
      while (
        !(await fetch(`http://127.0.0.1:${port}/readyz`).then(
          (r) => r.ok,
          () => false,
        ))
      ) {
        assert(
          gateway.exitCode === null && gateway.signalCode === null,
          `Gateway exited; see ${root}`,
        );
        assert(Date.now() < deadline, `Gateway readiness timed out; see ${root}`);
        await delay(250);
      }
      client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
      await client.waitOpen();
      const connected = await client.request(
        "connect",
        {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "gateway-client",
            displayName: "synthetic-retention",
            version: "1.0.0",
            platform: process.platform,
            mode: "backend",
          },
          role: "operator",
          scopes: ["operator.read", "operator.admin"],
          caps: [],
        },
        60_000,
      );
      assert(connected.ok, JSON.stringify(connected.error));
      let keys: string[] = [];
      for (let sample = 0; sample < 3; sample++) {
        const listed: GatewayResponse = await client.request(
          "sessions.list",
          {
            limit: Math.max(4000, count * 3),
            includeGlobal: true,
            includeUnknown: true,
            includeDerivedTitles: false,
            includeLastMessage: false,
            ...(values.restart ? { archived: "all" } : {}),
          },
          60_000,
        );
        assert(listed.ok, JSON.stringify(listed.error));
        const payload = listed.payload as { sessions: Array<{ key: string }> };
        keys = payload.sessions.map((row) => row.key).toSorted();
      }
      if (values.restart) {
        assert.equal(keys.length, Math.max(4000, count * 3));
        if (firstKeys) {
          assert.deepEqual(keys, firstKeys, "Restart lost or replaced a seeded session");
        } else {
          firstKeys = keys;
        }
      }
      const resources = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            gateway.off("message", receive);
            reject(new Error("Heap sample timed out"));
          },
          values.snapshot ? 120_000 : 30_000,
        );
        const receive = (message: unknown) => {
          if (
            typeof message !== "object" ||
            message === null ||
            !("channel" in message) ||
            message.channel !== "subagent-retention-heap"
          ) {
            return;
          }
          clearTimeout(timer);
          gateway.off("message", receive);
          resolve(message);
        };
        gateway.on("message", receive);
        gateway.send({
          channel: "subagent-retention-heap",
          ...(values.snapshot ? { snapshot: path.join(root, "gateway.heapsnapshot") } : {}),
        });
      });
      const result = {
        runs,
        now,
        ...(values.restart ? { boot } : {}),
        listed: keys.length,
        keysSha256: createHash("sha256").update(JSON.stringify(keys)).digest("hex"),
        resources,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      client?.close();
      await stopChild(gateway, { teardownGraceMs: 10_000 });
      log.end();
    }
    if (expectedPayloads) {
      const actual = await durablePayloads(env);
      assert.deepEqual(
        actual,
        expectedPayloads,
        "Gateway changed durable completed or undelivered payloads",
      );
      console.log(
        JSON.stringify({ runs, boot, restartAddressability: true, durablePayloads: actual }),
      );
    }
  }
}
writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
