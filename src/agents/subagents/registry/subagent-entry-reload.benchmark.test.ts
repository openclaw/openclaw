import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { listSessionEntriesReadOnly } from "../../../config/sessions/session-accessor.sqlite-entry-list.read.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { runOpenClawAgentWriteTransaction } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { buildActiveSubagentRuntimeContext } from "./subagent-active-context.js";
import { buildControlledSubagentRunsReadContext } from "./subagent-control-scope.js";
import { readSubagentListSessionEntries } from "./subagent-list.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRecoverySession } from "./subagent-registry-restart-recovery-session.js";
import { persistRegistryFixture } from "./subagent-registry-state.fixture.test-support.js";
import {
  clearSubagentRunsReadCacheForTest,
  withSubagentRunReadSnapshot,
} from "./subagent-registry-state.js";

const { counters, resetCounters } = vi.hoisted(() => {
  const empty = {
    fullLoads: 0,
    fullLoadMs: 0,
    parsedEntries: 0,
    parsedJsonBytes: 0,
    fixtureJsonParses: 0,
    fixtureJsonBytes: 0,
  };
  const state = { active: false, metrics: { ...empty } };
  return { counters: state, resetCounters: () => (state.metrics = { ...empty }) };
});

vi.mock(
  "../../../config/sessions/session-accessor.sqlite-entry-cache-projection.js",
  async (load) => {
    const actual =
      await load<
        typeof import("../../../config/sessions/session-accessor.sqlite-entry-cache-projection.js")
      >();
    return {
      ...actual,
      loadSessionEntrySnapshot: (...args: Parameters<typeof actual.loadSessionEntrySnapshot>) => {
        if (!counters.active) {
          return actual.loadSessionEntrySnapshot(...args);
        }
        const start = performance.now();
        counters.metrics.fullLoads++;
        try {
          return actual.loadSessionEntrySnapshot(...args);
        } finally {
          counters.metrics.fullLoadMs += performance.now() - start;
        }
      },
    };
  },
);

vi.mock("../../../config/sessions/session-accessor.sqlite-status.js", async (load) => {
  const actual =
    await load<typeof import("../../../config/sessions/session-accessor.sqlite-status.js")>();
  return {
    ...actual,
    parseSessionEntryJson: (...args: Parameters<typeof actual.parseSessionEntryJson>) => {
      if (counters.active) {
        counters.metrics.parsedEntries++;
        counters.metrics.parsedJsonBytes += Buffer.byteLength(args[0].entry_json);
      }
      return actual.parseSessionEntryJson(...args);
    },
  };
});

