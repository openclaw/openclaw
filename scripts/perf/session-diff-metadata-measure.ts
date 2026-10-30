/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-diff-metadata-measure.ts
 *   --mode latency|timing|allocation [--iterations 3200] [--clients 64]
 * Add --method files --viewer shared (or solo) for sessions.files.list. That
 * workload keeps the actual handler, metadata retention and workspace authority;
 * it replaces loadSessionFiles (transcript/repository/file I/O) with an empty
 * file inventory. Storage replies use the production snapshot decoder with a
 * 500-file baseline and 64 KiB report. Accept identical replies, one metadata
 * read/request, no unused full snapshots, and lower CPU/allocation. Files latency
 * reports the same injected storage wait without the diff polling contract.
 * --workspace <synthetic-checkout> runs the actual file listing and Git-root
 * detection; only touched-transcript reads are stubbed alongside metadata. Use
 * --iterations 200 --clients 1; compare the printed response hashes across arms.
 * This is a local checkout, without managed-workspace checkpoint settlement.
 * Run base/candidate serially in alternating order, at least five samples each.
 * For base, set OPENCLAW_BENCH_BASELINE_DIR to a directory containing the three
 * ownerFiles below at the baseline revision, preserving their relative paths.
 *
 * Default diff mode exercises the actual handler, retained metadata lifetime and workspace
 * policy with 10k synthetic sessions/40 agents. Loader hooks replace ONLY the
 * metadata storage reply and Git result: this is an owner benchmark, not a
 * Gateway/SQLite/Git load test. Latency injects 2.2-second storage waits;
 * timing/allocation use separate passes with an asynchronous immediate reply.
 * Acceptance: 64 pending polls share one metadata read and return computing in
 * about two seconds, then yield the same diff on the next poll 500ms later.
 * Report uncontended --clients 1
 * alongside fanout CPU/allocation; do not hide any cost shifted to warm callers.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import type {
  SessionsDiffResult,
  SessionsFilesListResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  attachSessionEntrySnapshots,
  type SessionEntryProjection,
} from "../../src/config/sessions/session-entry-snapshot-values.js";
import type { InternalSessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayRequestHandlerOptions } from "../../src/gateway/server-methods/types.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3200" },
    clients: { type: "string", default: "64" },
    method: { type: "string", default: "diff" },
    viewer: { type: "string", default: "solo" },
    workspace: { type: "string" },
  },
});
assert(["latency", "timing", "allocation"].includes(values.mode));
assert(["diff", "files"].includes(values.method));
assert(["solo", "shared"].includes(values.viewer));
const filesMode = values.method === "files";
const workspace = values.workspace ? fs.realpathSync(values.workspace) : undefined;
assert(!workspace || filesMode, "--workspace requires --method files");
const method = filesMode ? "sessions.files.list" : "sessions.diff";
const integer = (name: "iterations" | "clients") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = integer("iterations");
const clients = integer("clients");
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
fs.mkdirSync(path.join(sourceRoot, ".local"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(sourceRoot, ".local/diff-metadata-measure-"));
process.env = createGatewayBenchEnv(scratch, path.join(scratch, "openclaw.json"), {
  startupTrace: false,
  caseEnv: { OPENCLAW_STATE_DIR: path.join(scratch, "state") },
});
const ownerFiles = [
  "src/gateway/server-methods/sessions-diff.ts",
  "src/gateway/server-methods/sessions-files.ts",
  "src/gateway/server-methods/session-scoped-read.ts",
];
const loadedOwners = new Set<string>();
const hook = registerHooks({
  load(url, context, nextLoad) {
    const relative = url.startsWith("file:") ? path.relative(sourceRoot, fileURLToPath(url)) : "";
    let source: string;
    if (ownerFiles.includes(relative)) {
      loadedOwners.add(relative);
      source = fs.readFileSync(path.join(baseline ?? sourceRoot, relative), "utf8");
    } else if (relative === "src/gateway/session-utils-store-worker.ts") {
      source = fs
        .readFileSync(fileURLToPath(url), "utf8")
        .replace(
          "export async function loadGatewaySessionEntryReadOnlyInWorker(",
          "async function unmeasuredMetadataRead(",
        );
      source +=
        "\nexport const loadGatewaySessionEntryReadOnlyInWorker = globalThis.__diffMetadataReply;\n";
    } else if (
      filesMode &&
      !workspace &&
      relative === "src/gateway/server-methods/session-files-root.ts"
    ) {
      source = fs
        .readFileSync(fileURLToPath(url), "utf8")
        .replace(
          "export async function loadSessionFiles(",
          "async function unmeasuredSessionFiles(",
        );
      source += "\nexport const loadSessionFiles = async () => ({ files: [] });\n";
    } else if (workspace && relative === "src/gateway/server-methods/session-touched-files.ts") {
      source = fs
        .readFileSync(fileURLToPath(url), "utf8")
        .replace(
          "export async function loadSessionTouchedFiles(",
          "async function unmeasuredTouchedFiles(",
        );
      source += "\nexport const loadSessionTouchedFiles = async () => new Map();\n";
    } else if (relative === "src/sessions/session-diff.ts") {
      source = fs
        .readFileSync(fileURLToPath(url), "utf8")
        .replace(
          "export async function loadCheckoutDiff(",
          "async function unmeasuredCheckoutDiff(",
        );
      source += "\nexport const loadCheckoutDiff = globalThis.__diffGitReply;\n";
    } else {
      return nextLoad(url, context);
    }
    return {
      format: "module",
      source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
      shortCircuit: true,
    };
  },
});
const cfg: OpenClawConfig = {
  agents: {
    defaults: { sandbox: { mode: "off" } },
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `agent-${index}`,
        { workspace: path.join(scratch, `agent-${index}`) },
      ]),
    ),
  },
};
const inventory = Array.from({ length: 10_000 }, (_, index) => {
  const agentId = `agent-${index % 40}`;
  const key = `agent:${agentId}:${index % 5 ? "subagent" : "dashboard"}:session-${index}`;
  return {
    agentId,
    key,
    entry: {
      sessionId: `session-${index}`,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: "synthetic-viewer" },
      spawnedCwd: workspace ?? path.join(scratch, "workspaces", `session-${index}`),
      skillsSnapshot: { prompt: "Synthetic retained instructions", skills: [] },
    } satisfies InternalSessionEntry,
  };
});
const rows = new Map(inventory.map((row) => [row.key, row]));
const snapshotRow = {
  session_diff_baseline_json: JSON.stringify({
    version: 1,
    root: scratch,
    sessionId: "synthetic",
    files: Array.from({ length: 500 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      fingerprint: "f".repeat(64),
    })),
  }),
  system_prompt_report_json: JSON.stringify({ synthetic: "x".repeat(64 * 1024) }),
};
let metadataReads = 0;
let fullSnapshotReads = 0;
let metadataDelayMs = 0;
const diff = (sessionKey: string): SessionsDiffResult => ({
  sessionKey,
  files: [
    {
      path: "fixture.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "-before\n+after\n",
    },
  ],
  additions: 1,
  deletions: 1,
});
Object.assign(globalThis, {
  __diffMetadataReply: async ({
    key,
    projection,
  }: {
    key: string;
    projection?: SessionEntryProjection;
  }) => {
    metadataReads++;
    await (metadataDelayMs ? delay(metadataDelayMs) : Promise.resolve());
    const row = rows.get(key);
    assert(row);
    fullSnapshotReads += Number(projection === "full");
    const entry = filesMode
      ? attachSessionEntrySnapshots({ ...row.entry }, snapshotRow, projection)
      : row.entry;
    return {
      cfg,
      agentId: row.agentId,
      canonicalKey: key,
      storePath: path.join(scratch, "state", "agents", row.agentId, "sessions", "sessions.json"),
      storeKeys: [key],
      store: { [key]: entry },
      entry,
    };
  },
  __diffGitReply: async ({ sessionKey }: { sessionKey: string }) => diff(sessionKey),
});
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(cfg);
const { sessionsDiffHandlers } = await import("../../src/gateway/server-methods/sessions-diff.js");
const { sessionsFilesHandlers } =
  await import("../../src/gateway/server-methods/sessions-files.js");
