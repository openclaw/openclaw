// Owner microbenchmark, not a whole-Gateway load test. Run separate CPU and allocation passes:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-pr-currency-measure.ts
//   --output .local/currency.json [--allocations] [--base-owner-suffix base]
// --base-owner-suffix compares control-ui-session-pr-{read,source}.<suffix>.ts with current owners.
// Both arms share one prepared fixture; five pairs alternate AB/BA without rebuilding state.
// Fixture setup is excluded: 10k persisted rows, 40 configured agents, 64 retained readers.
// Each arm acquires one physical source, then checks it at every reader's final assertion.
// Preserve every arm, report host load, and interpret allocation-mode timing separately.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { ControlUiSessionPrRead } from "../../src/gateway/control-ui-session-pr-read.js";
import type { GatewayClient } from "../../src/gateway/server-methods/client-types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "4000" },
    warmup: { type: "string", default: "1000" },
    allocations: { type: "boolean", default: false },
    "base-owner-suffix": { type: "string" },
    pairs: { type: "string", default: "5" },
    output: { type: "string" },
  },
});
const integer = (name: "iterations" | "warmup" | "pairs") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const warmup = integer("warmup");
const pairs = integer("pairs");
assert(global.gc, "Run Node with --expose-gc");
assert(!values["base-owner-suffix"] || /^[a-z0-9-]+$/.test(values["base-owner-suffix"]));
const sources = [
  ...(values["base-owner-suffix"]
    ? [{ name: "base", suffix: `.${values["base-owner-suffix"]}` }]
    : []),
  { name: "candidate", suffix: "" },
].map(({ name, suffix }) => {
  const url = new URL(`../../src/gateway/control-ui-session-pr-read${suffix}.ts`, import.meta.url);
  const sourceUrl = new URL(
    `../../src/gateway/control-ui-session-pr-source${suffix}.ts`,
    import.meta.url,
  );
  return {
    name,
    url,
    sha256: createHash("sha256").update(readFileSync(url)).digest("hex"),
    sourceUrl,
    sourceSha256: createHash("sha256").update(readFileSync(sourceUrl)).digest("hex"),
  };
});
const scratch = path.resolve(".local");
mkdirSync(scratch, { recursive: true });
const stateDir = mkdtempSync(path.join(scratch, "pr-currency-"));
const configPath = path.join(stateDir, "openclaw.json");
for (const directory of ["home", "tmp"]) {
  mkdirSync(path.join(stateDir, directory));
}
const sessionCount = 10_000;
const readerCount = 64;
const childrenPerRoot = 4;
const agentIds = ["main", ...Array.from({ length: 39 }, (_, i) => `worker-${i}`)];
const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
  },
  plugins: { enabled: false },
  gateway: {
    roles: {
      default: "reader",
      definitions: {
        reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
      },
    },
  },
};
writeFileSync(configPath, JSON.stringify(cfg));
process.env = {
  ...createGatewayBenchEnv(path.join(stateDir, "home"), configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: stateDir,
  TMPDIR: path.join(stateDir, "tmp"),
};
const [
  { setRuntimeConfigSnapshot },
  { writeSessionEntry },
  { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync },
  { closeOpenClawStateDatabaseAsync },
  { createSessionRowProjection },
  { ensureProfileForEmail },
  { prepareGatewayRecipientProfile },
] = await Promise.all([
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/gateway/session-row-projection.js"),
  import("../../src/state/user-profiles.js"),
  import("../../src/gateway/expected-profile.js"),
]);
const owners = await Promise.all(
  sources.map(async (source) => {
    const {
      createControlUiSessionPrRead,
    }: typeof import("../../src/gateway/control-ui-session-pr-read.js") = await import(
      source.url.href
    );
    const {
      withControlUiSessionPrSource,
    }: typeof import("../../src/gateway/control-ui-session-pr-source.js") = await import(
      source.sourceUrl.href
    );
    return { ...source, createControlUiSessionPrRead, withControlUiSessionPrSource };
  }),
);
const profile = ensureProfileForEmail("currency-reader@example.test");
setRuntimeConfigSnapshot(cfg);
const keyFor = (index: number) => `agent:main:currency-${index}`;
let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
const inspector = new Session();
let inspectorConnected = false;
const gc: { start: number; ms: number }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push({ start: entry.startTime, ms: entry.duration });
  }
});
try {
  runOpenClawAgentWriteTransaction(
    (database) => {
      for (let index = 0; index < sessionCount; index++) {
        const child = index >= readerCount && index < readerCount * (childrenPerRoot + 1);
        const entry: SessionEntry = {
          sessionId: `currency-session-${index}`,
          updatedAt: 1_700_000_000_000 + index,
          spawnedCwd: "/synthetic/currency-workspace",
          createdActor: { type: "human", source: "profile", id: profile.id },
          ...(child ? { parentSessionKey: keyFor((index - readerCount) % readerCount) } : {}),
          ...(index >= readerCount * (childrenPerRoot + 1)
            ? { archivedAt: 1_700_000_000_001 }
            : {}),
        };
        writeSessionEntry(database, keyFor(index), entry);
      }
    },
    { agentId: "main" },
  );
  projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
  await projection.prepareSelection();
  await projection.ensureMaterialized();
  const arms = [];
  for (const owner of owners) {
    const access = new AbortController();
    const reads: ControlUiSessionPrRead[] = [];
    for (let index = 0; index < readerCount; index++) {
      const client: GatewayClient = {
        connId: `currency-reader-${index}`,
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "openclaw-control-ui",
            version: "synthetic",
            platform: "test",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.read"],
        },
        authenticatedUserProfile: {
          profileId: profile.id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
        internal: {
          operatorAccessAuthority: {
            signal: access.signal,
            assertCurrent: () => access.signal.throwIfAborted(),
          },
        },
      };
      prepareGatewayRecipientProfile(client);
      const read = owner.createControlUiSessionPrRead({
        client,
        sessionKey: keyFor(index),
        getRuntimeConfig: () => cfg,
        getSessionRowProjection: () => projection,
        isCurrentClient: () => true,
      });
      assert(read);
      reads.push(read);
    }
    const targets = await Promise.all(reads.map((read) => read()));
    for (const target of targets) {
      assert(target?.assertCurrent);
      assert.equal(target.taskReceipts?.sessions.length, childrenPerRoot + 1);
    }
    const source = targets[0]!.readSource;
    assert(targets.every((target) => target?.readSource.path === source.path));
    const run = (count: number) =>
      owner.withControlUiSessionPrSource(source, async (assertSourceCurrent) => {
        for (let index = 0; index < count; index++) {
          const slot = index % readerCount;
          const target = await reads[slot]!();
          assert.equal(target, targets[slot]);
          assertSourceCurrent();
          target!.assertCurrent!();
        }
      });
    await run(warmup);
    arms.push({ owner, run });
  }
  if (values.allocations) {
    inspector.connect();
    inspectorConnected = true;
  }
  const samples = [];
  for (let pair = 0; pair < pairs; pair++) {
    const order = pair % 2 === 0 ? arms : arms.toReversed();
    for (const arm of order) {
      global.gc();
      await nextTurn();
      gc.length = 0;
      observer.takeRecords();
      observer.observe({ entryTypes: ["gc"] });
      if (values.allocations) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const before = process.memoryUsage();
      const hostLoadBefore = os.loadavg();
      const cpuBefore = process.threadCpuUsage();
      const started = performance.now();
      await arm.run(iterations);
      const ended = performance.now();
      const cpu = process.threadCpuUsage(cpuBefore);
      const after = process.memoryUsage();
      const hostLoadAfter = os.loadavg();
      const sampled = values.allocations
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
      await nextTurn();
      for (const entry of observer.takeRecords()) {
        gc.push({ start: entry.startTime, ms: entry.duration });
      }
      const measuredGc = gc.filter((entry) => entry.start >= started && entry.start < ended);
      const allocationBytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
        node.selfSize + node.children.reduce((total, child) => total + allocationBytes(child), 0);
      const bytes = sampled ? allocationBytes(sampled.head) : undefined;
      samples.push({
        pair: pair + 1,
        arm: arm.owner.name,
        order: order.map(({ owner }) => owner.name),
        allocation:
          bytes === undefined
            ? null
            : { sampledBytes: bytes, bytesPerReadAndAssertion: bytes / iterations },
        cpu: {
          mainThreadMs: (cpu.user + cpu.system) / 1000,
          microsecondsPerReadAndAssertion: (cpu.user + cpu.system) / iterations,
        },
        elapsedMs: ended - started,
        gc: {
          count: measuredGc.length,
          totalMs: measuredGc.reduce((total, entry) => total + entry.ms, 0),
          maxMs: Math.max(0, ...measuredGc.map((entry) => entry.ms)),
        },
        memory: { before, after },
        hostLoad: { before: hostLoadBefore, after: hostLoadAfter },
      });
    }
  }
  for (const source of sources) {
    assert.equal(
      createHash("sha256").update(readFileSync(source.url)).digest("hex"),
      source.sha256,
      "Owner source changed during measurement",
    );
    assert.equal(
      createHash("sha256").update(readFileSync(source.sourceUrl)).digest("hex"),
      source.sourceSha256,
      "Physical source owner changed during measurement",
    );
  }
  const result = {
    scope:
      "real in-process PR reader, physical source and final currency assertions; no transport or whole-Gateway claim",
    node: process.version,
    owners: sources.map(({ name, url, sha256, sourceUrl, sourceSha256 }) => ({
      name,
      path: url.pathname,
      sha256,
      sourcePath: sourceUrl.pathname,
      sourceSha256,
    })),
    workload: {
      sessionCount,
      configuredAgents: agentIds.length,
      readerCount,
      childrenPerRoot,
      iterations,
      warmup,
      pairs,
    },
    allocationMode: values.allocations,
    samples,
  };
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (values.output) {
    writeFileSync(values.output, output);
  }
  process.stdout.write(output);
} finally {
  observer.disconnect();
  if (inspectorConnected) {
    inspector.disconnect();
  }
  projection?.dispose();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  rmSync(stateDir, { recursive: true, force: true });
}
