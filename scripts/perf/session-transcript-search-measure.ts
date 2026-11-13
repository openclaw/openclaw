// Synthetic indexed-search workload through a real authenticated WebSocket Gateway; no inference.
// Run serially on a quiet host (directory must not exist; keep TMPDIR/TMP/TEMP unchanged):
// node --import ./scripts/tsx.mjs scripts/perf/session-transcript-search-measure.ts \
//   --state-dir /tmp/search-measure-1 --sessions 3500 --pairs 20 --first-variant A
// A = default active scope; B = archived:all, NOT different server revisions.
// Compare revisions in separate serial runs with fresh directories and reversed first order.
// --source-ref <commit> pins the owners below; never switches the checkout.
// The native query owner also runs in workers: its on-disk bytes must match the ref.
// Prepare that source in a task-owned baseline checkout or a serialized overlay first;
// never change it while a Gateway, benchmark or test in this checkout is running.
// First-use is per shape in one process, not OS-cold cache/startup or browser/rendering proof.
// Retain plan.json, samples.json, result.json, and synthetic state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import net from "node:net";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type {
  SessionsListParams,
  SessionsSearchParams,
  SessionsSearchResult,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { SessionsListResult } from "../../src/gateway/session-utils.types.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

type Variant = "A" | "B" | "A-control";
type Phase = "first-use" | "warmup" | "warm-AB" | "warm-AA";
type Sample = {
  phase: Phase;
  pair: number;
  variant: Variant;
  kind: string;
  position: number;
  elapsedMs: number;
  processCpu: NodeJS.CpuUsage;
  hostLoad: number[];
  reply: SessionsListResult | SessionsSearchResult;
};
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    sessions: { type: "string", default: "3500" },
    pairs: { type: "string", default: "20" },
    "first-variant": { type: "string", default: "A" },
    "source-ref": { type: "string" },
  },
});
const stateDirectory = values["state-dir"];
assert(
  typeof stateDirectory === "string" && stateDirectory.trim(),
  "--state-dir must name a new synthetic directory",
);
assert(values["first-variant"] === "A" || values["first-variant"] === "B");
const sessions = parseStrictIntegerOption({
  raw: values.sessions,
  label: "--sessions",
  min: 175,
  fallback: 3500,
});
const pairs = parseStrictIntegerOption({
  raw: values.pairs,
  label: "--pairs",
  min: 10,
  fallback: 20,
});
const firstVariant = values["first-variant"];
const active = Math.round(sessions / 7);
const coldCount = 5;
const agentIds = ["main", "second", "third", "fourth", "fifth"];
const root = path.resolve(stateDirectory);
const repo = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
const sourceRef = values["source-ref"]
  ? git("rev-parse", "--verify", "--end-of-options", values["source-ref"] + "^{commit}")
  : undefined;
