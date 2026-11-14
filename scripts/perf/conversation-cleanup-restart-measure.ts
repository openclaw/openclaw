/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/conversation-cleanup-restart-measure.ts \
 *   --state-dir /absolute/fresh/synthetic-state [--owner-dir /absolute/baseline-overlay]
 *   [--samples 5] [--sessions 5000] [--allocations] [--profile /absolute/profile.cpuprofile]
 * Run separate A/A controls, then at least five interleaved baseline/candidate processes.
 * --owner-dir selects the main-isolate owner modules at their repository-relative
 * paths; unchanged database workers use the current checkout in both variants.
 * Real service, SQLite worker inventory, session reads and durable reopen; the provider
 * is a fixed synthetic failure and never invokes a CLI or network. The measured interval
 * is the first attachment reconciliation after service/store reconstruction. Setup,
 * admission and teardown are excluded. Allocation sampling covers the main isolate,
 * including collected objects; process CPU includes workers. This is owner-scope proof,
 * not a Gateway RPC, 35 GiB transcript database, workspace traversal or btrfs benchmark.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { hostname, loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type { OpenClawConfig } from "../../src/config/types.js";
import type { WorkerProvider } from "../../src/plugins/types.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "owner-dir": { type: "string" },
    samples: { type: "string", default: "5" },
    sessions: { type: "string", default: "5000" },
    allocations: { type: "boolean", default: false },
    profile: { type: "string" },
  },
});
assert(values["state-dir"] && path.isAbsolute(values["state-dir"]));
assert(global.gc, "Run with --expose-gc");
const samples = Number(values.samples);
const sessions = Number(values.sessions);
assert(Number.isSafeInteger(samples) && samples > 0);
assert(Number.isSafeInteger(sessions) && sessions >= 2);
const stateDir = values["state-dir"];
await mkdir(stateDir, { mode: 0o700 });
const ownerPath = "src/gateway/worker-environments/session-attachment-service.ts";
const ownerSource = values["owner-dir"]
  ? path.join(path.resolve(values["owner-dir"]), ownerPath)
  : path.resolve(ownerPath);
const ownerSha256 = createHash("sha256")
  .update(await readFile(ownerSource))
  .digest("hex");
const inheritedPath = process.env.PATH;
process.env = {
  PATH: inheritedPath,
  HOME: stateDir,
  OPENCLAW_HOME: stateDir,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  TMPDIR: stateDir,
};
if (values["owner-dir"]) {
  const sources = new Map(
    [
      "session-attachment-service.ts",
      "service.ts",
      "environment-access.ts",
      "environment-errors.ts",
      "provider-owner-lifecycle.ts",
    ].map((file) => [
      new URL(`../../src/gateway/worker-environments/${file}`, import.meta.url).href,
      transformSync(
        readFileSync(
          path.join(values["owner-dir"]!, "src/gateway/worker-environments", file),
          "utf8",
        ),
        { loader: "ts", format: "esm", target: "esnext" },
      ).code,
    ]),
  );
  registerHooks({
    load(url, context, nextLoad) {
      const source = sources.get(url);
      return source === undefined
        ? nextLoad(url, context)
        : { format: "module", source, shortCircuit: true };
    },
  });
}
const state = await import("../../src/state/openclaw-state-db.js");
const agent = await import("../../src/state/openclaw-agent-db.js");
const { createWorkerEnvironmentStore } =
  await import("../../src/gateway/worker-environments/store.js");
const { createWorkerEnvironmentService } =
  await import("../../src/gateway/worker-environments/service.js");
const { createTestGatewayScheduler } =
  await import("../../src/test-utils/gateway-scheduler-clock.js");
const { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } =
  await import("../../src/config/runtime-snapshot.js");