const { createSubsystemLogger } = await import("../../src/logging/subsystem.js");
const handler = filesMode ? sessionsFilesHandlers[method] : sessionsDiffHandlers[method];
const client: GatewayRequestHandlerOptions["client"] =
  values.viewer === "shared"
    ? {
        connId: "synthetic-shared-viewer",
        internal: { operatorRoleActor: { kind: "operator", profileId: "synthetic-viewer" } },
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          scopes: ["operator.read"],
          client: { id: "test", version: "test", platform: "test", mode: "test" },
        },
      }
    : null;
assert(handler);
assert.deepEqual([...loadedOwners].toSorted(), ownerFiles.toSorted());
const context = {
  getRuntimeConfig: () => cfg,
  logGateway: createSubsystemLogger("bench/session-diff-metadata"),
} as GatewayRequestHandlerOptions["context"];
const requestTimes: number[] = [];
let responseHash: string | undefined;
let measuring = false;
async function request(index: number, poll = true) {
  const requestStarted = performance.now();
  const { key, agentId } = inventory[index % inventory.length]!;
  const params = { sessionKey: key, agentId, ...(!filesMode ? { poll } : {}) };
  let result: SessionsDiffResult | SessionsFilesListResult | undefined;
  await handler!({
    req: { type: "req", id: "synthetic", method, params },
    params,
    client,
    isWebchatConnect: () => false,
    context,
    respond(ok, payload, error) {
      assert(ok, JSON.stringify(error));
      result = payload as SessionsDiffResult | SessionsFilesListResult;
    },
  });
  assert(result);
  if (workspace) {
    assert.equal(result.root, workspace);
    assert.equal(result.files.length, 0);
    assert("browser" in result && result.browser?.entries.length);
    const hash = createHash("sha256")
      .update(JSON.stringify({ ...result, sessionKey: undefined }))
      .digest("hex");
    responseHash ??= hash;
    assert.equal(hash, responseHash);
  } else if (!("computing" in result && result.computing)) {
    assert.deepEqual(result, filesMode ? { sessionKey: key, files: [] } : diff(key));
  }
  if (filesMode && measuring) {
    requestTimes.push(performance.now() - requestStarted);
  }
  return result;
}
async function run(count: number, first = 0) {
  for (let offset = 0; offset < count; offset += clients) {
    await Promise.all(
      Array.from({ length: Math.min(clients, count - offset) }, () => request(first + offset)),
    );
  }
}
try {
  await run(Math.min(iterations, 128), 9800);
  metadataReads = 0;
  fullSnapshotReads = 0;
  globalThis.gc?.();
  const hostLoad = loadavg();
  const memoryBefore = process.memoryUsage();
  const inspector = values.mode === "allocation" ? new Session() : undefined;
  inspector?.connect();
  await inspector?.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  measuring = true;
  let pendingReplies = 0;
  let latencyMs: number[] | undefined;
  if (values.mode === "latency") {
    metadataDelayMs = 2_200;
    latencyMs = await Promise.all(
      Array.from({ length: clients }, async () => {
        const reply = await request(9999);
        pendingReplies += Number("computing" in reply && reply.computing === true);
        return performance.now() - started;
      }),
    );
  } else {
    await run(iterations);
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const allocation = await inspector?.post("HeapProfiler.stopSampling");
  inspector?.disconnect();
  const operations = values.mode === "latency" ? clients : iterations;
  const reads = metadataReads;
  let completedAtMs: number | undefined;
  if (pendingReplies) {
    await delay(500);
    assert.deepEqual(await request(9999), diff(inventory[9999]!.key));
    completedAtMs = performance.now() - started;
  }
  console.log(
    JSON.stringify({
      method,
      viewer: values.viewer,
      ...(workspace ? { workspace, responseHash } : {}),
      mode: values.mode,
      arm: baseline ? "base" : "candidate",
      operations,
      clients,
      metadataReads: reads,
      fullSnapshotReads,
      ...(filesMode
        ? {
            requestCount: requestTimes.length,
            requestP50Ms: requestTimes.toSorted((a, b) => a - b)[
              Math.floor(requestTimes.length * 0.5)
            ],
            requestP95Ms: requestTimes.toSorted((a, b) => a - b)[
              Math.floor(requestTimes.length * 0.95)
            ],
          }
        : {}),
      hostLoad,
      hostLoadAfter: loadavg(),
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      ...(latencyMs
        ? { pendingReplies, completedAtMs, latencyMs: latencyMs.toSorted((a, b) => a - b) }
        : {}),
      ...(allocation
        ? { sampledBytesPerOperation: sumSampledHeapBytes(allocation.profile.head) / operations }
        : {
            cpuUsPerOperation: (cpu.user + cpu.system) / operations,
            wallUsPerOperation: (elapsedMs * 1000) / operations,
          }),
    }),
  );
} finally {
  hook.deregister();
  fs.rmSync(scratch, { recursive: true, force: true });
}
