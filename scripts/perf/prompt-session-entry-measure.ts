/**
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/prompt-session-entry-measure.ts
 *   [--iterations 2000]
 * Five alternating pairs compare the prompt's admitted entry read before (full)
 * and after (list). A real worker prepares a 40-skill, ~30 KiB synthetic entry.
 * Each operation republishes captured metadata-only or full facts through the
 * replica owner before reading. That identical publication cost is INCLUDED.
 * Metadata-only facts expose unnecessary worker/snapshot hydration; full facts
 * expose the candidate's shallow-copy cost versus borrowing a frozen full entry.
 * Timing is untraced; allocation is a separate sampling pass, including collected
 * objects. CPU/allocation cover the main thread only, not the worker or Gateway.
 * This is an owner benchmark, not evidence of the frequency of either cache state.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { loadSessionEntryForAdmission } from "../../src/config/sessions/session-accessor.sqlite-entry-admission.js";
import { replaceSessionEntrySync } from "../../src/config/sessions/session-accessor.sqlite-entry-replace.js";
import { retainSessionActorEntryFacts } from "../../src/config/sessions/session-actor-replica.js";
import { withSessionHistoryWorkerDatabase } from "../../src/config/sessions/session-transcript-worker-runtime.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const { values } = parseArgs({ options: { iterations: { type: "string", default: "2000" } } });
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "Invalid iterations");
assert(global.gc, "Run with --expose-gc");
const gc = global.gc;
const inspector = new Session();
inspector.connect();
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}

try {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const sessionKey = "agent:main:dashboard:prompt-measure";
    const scope = { agentId: "main", env, sessionKey };
    const skills = Array.from({ length: 40 }, (_, i) => ({ name: `synthetic-skill-${i}` }));
    const entry = {
      sessionId: "synthetic-session",
      lifecycleRevision: "synthetic-lifecycle",
      updatedAt: 1,
      publicShare: { id: "a".repeat(48), sessionId: "synthetic-session", createdAt: 1 },
      skillsSnapshot: { prompt: "Synthetic skill instructions. ".repeat(1_000), skills },
    };
    replaceSessionEntrySync(scope, entry);
    const { databaseClaim } = await loadSessionEntryForAdmission(scope);
    try {
      assert("reader" in databaseClaim && databaseClaim.reader, "Expected durable reader");
      const reader = databaseClaim.reader;
      const replies = await withSessionHistoryWorkerDatabase(reader.database, async (worker) => ({
        metadata: await worker.readExactEntries({
          env,
          sessionKeys: [sessionKey],
          snapshotFields: [],
        }),
        full: await worker.readExactEntries({ env, sessionKeys: [sessionKey] }),
      }));
      const source = replies.full.source;
      const identity = replies.full.databaseIdentity;
      assert(source && identity, "Expected worker source identity");
      const target = {
        kind: "file" as const,
        physicalIdentity: source.databaseIdentity,
        nativeLocation: source.path,
        birthtime: source.databaseBirthtime,
      };
      const cohorts = [
        { name: "metadata-warm", reply: replies.metadata, snapshots: [] as const },
        { name: "full-warm", reply: replies.full, snapshots: "full" as const },
      ];
      const results = [];
      for (const cohort of cohorts) {
        const row = cohort.reply.entries[0];
        assert(row?.entry && row.sessionKey === sessionKey, "Missing synthetic row");
        const facts = [{ sessionKey, facts: { entry: row.entry, snapshots: cohort.snapshots } }];
        const run = async (arm: "full" | "list", count: number) => {
          let snapshotsReturned = 0;
          for (let i = 0; i < count; i++) {
            retainSessionActorEntryFacts(target, facts, identity.incarnation);
            const result = await reader.readEntry(() => {}, arm);
            assert.equal(result.entry.publicShare?.sessionId, entry.sessionId);
            assert.equal(result.entry.publicShare?.id, entry.publicShare.id);
            assert.equal(result.entry.lifecycleRevision, entry.lifecycleRevision);
            snapshotsReturned += Number(result.entry.skillsSnapshot !== undefined);
          }
          return snapshotsReturned;
        };
        await run("full", 20);
        await run("list", 20);
        for (const mode of ["timing", "allocation"] as const) {
          for (let pair = 0; pair < 5; pair++) {
            const order =
              pair % 2 === 0 ? (["full", "list"] as const) : (["list", "full"] as const);
            for (const arm of order) {
              gc();
              if (mode === "allocation") {
                await inspector.post("HeapProfiler.startSampling", {
                  samplingInterval: 4_096,
                  includeObjectsCollectedByMajorGC: true,
                  includeObjectsCollectedByMinorGC: true,
                });
              }
              const hostLoad = loadavg();
              const cpu = process.threadCpuUsage();
              const started = performance.now();
              const snapshotsReturned = await run(arm, iterations);
              const elapsedMs = performance.now() - started;
              const used = process.threadCpuUsage(cpu);
              const allocationBytes =
                mode === "allocation"
                  ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
                  : undefined;
              results.push({
                cohort: cohort.name,
                mode,
                pair,
                arm,
                iterations,
                elapsedMs,
                mainThreadCpuMs: (used.user + used.system) / 1_000,
                allocationBytes,
                snapshotsReturned,
                hostLoad,
              });
            }
          }
        }
      }
      console.log(
        JSON.stringify(
          {
            node: process.version,
            snapshotBytes: Buffer.byteLength(JSON.stringify(entry.skillsSnapshot)),
            scope: "replica publication plus admitted read; main thread only",
            results,
          },
          null,
          2,
        ),
      );
    } finally {
      await databaseClaim.release();
    }
  });
} finally {
  inspector.disconnect();
}
