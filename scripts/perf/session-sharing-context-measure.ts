/**
 * Shared-session authority through retained media, real Git, or its final authority guard.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-sharing-context-measure.ts \
 *   --mode timing --samples 5 --turns 20 --warmup 20 --items 50 --profiles 1000 --sessions 5000
 * Repeat with --mode allocation; instrumentation is never timed.
 * Use --operation git for real config reads or --operation authority for owner-only costs.
 * Add --active-sessions 32 to interleave retained shared-session authorities for those operations.
 * For --mode counts, pass Node --no-opt --no-maglev --no-sparkplug before --expose-gc.
 * Optimized/inlined functions otherwise lose precise-coverage calls after warmup.
 * Add --workspace-files 62000 --workspace-file-bytes 18000 for a 1.1 GB directory.
 * Alternate pinned baseline/candidate checkouts; run baseline twice for A/A controls.
 * Give both checkouts the same --fixture-parent so path validation has identical path lengths.
 * Media acceptance: lower authority CPU/allocation (>=20%), no >20% total regression.
 * Git/authority acceptance: allocation reduction outside A/A spread, no >20%
 * CPU or latency regression, unchanged revocation. Setup/warmup/teardown are excluded.
 * This is real owner/effect composition, not a model or Gateway transport benchmark.
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
    operation: { type: "string", default: "media" },
    samples: { type: "string", default: "5" },
    turns: { type: "string", default: "20" },
    warmup: { type: "string", default: "3" },
    items: { type: "string", default: "50" },
    profiles: { type: "string", default: "1000" },
    sessions: { type: "string", default: "5000" },
    "active-sessions": { type: "string", default: "1" },
    "workspace-files": { type: "string", default: "0" },
    "workspace-file-bytes": { type: "string", default: "18000" },
    revision: { type: "string", default: "unspecified" },
    "fixture-parent": { type: "string", default: ".local" },
  },
});
assert(globalThis.gc, "Run with --expose-gc");
assert(["timing", "allocation", "counts"].includes(values.mode));
assert(["media", "git", "authority"].includes(values.operation));
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
const activeSessionCount = integer(values["active-sessions"], "active-sessions");
assert(activeSessionCount <= sessionCount, "Active sessions must fit the stored-session fixture");
assert(values.operation !== "media" || activeSessionCount === 1, "Media uses one retained session");
assert(
  values.operation === "media" || profileCount >= 2,
  "Shared Git authority needs two profiles",
);
const workspaceFiles = integer(values["workspace-files"], "workspace-files", 0);
const workspaceFileBytes = integer(values["workspace-file-bytes"], "workspace-file-bytes");
const fixtureParent = path.resolve(values["fixture-parent"]);
await mkdir(fixtureParent, { recursive: true });
const root = await mkdtemp(path.join(fixtureParent, "session-sharing-context-"));
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
          sessions: { others: values.operation === "media" ? "write" : "view" },
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
const { addSessionMemberInWorker } =
  await import("../../src/config/sessions/session-sharing-store.async.js");
const { captureSessionEntryCurrentCheckAsyncInternal } =
  await import("../../src/config/sessions/session-entry-current-check.js");
const { composeSessionSourceAssertion } =
  await import("../../src/config/sessions/session-source-authority.js");
const { executeGitCommand } = await import("../../src/infra/git-exec.js");
const { cleanupSessionStateForTest } =
  await import("../../src/test-utils/session-state-cleanup.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");

const inspector = new Session();
const admitted: Awaited<ReturnType<typeof prepareSessionPrincipalRunAuthority>>[] = [];
const sessionSources: Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>>[] =
  [];
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
      /\/src\/(?:gateway\/(?:session-sharing[^/]*|operator-run-authority)|config\/sessions\/session-source-authority|state\/user-profile-authority)\.[cm]?[jt]s(?:\?|$)/u.test(
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
    ...(values.operation === "media"
      ? {}
      : {
          bytesPerCommand: bytes / turns / itemCount,
          authorityBytesPerCommand: authorityBytes / turns / itemCount,
        }),
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
  const creator = values.operation === "media" ? person : profiles[1]!;
  const activeScopes = Array.from({ length: activeSessionCount }, (_, index) => ({
    ...scope,
    sessionKey: index === 0 ? scope.sessionKey : `agent:main:shared-context-${index}`,
    sessionId: index === 0 ? sessionId : `synthetic-shared-context-${index}`,
  }));
  runOpenClawAgentWriteTransaction((database) => {
    for (let index = 0; index < sessionCount; index++) {
      const active = activeScopes[index];
      writeSessionEntry(database, active?.sessionKey ?? `agent:main:other-${index}`, {
        sessionId: active?.sessionId ?? `synthetic-session-${index}`,
        lifecycleRevision: "synthetic-incarnation",
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: creator.id },
      });
    }
  }, scope);
  if (values.operation !== "media") {
    for (const active of activeScopes) {
      await addSessionMemberInWorker(active, { identityId: person.id, addedBy: creator.id });
    }
  }
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
  const assertions: ReturnType<typeof composeSessionSourceAssertion>[] = [];
  for (const active of activeScopes) {
    const source = await captureSessionEntryCurrentCheckAsyncInternal({ ...active, storePath });
    sessionSources.push(source);
    const run = await prepareSessionPrincipalRunAuthority({
      ...active,
      profileId: person.id,
      storePath,
      context,
    });
    admitted.push(run);
    assertions.push(composeSessionSourceAssertion([source.source, run.authority.assertCurrent]));
  }
  const authority = admitted[0]!.authority;
  const assertActive = assertions[0]!;
  const gitConfig = path.join(workspaceDir, "authority.config");
  const gitConfigContent = "[proof]\nvalue = synthetic-authorized\n";
  await writeFile(gitConfig, gitConfigContent);
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
    assertActive,
    signal: authority.signal ?? new AbortController().signal,
  }).capabilities.prepareContextMedia!;
  let completedItems = 0;
  async function turn() {
    for (const message of messages) {
      const assertCommandCurrent = assertions[completedItems % assertions.length]!;
      if (values.operation === "authority") {
        assertCommandCurrent();
      } else if (values.operation === "git") {
        const result = await executeGitCommand(
          workspaceDir,
          ["config", "--file", gitConfig, "--get", "proof.value"],
          { beforeRun: assertCommandCurrent },
        );
        assert.equal(result.code, 0);
        assert.equal(result.stdout.trim(), "synthetic-authorized");
      } else {
        const result = await prepare({ message, maxChars: 4096 });
        assert(result.text?.includes(body.trim()), "Real file content must reach the consumer");
        assert.equal(result.images.length, 0);
      }
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
        operation: values.operation,
        sample,
        node: process.version,
        turns,
        itemsPerTurn: itemCount,
        profiles: profileCount,
        sessions: sessionCount,
        activeSessions: activeSessionCount,
        databaseBytes,
        walBytes,
        workspaceFiles: workspaceFiles + itemCount + 1,
        workspaceBytes:
          workspaceFiles * workspaceFileBytes +
          Buffer.byteLength(body) * itemCount +
          Buffer.byteLength(gitConfigContent),
        wallMsPerTurn: elapsedMs / turns,
        threadCpuMsPerTurn: (threadCpu.user + threadCpu.system) / 1000 / turns,
        processCpuMsPerTurn: (cpu.user + cpu.system) / 1000 / turns,
        ...(values.operation === "media"
          ? {}
          : {
              commandsPerTurn: itemCount,
              wallMsPerCommand: elapsedMs / turns / itemCount,
              threadCpuMsPerCommand: (threadCpu.user + threadCpu.system) / 1000 / turns / itemCount,
              processCpuMsPerCommand: (cpu.user + cpu.system) / 1000 / turns / itemCount,
            }),
        allocation,
        countsPerTurn: counts,
        completedItems,
        hostLoad,
      }),
    );
  }
  setUserProfileRole(person.id, "reader");
  await assert.rejects(turn());
  for (const assertion of assertions) {
    assert.throws(assertion);
  }
  console.log(JSON.stringify({ revision: values.revision, revocationRejected: true }));
} finally {
  if (connected) {
    inspector.disconnect();
  }
  for (const run of admitted) {
    run.release();
  }
  for (const source of sessionSources) {
    source.release();
  }
  await cleanupSessionStateForTest({ stateDir: root, rootPath: root });
  await drainGlobalSingletonLifecycleState();
  await rm(root, { recursive: true, force: true });
}
