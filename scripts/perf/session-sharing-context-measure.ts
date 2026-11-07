/**
 * Shared-session authority through the real retained-context media preparer.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-sharing-context-measure.ts \
 *   --mode timing --samples 5 --turns 20 --warmup 20 --items 50 --profiles 1000 --sessions 5000
 * Repeat with --mode allocation; instrumentation is never timed.
 * For --mode counts, pass Node --no-opt --no-maglev --no-sparkplug before --expose-gc.
 * Optimized/inlined functions otherwise lose precise-coverage calls after warmup.
 * Add --workspace-files 62000 --workspace-file-bytes 18000 for a 1.1 GB directory.
 * Alternate pinned baseline/candidate checkouts; run baseline twice for A/A controls.
 * Acceptance: lower authority CPU/allocation (>=20%), no >20% total regression,
 * unchanged disclosure and revocation. Setup, warmup and teardown are excluded.
 * This is real owner/media composition, not a model or Gateway transport benchmark.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { AgentMessage } from "../../src/agents/runtime/index.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewayRequestContext } from "../../src/gateway/server-methods/shared-types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    samples: { type: "string", default: "5" },
    turns: { type: "string", default: "20" },
    warmup: { type: "string", default: "3" },
    items: { type: "string", default: "50" },
    profiles: { type: "string", default: "1000" },
    sessions: { type: "string", default: "5000" },
    "workspace-files": { type: "string", default: "0" },
    "workspace-file-bytes": { type: "string", default: "18000" },
    revision: { type: "string", default: "unspecified" },
  },
});
assert(globalThis.gc, "Run with --expose-gc");
assert(["timing", "allocation", "counts"].includes(values.mode));
assert(
  values.mode !== "counts" ||
    ["--no-opt", "--no-maglev", "--no-sparkplug"].every((flag) => process.execArgv.includes(flag)),
  "Count mode requires Node --no-opt --no-maglev --no-sparkplug for exact calls after warmup",
);
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const samples = integer(values.samples, "samples");
const turns = integer(values.turns, "turns");
const warmup = integer(values.warmup, "warmup");
const itemCount = integer(values.items, "items");
const profileCount = integer(values.profiles, "profiles");
const sessionCount = integer(values.sessions, "sessions");
const workspaceFiles = integer(values["workspace-files"], "workspace-files", 0);
const workspaceFileBytes = integer(values["workspace-file-bytes"], "workspace-file-bytes");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/session-sharing-context-"));
const workspaceDir = path.join(root, "workspace");
await mkdir(workspaceDir);
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const config: OpenClawConfig = {
  plugins: { enabled: false },
  agents: { entries: { main: { workspace: workspaceDir } } },
  gateway: {
    roles: {
      default: "writer",
      definitions: {
        writer: {
          scopes: ["operator.read", "operator.write"],
          agents: "*",
          sessions: { others: "write" },
        },
        reader: {
          scopes: ["operator.read"],
          agents: "*",
          sessions: { others: "view" },
        },
      },
    },
  },
};
await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { bindHarnessMedia } = await import("../../src/agents/harness/host-media.js");
const { makeProviderModelFixture } =
  await import("../../src/agents/test-helpers/provider-model-fixture.js");
const { prepareSessionPrincipalRunAuthority } =
  await import("../../src/gateway/session-sharing-authorization-async.js");
const { ensureProfileForEmail } = await import("../../src/state/user-profiles.js");
const { setUserProfileRole } = await import("../../src/state/user-profile-writes.worker.js");
const { runOpenClawStateWriteTransaction } = await import("../../src/state/openclaw-state-db.js");
const { runOpenClawAgentWriteTransaction } = await import("../../src/state/openclaw-agent-db.js");
const { resolveOpenClawAgentSqlitePath } =
  await import("../../src/state/openclaw-agent-db.paths.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { captureSessionEntryCurrentCheckAsyncInternal } =
  await import("../../src/config/sessions/session-entry-current-check.js");
const { composeSessionSourceAssertion } =
  await import("../../src/config/sessions/session-source-authority.js");
const { cleanupSessionStateForTest } =
  await import("../../src/test-utils/session-state-cleanup.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");

const inspector = new Session();
let admitted: Awaited<ReturnType<typeof prepareSessionPrincipalRunAuthority>> | undefined;
let sessionSource:
  | Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>>
  | undefined;
let connected = false;
const scope = { agentId: "main", sessionKey: "agent:main:shared-context" };
const sessionId = "synthetic-shared-context";
function allocationSummary(head: HeapProfiler.SamplingHeapProfileNode) {
  let bytes = 0;
  let authorityBytes = 0;
  const functions = new Map<string, number>();
  function visit(node: HeapProfiler.SamplingHeapProfileNode, inside = false) {
    const frame = node.callFrame;
    const authority =
      inside ||
      /\/(?:session-sharing[^/]*|operator-run-authority|user-profile-authority)\.[cm]?[jt]s(?:\?|$)/u.test(
        frame.url,
      );
    bytes += node.selfSize;
    if (authority) {
      authorityBytes += node.selfSize;
      const key = `${frame.functionName}@${path.basename(frame.url)}`;
      functions.set(key, (functions.get(key) ?? 0) + node.selfSize);
    }
    for (const child of node.children) {
      visit(child, authority);
    }
  }
  visit(head);
  return {
    bytesPerTurn: bytes / turns,
    authorityBytesPerTurn: authorityBytes / turns,
    topAuthoritySites: [...functions]
      .toSorted((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([site, size]) => ({ site, bytesPerTurn: size / turns })),
  };
}
try {
  setRuntimeConfigSnapshot(config);
  const profiles = runOpenClawStateWriteTransaction(() =>
    Array.from({ length: profileCount }, (_, index) =>
      ensureProfileForEmail(`context-${index}@example.test`),
    ),
  );
  const person = profiles[0]!;
  runOpenClawAgentWriteTransaction((database) => {
    for (let index = 0; index < sessionCount; index++) {
      writeSessionEntry(database, index === 0 ? scope.sessionKey : `agent:main:other-${index}`, {
        sessionId: index === 0 ? sessionId : `synthetic-session-${index}`,
        lifecycleRevision: "synthetic-incarnation",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: person.id },
      });
    }
  }, scope);
  const body = "Synthetic retained document content.\n".repeat(8);
  const messages: AgentMessage[] = [];
  for (let index = 0; index < itemCount; index++) {
    const file = path.join(workspaceDir, `context-${index}.txt`);
    await writeFile(file, body);
    const message = {
      role: "user" as const,
      timestamp: index,
      content: `Read synthetic document ${index}`,
      __openclaw: { media: [{ path: file, contentType: "text/plain" }] },
    };
    messages.push(message);
  }
  const filler = "synthetic workspace content\n"
    .repeat(Math.ceil(workspaceFileBytes / 28))
    .slice(0, workspaceFileBytes);
  for (let offset = 0; offset < workspaceFiles; offset += 64) {
    await Promise.all(
      Array.from({ length: Math.min(64, workspaceFiles - offset) }, (_, index) =>
        writeFile(path.join(workspaceDir, `unrelated-${offset + index}.txt`), filler),
      ),
    );
  }
  // SAFETY: This owner entrypoint consumes only these config readers; no transport is simulated.
  const context = {
    getRuntimeConfig: () => config,
    getCommittedRuntimeConfig: () => config,
  } as GatewayRequestContext;
  const storePath = resolveOpenClawAgentSqlitePath(scope);
  sessionSource = await captureSessionEntryCurrentCheckAsyncInternal({ ...scope, storePath });
  admitted = await prepareSessionPrincipalRunAuthority({
    ...scope,
    sessionId,
    profileId: person.id,
    storePath,
    context,
  });
  const authority = admitted.authority;
  const prepare = bindHarnessMedia({
    attempt: {
      ...scope,
      sessionId,
      workspaceDir,
      abortSignal: authority.signal,
      model: makeProviderModelFixture({
        id: "synthetic-context",
        provider: "synthetic",
        api: "openai-responses",
        baseUrl: "https://model.example.test/v1",
        input: ["text"],
      }),
    },
    config,
    assertActive: composeSessionSourceAssertion([sessionSource.source, authority.assertCurrent]),
    signal: authority.signal ?? new AbortController().signal,
  }).capabilities.prepareContextMedia!;
  let completedItems = 0;
  async function turn() {
    for (const message of messages) {
      const result = await prepare({ message, maxChars: 4096 });
      assert(result.text?.includes(body.trim()), "Real file content must reach the consumer");
      assert.equal(result.images.length, 0);
      completedItems++;
    }
  }
  for (let index = 0; index < warmup; index++) {
    await turn();
  }
  inspector.connect();
  connected = true;
  if (values.mode === "counts") {
    await inspector.post("Profiler.enable");
  }
  const databaseBytes = (await stat(storePath)).size;
  const walBytes = (await stat(`${storePath}-wal`).catch(() => undefined))?.size ?? 0;
  for (let sample = 0; sample < samples; sample++) {
    globalThis.gc();
    if (values.mode === "allocation") {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    } else if (values.mode === "counts") {
      await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    }
    const hostLoad = loadavg();
    const cpuStart = process.cpuUsage();
    const threadCpuStart = process.threadCpuUsage();
    const start = performance.now();
    for (let index = 0; index < turns; index++) {
      await turn();
    }
    const elapsedMs = performance.now() - start;
    const threadCpu = process.threadCpuUsage(threadCpuStart);
    const cpu = process.cpuUsage(cpuStart);
    let allocation: ReturnType<typeof allocationSummary> | undefined;
    let counts: Record<string, number> | undefined;
    if (values.mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocation = allocationSummary(profile.head);
    } else if (values.mode === "counts") {
      const { result } = await inspector.post("Profiler.takePreciseCoverage");
      await inspector.post("Profiler.stopPreciseCoverage");
      counts = {};
      for (const script of result) {
        if (
          !/\/(?:session-sharing[^/]*|user-profile[^/]*|sqlite-worker-identity)\./u.test(script.url)
        ) {
          continue;
        }
        for (const fn of script.functions) {
          if (
            /^(?:readProfileAuthority|prepareProfileAuthorityRead|readCurrentFacts|prepareSessionSharing|prepareProjectedSessionSharing|inspectDatabasePathIdentitySync|assertTargetCurrent)$/u.test(
              fn.functionName,
            ) ||
            (script.url.endsWith("/user-profile-authority.ts") && fn.ranges[0]?.count)
          ) {
            const name = fn.functionName || `closure:${fn.ranges[0]?.startOffset}`;
            const key = `${name}@${path.basename(script.url)}`;
            counts[key] = (counts[key] ?? 0) + (fn.ranges[0]?.count ?? 0) / turns;
          }
        }
      }
    }
    console.log(
      JSON.stringify({
        revision: values.revision,
        mode: values.mode,
        sample,
        node: process.version,
        turns,
        itemsPerTurn: itemCount,
        profiles: profileCount,
        sessions: sessionCount,
        databaseBytes,
        walBytes,
        workspaceFiles: workspaceFiles + itemCount,
        workspaceBytes: workspaceFiles * workspaceFileBytes + Buffer.byteLength(body) * itemCount,
        wallMsPerTurn: elapsedMs / turns,
        threadCpuMsPerTurn: (threadCpu.user + threadCpu.system) / 1000 / turns,
        processCpuMsPerTurn: (cpu.user + cpu.system) / 1000 / turns,
        allocation,
        countsPerTurn: counts,
        completedItems,
        hostLoad,
      }),
    );
  }
  setUserProfileRole(person.id, "reader");
  await assert.rejects(prepare({ message: messages[0]!, maxChars: 4096 }));
  console.log(JSON.stringify({ revision: values.revision, revocationRejected: true }));
} finally {
  if (connected) {
    inspector.disconnect();
  }
  admitted?.release();
  sessionSource?.release();
  await cleanupSessionStateForTest({ stateDir: root, rootPath: root });
  await drainGlobalSingletonLifecycleState();
  await rm(root, { recursive: true, force: true });
}