const { seedTeamShapeSessions } = await import("./team-shape-sessions.ts");
const config: OpenClawConfig = {
  cloudWorkers: { profiles: { synthetic: { provider: "synthetic", settings: {} } } },
};
setRuntimeConfigSnapshot(config);
let now = 1_800_000_000_000;
let measuring = false;
let destroyCalls = 0;
let warnings = 0;
let configReads = 0;
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected provider operation in synthetic cleanup fixture");
};
const provider: WorkerProvider = {
  id: "synthetic",
  provision: unexpected,
  resolveAllocation: unexpected,
  inspect: unexpected,
  destroy: async () => {
    if (measuring) {
      destroyCalls++;
    }
    throw new Error("Synthetic provider authentication is required; repair the original account");
  },
};
const profiler = new Session();
let service: ReturnType<typeof createWorkerEnvironmentService> | undefined;
const close = async () => {
  await service?.stop();
  service = undefined;
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
};
const open = async () => {
  const database = state.openOpenClawStateDatabase();
  const store = await createWorkerEnvironmentStore({ database, now: () => now });
  service = createWorkerEnvironmentService({
    store,
    scheduler: createTestGatewayScheduler(),
    getConfig: () => {
      if (measuring) {
        configReads++;
      }
      return config;
    },
    resolveProvider: (id) => (id === provider.id ? provider : undefined),
    prepareInstallation: unexpected,
    bootstrapWorker: unexpected,
    now: () => now,
    logger: {
      warn: () => {
        if (measuring) {
          warnings++;
        }
      },
    },
  });
  return { database, store, owner: service };
};
try {
  const seeded = await seedTeamShapeSessions({
    stateDir,
    sessions,
    retainedRuns: 0,
    seed: 2385,
    now,
    transcriptBytes: 0,
  });
  const agentDatabasePath = agent.openOpenClawAgentDatabase({ agentId: "main" }).path;
  const initial = await open();
  for (let index = 0; index < 2; index++) {
    const identity = seeded.sessions[index]!;
    const environmentId = `synthetic-environment-${index}`;
    await initial.store.createSessionAttachmentIntent(
      {
        ...identity,
        agentId: "main",
        sessionLifecycleRevision: `team-shape-${index}`,
        environmentId,
        providerId: "synthetic",
        profileId: "synthetic",
        provisionOperationId: `synthetic-operation-${index}`,
        profileSnapshot: { settings: {} },
      },
      () => {},
    );
    await initial.store.transition({ environmentId, from: "requested", to: "provisioning" });
    await initial.store.transition({
      environmentId,
      from: "provisioning",
      to: "draining",
      patch: { leaseId: `synthetic-lease-${index}` },
    });
    await assert.rejects(
      initial.owner.destroySessionAttachment({ sessionId: identity.sessionId }, () => {}),
      /Synthetic provider authentication/,
    );
  }
  now += 3_600_000;
  await initial.owner.reconcileSessionAttachments();
  await close();
  const agentDatabaseBytes = (await stat(agentDatabasePath)).size;
  profiler.connect();
  const results = [];
  for (let sample = 0; sample < samples; sample++) {
    const { store, owner } = await open();
    global.gc();
    destroyCalls = warnings = configReads = 0;
    if (values.allocations) {
      await profiler.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    if (values.profile) {
      await profiler.post("Profiler.enable");
      await profiler.post("Profiler.start");
    }
    const load = loadavg();
    const cpu = process.cpuUsage();
    const start = performance.now();
    measuring = true;
    await owner.reconcileSessionAttachments();
    measuring = false;
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const allocatedBytes = values.allocations
      ? (await profiler.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, entry) => sum + entry.size,
          0,
        )
      : undefined;
    if (values.profile) {
      const { profile } = await profiler.post("Profiler.stop");
      await writeFile(`${values.profile}.${sample}`, JSON.stringify(profile));
    }
    assert.equal(store.list().length, 2);
    assert(store.list().every((record) => record.state === "destroying" && record.leaseId));
    results.push({
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes,
      destroyCalls,
      warnings,
      configReads,
      load,
    });
    await close();
  }
  console.log(
    JSON.stringify({
      ownerSha256,
      host: hostname(),
      platform: process.platform,
      node: process.version,
      sessions,
      agentDatabaseBytes,
      cleanupRows: 2,
      workspaceFiles: 0,
      allocationSampling: values.allocations,
      samples: results,
    }),
  );
} finally {
  measuring = false;
  profiler.disconnect();
  await close();
  clearRuntimeConfigSnapshot();
  await rm(stateDir, { recursive: true });
}