// Opt-in allocation proof; the ordinary prompt suite owns the CI regression.
it.runIf(process.env.OPENCLAW_ENTRY_RELOAD_BENCH === "1")(
  "profiles admission and active-child context across a 5,000-session write workload",
  () =>
    withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const rows = 5_000;
        const turns = 10;
        const cfg = {};
        const controllerSessionKey = "agent:main:main";
        const owner = { agentId: "main", sessionKey: controllerSessionKey };
        const storePath = resolvePhysicalSessionStorePath(owner, cfg);
        const mainScope = { ...owner, storePath };
        const updateChild = (sessionKey: string, update: (entry: SessionEntry) => SessionEntry) =>
          applySessionEntryExactReplacements({
            agentId: "main",
            storePath,
            sessionKeys: [sessionKey],
            update: ([row]) => ({
              result: undefined,
              replacements: [{ sessionKey, entry: update(row!.entry) }],
            }),
          });
        const now = Date.now();
        const metadataPayload = "m".repeat(4_096);
        const savedPrompt = "p".repeat(8_192);
        const parseJson = JSON.parse;
        subagentRuns.clear();
        clearSubagentRunsReadCacheForTest();
        runOpenClawAgentWriteTransaction(
          () => {
            for (let index = 0; index < rows; index++) {
              replaceSessionEntrySync(
                {
                  ...mainScope,
                  sessionKey: index === 0 ? controllerSessionKey : `agent:main:fixture-${index}`,
                },
                {
                  sessionId: index === 0 ? "main-fixture" : `fixture-${index}`,
                  updatedAt: now - index,
                  label: `Fixture session ${index} ${metadataPayload}`,
                  skillsSnapshot: { prompt: savedPrompt, skills: [] },
                },
              );
            }
          },
          { agentId: "main", path: storePath },
        );

        const inspector = new Session();
        inspector.connect();
        const samples: Array<Record<string, string | number>> = [];
        const measure = async <T>(phase: string, iteration: number, run: () => T | Promise<T>) => {
          resetCounters();
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 32 * 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          const heapBefore = process.memoryUsage().heapUsed;
          const cpu = process.threadCpuUsage();
          const start = performance.now();
          counters.active = true;
          let value: T;
          try {
            value = await run();
          } finally {
            counters.active = false;
          }
          const wallMs = performance.now() - start;
          const elapsed = process.threadCpuUsage(cpu);
          const heapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          const allocationBytes = (node: typeof profile.head): number =>
            node.selfSize + node.children.reduce((sum, child) => sum + allocationBytes(child), 0);
          samples.push({
            phase,
            iteration,
            wallMs,
            mainThreadCpuMs: (elapsed.user + elapsed.system) / 1_000,
            heapDeltaBytes,
            sampledAllocationBytes: allocationBytes(profile.head),
            ...counters.metrics,
          });
          return value;
        };
        // A forwarding wrapper counts parsing without retaining every JSON argument/result.
        JSON.parse = (text, reviver) => {
          if (counters.active && typeof text === "string" && text.includes(metadataPayload)) {
            counters.metrics.fixtureJsonParses++;
            counters.metrics.fixtureJsonBytes += Buffer.byteLength(text);
          }
          return parseJson(text, reviver);
        };
        try {
          // Warm admission separately so validation cannot lend pre-parsed rows to the control.
          listSessionEntriesReadOnly({ ...mainScope, projection: "list" });
          const listed = await measure("full-list-cold-control", 0, () =>
            listSessionEntriesReadOnly({
              ...mainScope,
              projection: "list",
              readConsistency: "latest",
            }),
          );
          expect(listed).toHaveLength(rows);
          expect(counters.metrics.fullLoads).toBe(1);
          expect(counters.metrics.parsedEntries).toBeGreaterThanOrEqual(rows);

          for (let iteration = 0; iteration < turns; iteration++) {
            const childSessionKey = `agent:main:subagent:benchmark-${iteration}`;
            const run = createSubagentRunRecord({
              runId: `benchmark-run-${iteration}`,
              childSessionKey,
              requesterAgentId: "main",
              controllerSessionKey,
              requesterStorePath: storePath,
              controllerStorePath: storePath,
              taskName: `fixture_${iteration}`,
              createdAt: now + iteration,
              execution: { status: "running", startedAt: now + iteration },
              delivery: { status: "not_required" },
            });
            const childScope = { ...mainScope, sessionKey: childSessionKey };
            const entry = {
              sessionId: run.runId,
              updatedAt: now + iteration,
              abortedLastRun: true,
              model: "saved-fixture-model",
            };
            // Worker status publication invalidates snapshots retained on the host connection.
            replaceSessionEntrySync(childScope, { ...entry, status: "done" });
            subagentRuns.set(run.runId, run);
            persistRegistryFixture(subagentRuns, [run.runId]);
            await updateChild(childSessionKey, () => ({ ...entry, status: undefined }));

            const prompt = await measure("turn-prompt", iteration, () =>
              buildActiveSubagentRuntimeContext({ cfg, controllerSessionKey }),
            );
            expect(prompt).toContain(`session=${childSessionKey}`);
            expect(prompt).toContain(`taskName_json="fixture_${iteration}"`);
            expect(counters.metrics.fullLoads).toBe(0);
            expect(counters.metrics.parsedEntries).toBeLessThanOrEqual(3);
            await measure("registry-snapshot-only", iteration, () =>
              withSubagentRunReadSnapshot(
                subagentRuns,
                () => ({ runIds: [], sessionKeys: [controllerSessionKey] }),
                (_selection, snapshot) => snapshot.size,
                { sessionKeys: [controllerSessionKey], descendants: false },
              ),
            );
            const recovery = await measure("restart-recovery-session", iteration, () =>
              loadSubagentRecoverySession({ entry: run, isOwnerCurrent: () => true }),
            );
            expect(recovery?.sessionEntry?.sessionId).toBe(run.runId);

            const context = await buildControlledSubagentRunsReadContext(
              controllerSessionKey,
              "main",
              cfg,
            );
            // Give the user-facing metadata read its own committed invalidation after the prompt.
            await updateChild(childSessionKey, (row) => ({
              ...row,
              label: `Changed child ${iteration}`,
            }));
            const metadata = await measure("subagent-list-selected", iteration, () =>
              readSubagentListSessionEntries(cfg, context.list),
            );
            expect(metadata.get(run.runId)?.model).toBe("saved-fixture-model");
            expect(counters.metrics).toMatchObject({ fullLoads: 0, parsedEntries: 0 });
          }
          console.log(
            JSON.stringify({
              benchmark: "session-entry-reload",
              rows,
              turns,
              metadataPayloadBytes: metadataPayload.length,
              savedPromptBytes: savedPrompt.length,
              samples,
            }),
          );
        } finally {
          counters.active = false;
          JSON.parse = parseJson;
          inspector.disconnect();
          subagentRuns.clear();
          clearSubagentRunsReadCacheForTest();
        }
      },
    ),
);