// Same loader route as session-prepared-list-measure.ts, before runtime imports.
// Capture owner bytes once: the report hashes exactly what the host hook serves.
const captureSource = (file: string) => {
  const source = sourceRef
    ? execFileSync("git", ["show", sourceRef + ":" + file], { cwd: repo, encoding: "utf8" })
    : readFileSync(path.join(repo, file), "utf8");
  return {
    file,
    url: new URL("../../" + file, import.meta.url).href,
    source,
    sha256: createHash("sha256").update(source).digest("hex"),
    loads: 0,
  };
};
const sources = [
  "src/gateway/session-list-filters.ts",
  "src/gateway/session-row-presentation.ts",
  "src/gateway/session-utils-list.ts",
  "src/gateway/server-methods/sessions-search-projected.ts",
  "src/gateway/server-methods/sessions-read.ts",
  "src/config/sessions/session-transcript-search.ts",
  "src/config/sessions/session-transcript-index-readiness.ts",
  "src/config/sessions/session-transcript-worker-readers.ts",
].map(captureSource);
const workerSources = [
  ...sources.filter((source) => source.file.startsWith("src/config/sessions/")),
  ...[
    "src/infra/kysely-sync.ts",
    "src/config/sessions/session-transcript-search.types.ts",
    "src/config/sessions/session-transcript.worker.ts",
    "src/config/sessions/session-transcript-worker-read.types.ts",
    "src/config/sessions/session-transcript-worker.types.ts",
  ].map(captureSource),
];
for (const source of workerSources) {
  assert.equal(
    readFileSync(path.join(repo, source.file), "utf8"),
    source.source,
    "Worker source must match --source-ref before starting: " + source.file,
  );
}
const hook = registerHooks({
  load(url, context, nextLoad) {
    const selected = sources.find((source) => source.url === url);
    if (!selected) {
      return nextLoad(url, context);
    }
    selected.loads++;
    return { format: "module-typescript", source: selected.source, shortCircuit: true };
  },
});
// Non-recursive creation refuses reuse, including an empty directory or symlink.
mkdirSync(root);
mkdirSync(path.join(root, "workspace"));
const configPath = path.join(root, "openclaw.json");
process.env = {
  ...createGatewayBenchEnv(root, configPath, { startupTrace: false }),
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
const stateDir = process.env.OPENCLAW_STATE_DIR!;
const scope = {
  includeGlobal: false,
  includeUnknown: false,
  configuredAgentsOnly: true,
  excludeSubagents: true,
  excludeCron: true,
  excludeSystem: true,
  excludeDock: true,
} satisfies NonNullable<SessionsSearchParams["scope"]>;
const queries = [
  {
    kind: "metadata-common",
    method: "sessions.list",
    query: "quartz",
    activeHits: active,
    allHits: sessions,
  },
  {
    kind: "metadata-archive",
    method: "sessions.list",
    query: "Archived quartz",
    activeHits: 0,
    allHits: sessions - active,
  },
  {
    kind: "message-common",
    method: "sessions.search",
    query: "orchardglow",
    activeHits: active,
    allHits: sessions - coldCount,
  },
  {
    kind: "message-archive",
    method: "sessions.search",
    query: "amberquill",
    activeHits: 0,
    allHits: sessions - active - coldCount,
  },
  {
    kind: "message-absent",
    method: "sessions.search",
    query: "absentconstellation",
    activeHits: 0,
    allHits: 0,
  },
  { kind: "message-cold", method: "sessions.search", query: "deepice", activeHits: 0, allHits: 0 },
] as const;
const plan = {
  acceptanceRule:
    "Serial >=10 counterbalanced AB pairs and AA controls, first-use apart from warm. Result caps, exact hit/exclusion counts and zero cold restoration must hold. >=20% median/p95 regression remains a failed gate, not accepted; this script does not declare a performance win.",
  proofBoundary:
    "Real source Gateway and authenticated WebSocket sessions.list/sessions.search; no UI debounce, rendering, tie-break, inference, external service, built artifact or OS-cold-cache claim.",
  variants: { A: "default active scope", B: "archived:all", "A-control": "identical to A" },
  sourceRef: sourceRef ?? "working-tree",
  head,
  sourceHashes: sources.map(({ file, sha256 }) => ({ file, sha256 })),
  workerSources: workerSources.map(({ file, sha256 }) => ({ file, sha256 })),
  sessions,
  active,
  archived: sessions - active,
  coldCount,
  agentIds,
  pairs,
  warmups: 2,
  firstVariant,
  queries,
  root,
  node: process.version,
  availableParallelism: availableParallelism(),
  hostLoad: loadavg(),
  measurement:
    "RPC wall time and whole-process CPU. Serialization/artifact writes occur after all samples and shutdown. Profile separately; this is not per-query SQL or worker-thread CPU attribution.",
};
writeFileSync(path.join(root, "plan.json"), JSON.stringify(plan, null, 2));
const samples: Sample[] = [];
const failures: unknown[] = [];
let fixtureMs: number | undefined;
let workerEntry: string | undefined;
let searchPool:
  | {
      maxWorkers: number;
      workers: number;
      workersCreated: number;
      activeTasks: number;
      pendingTasks: number;
    }
  | undefined;
let startupMs: number | undefined;
let storageBefore: ReturnType<typeof snapshot> | undefined;
let storageAfter: ReturnType<typeof snapshot> | undefined;
let coldRestorationVerified = false;
let shutdownComplete = false;
let reservation:
  | Awaited<
      ReturnType<typeof import("../../src/test-utils/port-claims.js").reserveTestPortListener>
    >
  | undefined;
let server:
  | Awaited<ReturnType<typeof import("../../src/gateway/server.js").startGatewayServer>>
  | undefined;
let client:
  | Awaited<
      ReturnType<typeof import("../../test/helpers/gateway-client.js").acquireGatewayTestClient>
    >
  | undefined;
let agentDb: typeof import("../../src/state/openclaw-agent-db.js") | undefined;
let stateDb: typeof import("../../src/state/openclaw-state-db.js") | undefined;
let runtimeConfig: typeof import("../../src/config/runtime-snapshot.js") | undefined;
const started = performance.now();

// Offline test/proof inspection after awaited writer/reader shutdown, never during RPCs.
// Navigation survives cold archival: compare payload presence as well as row counts.
function snapshot() {
  assert(agentDb);
  const databaseOwner = agentDb;
  return agentIds.map((agentId) => {
    const db = new DatabaseSync(
      databaseOwner.resolveOpenClawAgentSqlitePath({ agentId, env: process.env }),
      { readOnly: true },
    );
    try {
      db.exec("BEGIN");
      return {
        agentId,
        cold: db
          .prepare(
            "SELECT session_id, generation, archive_name, archive_sha256, event_count, storage, archived_at FROM session_transcript_cold_archives ORDER BY session_id",
          )
          .all(),
        events: db.prepare("SELECT COUNT(*) AS n FROM transcript_events").get(),
        coldEvents: db
          .prepare(
            "SELECT session_id, seq, event_json IS NOT NULL AS json_payload, event_zstd IS NOT NULL AS compressed_payload FROM transcript_events WHERE session_id IN (SELECT session_id FROM session_transcript_cold_archives) ORDER BY session_id, seq",
          )
          .all(),
        fts: db.prepare("SELECT COUNT(*) AS n FROM session_transcript_fts").get(),
        coldFts: db
          .prepare(
            "SELECT COUNT(*) AS n FROM session_transcript_fts WHERE session_id IN (SELECT session_id FROM session_transcript_cold_archives)",
          )
          .get(),
      };
    } finally {
      try {
        if (db.isTransaction) {
          db.exec("ROLLBACK");
        }
      } finally {
        db.close();
      }
    }
  });
}

try {
  await runQaGatewayFixture(
    async () => {
      const { initializeSqliteRuntime } =
        await import("../../src/infra/sqlite-runtime-initialize.js");
      await initializeSqliteRuntime();
      runtimeConfig = await import("../../src/config/runtime-snapshot.js");
      agentDb = await import("../../src/state/openclaw-agent-db.js");
      stateDb = await import("../../src/state/openclaw-state-db.js");
      const { writeSessionEntry } =
        await import("../../src/config/sessions/session-accessor.sqlite-entry-write.js");
      const { appendTranscriptEventsInTransaction } =
        await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
      const { touchTranscriptMutationInTransaction } =
        await import("../../src/config/sessions/session-accessor.sqlite-transcript-state.js");
      const { ensureGatewayOwnerProfile } = await import("../../src/state/user-profiles.js");
      const { waitForSessionTranscriptIndexReconcilesInStateDir } =
        await import("../../src/config/sessions/session-transcript-reconcile.js");
      const { reserveTestPortListener } = await import("../../src/test-utils/port-claims.js");
      reservation = await reserveTestPortListener({
        offsets: [0],
        createListener: () => net.createServer(),
      });
      const port = reservation.claim.port;
      const token = "synthetic-benchmark-token-not-a-real-credential";
      const config: OpenClawConfig = {
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token },
          controlUi: { enabled: false },
          tailscale: { mode: "off" },
        },
        discovery: { mdns: { mode: "off" } },
        browser: { enabled: false },
        cron: { enabled: false },
        plugins: { enabled: false },
        update: { checkOnStart: false },
        skills: { load: { watch: false } },
        session: {
          maintenance: { mode: "warn", maxEntries: sessions * 2, coldStorage: { enabled: false } },
        },
        logging: { file: path.join(root, "gateway.log"), consoleLevel: "warn" },
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: path.join(root, "workspace"),
            model: "fixture/search-model",
            modelPolicy: { allow: ["fixture/*"] },
          },
          entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-no-inference-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                {
                  id: "search-model",
                  name: "Synthetic search model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
      };
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      runtimeConfig.setRuntimeConfigSnapshot(config);
      const fixtureStarted = performance.now();
      const now = Date.now();
      const profile = ensureGatewayOwnerProfile("Synthetic Benchmark Viewer");
      await stateDb.openOpenClawStateDatabase().walMaintenance.stop();
      for (const [agentIndex, agentId] of agentIds.entries()) {
        const options = { agentId, env: process.env };
        await agentDb.openOpenClawAgentDatabase(options).walMaintenance.stop();
        const indices = Array.from({ length: sessions }, (_, i) => i).filter(
          (i) => i % agentIds.length === agentIndex,
        );
        for (let offset = 0; offset < indices.length; offset += 100) {
          agentDb.runOpenClawAgentWriteTransaction((db) => {
            for (const i of indices.slice(offset, offset + 100)) {
              const sessionId = "bench-session-" + i;
              const sessionKey = "agent:" + agentId + ":dashboard:bench-" + i;
              const archived = i >= active;
              const cold = i >= sessions - coldCount;
              const ts = cold ? now - 60 * 86400000 : now - i * 1000;
              writeSessionEntry(db, sessionKey, {
                sessionId,
                updatedAt: ts,
                createdAt: ts,
                lastActivityAt: ts,
                lastInteractionAt: ts,
                label: (archived ? "Archived" : "Active") + " quartz expedition " + i,
                visibility: "shared",
                createdVia: "operator",
                createdActor: { type: "human", source: "profile", id: profile.id },
                ...(archived ? { archivedAt: ts } : {}),
              });
              const text =
                "Orchardglow notebook " +
                i +
                (archived ? " amberquill archive" : " azurefinch active") +
                (cold ? " deepice cold archive" : "") +
                ". Synthetic search corpus and bounded metadata.";
              appendTranscriptEventsInTransaction(
                db,
                { ...options, sessionKey, sessionId },
                [
                  {
                    type: "session",
                    version: 3,
                    id: sessionId,
                    timestamp: new Date(ts).toISOString(),
                  },
                  {
                    type: "message",
                    id: "bench-message-" + i,
                    parentId: null,
                    timestamp: new Date(ts).toISOString(),
                    message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
                  },
                ],
                { touchMutation: false },
              );
              touchTranscriptMutationInTransaction(
                db,
                sessionId,
                { projectionReady: true },
                { adjustedTime: ts, steps: 1 },
              );
            }
          }, options);
          await nextTurn();
        }
      }
      await waitForSessionTranscriptIndexReconcilesInStateDir(stateDir);
      const { runSessionColdStorageMaintenance } =
        await import("../../src/config/sessions/session-cold-storage.js");
      const cold = await runSessionColdStorageMaintenance({
        config: {
          ...config,
          session: {
            ...config.session,
            maintenance: {
              ...config.session?.maintenance,
              coldStorage: { enabled: true, afterDays: 30 },
            },
          },
        },
      });
      assert.equal(cold.archivedTranscripts, coldCount);
      await agentDb.closeOpenClawAgentDatabasesAsync(stateDir);
      await stateDb.closeOpenClawStateDatabaseAsync();
      runtimeConfig.clearRuntimeConfigSnapshot();
      storageBefore = snapshot();
      for (const [agentIndex, stored] of storageBefore.entries()) {
        const count = Math.floor((sessions - 1 - agentIndex) / agentIds.length) + 1;
        const coldIndex = Array.from(
          { length: coldCount },
          (_, i) => sessions - coldCount + i,
        ).find((i) => i % agentIds.length === agentIndex);
        assert.equal(stored.cold.length, 1);
        assert.equal(stored.cold[0]?.session_id, "bench-session-" + coldIndex);
        assert.equal(stored.cold[0]?.event_count, 2);
        assert.equal(stored.events?.n, count * 2);
        assert.equal(stored.coldEvents.length, 2);
        // The header stays hot; the synthetic message must actually have left hot storage.
        const message = stored.coldEvents.at(-1);
        assert.equal(message?.json_payload, 0);
        assert.equal(message?.compressed_payload, 0);
        assert.equal(stored.fts?.n, count - 1);
        assert.equal(stored.coldFts?.n, 0);
      }
      fixtureMs = performance.now() - fixtureStarted;
      const { resolveRuntimeWorkerUrl } = await import("../../src/infra/runtime-worker-url.js");
      const { runtimeProcessEntrypoints } =
        await import("../../src/infra/runtime-process-entrypoints.js");
      const entry = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscript);
      assert.equal(
        fileURLToPath(entry),
        path.join(repo, "src/config/sessions/session-transcript.worker.ts"),
      );
      workerEntry = entry.href;
      const { startGatewayServer } = await import("../../src/gateway/server.js");
      const { acquireGatewayTestClient } = await import("../../test/helpers/gateway-client.js");
      await reservation.releaseListener();
      const startupStarted = performance.now();
      server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
      await server.startupSettled;
      startupMs = performance.now() - startupStarted;
      const url = "ws://127.0.0.1:" + port;
      client = await acquireGatewayTestClient(
        {
          url,
          token,
          env: process.env,
          clientName: "cli",
          mode: "cli",
          scopes: ["operator.admin"],
          deviceIdentity: null,
          deviceAuthScope: url,
          sharedStateMode: "read-only",
        },
        {
          timeoutMs: 20000,
          timeoutMessage: "Benchmark handshake timeout",
          closeMessage: "Benchmark handshake closed",
        },
      );
      const read = async (
        q: (typeof queries)[number],
        variant: Variant,
        phase: Phase,
        pair: number,
        position: number,
      ) => {
        assert(client);
        const selected = variant === "B" ? { ...scope, archived: "all" as const } : scope;
        const params: SessionsListParams | SessionsSearchParams =
          q.method === "sessions.list"
            ? {
                ...selected,
                search: q.query,
                limit: 10,
                rowMode: "compact",
                source: "command-palette",
                ifRowsRevision: "",
              }
            : { query: q.query, limit: 25, scope: selected };
        const cpu = process.cpuUsage();
        const begin = performance.now();
        const reply = await client.request<SessionsListResult | SessionsSearchResult>(
          q.method,
          params,
          { timeoutMs: 60000 },
        );
        const elapsedMs = performance.now() - begin;
        const processCpu = process.cpuUsage(cpu);
        const expected = variant === "B" ? q.allHits : q.activeHits;
        if ("results" in reply) {
          assert.equal(q.method, "sessions.search");
          assert.equal(
            reply.results.length,
            Math.min(25, expected),
            q.kind + "/" + variant + " hit count",
          );
          assert.equal(reply.sessions?.length, reply.results.length);
          assert.equal(
            new Set(reply.results.map((hit) => hit.sessionId)).size,
            reply.results.length,
          );
          for (const hit of reply.results) {
            const index = Number(hit.sessionId.slice("bench-session-".length));
            assert.equal(hit.sessionId, "bench-session-" + index);
            assert.equal(hit.messageId, "bench-message-" + index);
            assert.equal(
              hit.sessionKey,
              "agent:" + agentIds[index % agentIds.length] + ":dashboard:bench-" + index,
            );
            assert(index >= 0 && index < sessions - coldCount);
            assert(variant === "B" || index < active);
            assert(q.kind !== "message-archive" || index >= active);
          }
          assert.equal(reply.indexing ?? false, false);
          assert.equal(reply.truncated ?? false, expected > 25);
          assert.equal(reply.archivedTranscriptsExcluded ?? 0, variant === "B" ? coldCount : 0);
        } else {
          assert.equal(q.method, "sessions.list");
          assert.equal(
            reply.sessions.length,
            Math.min(10, expected),
            q.kind + "/" + variant + " hit count",
          );
          assert.equal(reply.totalCount, expected);
          assert.equal(reply.limitApplied, 10);
          assert.equal(reply.hasMore, expected > 10);
        }
        // Retain bounded replies; no JSON/string sizing or file writes between timed requests.
        samples.push({
          phase,
          pair,
          variant,
          kind: q.kind,
          position,
          elapsedMs,
          processCpu,
          hostLoad: loadavg(),
          reply,
        });
      };
      const firstOrder: Variant[] = firstVariant === "A" ? ["A", "B"] : ["B", "A"];
      for (const q of queries) {
        for (const [position, variant] of firstOrder.entries()) {
          await read(q, variant, "first-use", 0, position);
        }
      }
      for (const source of sources) {
        assert(source.loads > 0, "Source hook did not load " + source.file);
      }
      for (let warmup = 0; warmup < 2; warmup++) {
        for (const q of queries) {
          for (const [position, variant] of firstOrder.entries()) {
            await read(q, variant, "warmup", warmup, position);
          }
        }
      }
      for (let pair = 0; pair < pairs; pair++) {
        const order = pair % 2 === 0 ? firstOrder : firstOrder.toReversed();
        for (const q of queries) {
          for (const [position, variant] of order.entries()) {
            await read(q, variant, "warm-AB", pair, position);
          }
        }
        for (const q of queries) {
          for (const [position, variant] of (["A", "A-control"] as const).entries()) {
            await read(q, variant, "warm-AA", pair, position);
          }
        }
      }
      const { transcriptSearchLane } =
        await import("../../src/config/sessions/session-transcript-worker-resources.js");
      searchPool = transcriptSearchLane.pool.getSnapshot();
    },
    () => client?.stopAndWait(),
    () => server?.close({ reason: "Synthetic transcript-search benchmark complete" }),
    () => agentDb?.closeOpenClawAgentDatabasesAsync(stateDir),
    () => stateDb?.closeOpenClawStateDatabaseAsync(),
    () => runtimeConfig?.clearRuntimeConfigSnapshot(),
    () => (reservation?.listener.listening ? reservation.releaseListener() : undefined),
    () => reservation?.claim.release(),
  );
  shutdownComplete = true;
} catch (error) {
  failures.push(error);
} finally {
  hook.deregister();
}
// No storage verdict if any body/cleanup phase failed: retain partial evidence instead.
if (shutdownComplete && storageBefore) {
  try {
    for (const source of workerSources) {
      assert.equal(
        readFileSync(path.join(repo, source.file), "utf8"),
        source.source,
        "Worker source changed during benchmark: " + source.file,
      );
    }
    storageAfter = snapshot();
    assert.deepEqual(
      storageAfter,
      storageBefore,
      "Search restored or changed cold/transcript storage",
    );
    coldRestorationVerified = true;
  } catch (error) {
    failures.push(error);
  }
}
const stats = (numbers: number[]) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  assert(sorted.length > 0);
  return {
    n: sorted.length,
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    min: sorted[0]!,
    max: sorted.at(-1)!,
  };
};
// Serialization is outside the entire measurement/profiling loop and after cleanup.
const serialized = samples.map(({ reply, ...sample }) => ({
  ...sample,
  responseBytes: Buffer.byteLength(JSON.stringify(reply)),
  resultCount: "results" in reply ? reply.results.length : reply.sessions.length,
  totalCount: "results" in reply ? undefined : reply.totalCount,
  indexing: "results" in reply ? (reply.indexing ?? false) : false,
  archivedTranscriptsExcluded: "results" in reply ? (reply.archivedTranscriptsExcluded ?? 0) : 0,
  truncated: "results" in reply ? (reply.truncated ?? false) : false,
}));
const key = (sample: Sample) => sample.phase + "/" + sample.kind + "/" + sample.variant;
const summaries = [...new Set(samples.map(key))].map((name) => {
  const group = serialized.filter(
    (sample) => sample.phase + "/" + sample.kind + "/" + sample.variant === name,
  );
  return {
    key: name,
    latencyMs: stats(group.map((s) => s.elapsedMs)),
    processCpuMs: stats(group.map((s) => (s.processCpu.user + s.processCpu.system) / 1000)),
    resultCounts: [...new Set(group.map((s) => s.resultCount))],
    excludedColdCounts: [...new Set(group.map((s) => s.archivedTranscriptsExcluded))],
  };
});
const report = {
  ...plan,
  fixtureMs,
  workerEntry,
  searchPool,
  startupMs,
  totalElapsedMs: performance.now() - started,
  sampleCount: samples.length,
  summaries,
  storageBefore,
  storageAfter,
  shutdownComplete,
  sourceLoads: sources.map(({ file, sha256, loads }) => ({ file, sha256, loads })),
  coldRestoration: {
    verified: coldRestorationVerified,
    evidence: coldRestorationVerified
      ? "Cold archive identities/generations/hashes, cold payload presence, transcript/FTS counts unchanged after awaited closes; exact exclusion counts asserted on every search."
      : "Incomplete: inspect failures and retained snapshots; no zero-restoration claim.",
  },
  hostLoadEnd: loadavg(),
  status: failures.length ? "failed" : "measured; performance acceptance pending",
  failures: failures.map((error) =>
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  ),
};
writeFileSync(path.join(root, "samples.json"), JSON.stringify(serialized, null, 2));
writeFileSync(path.join(root, "result.json"), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      root,
      status: report.status,
      sampleCount: samples.length,
      summaries,
      coldRestoration: report.coldRestoration,
    },
    null,
    2,
  ),
);
if (failures.length) {
  throw new AggregateError(failures, "Transcript-search benchmark failed; artifacts retained");
}
