import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../context-engine/legacy.js";
import { registerContextEngineInRegistry } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../plugins/registry-inspection.test-support.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { waitForDeferredTurnMaintenanceForSession } from "../embedded-agent-runner/context-engine-maintenance.js";
import { createContextEngineLogicalTurnLease } from "./context-engine-logical-turn.js";
import {
  finalizeAcceptedContextEngineTurn,
  type ContextEngineTurnAttemptFacts,
} from "./context-engine-turn-attempt.js";
import { enqueueContextEngineTurnIntent } from "./context-engine-turn-outbox.js";

const unchanged = { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
let fixtureSequence = 0;

// Exercise real accepted-turn persistence and scheduling with a supplying resource
// whose usability proves that engine retirement did not outrun maintenance.
async function withAcceptedTurn(
  outcome: "committed" | "duplicate" | "failed",
  maintenanceFails: boolean,
  run: (fixture: Awaited<ReturnType<typeof createAcceptedTurn>>) => Promise<void>,
  maintenanceInfo: Pick<ContextEngine["info"], "turnMaintenanceMode"> = {
    turnMaintenanceMode: "background",
  },
) {
  await withStateDirEnv("openclaw-accepted-turn-maintenance-", async ({ stateDir }) => {
    resetCommandQueueStateForTest();
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    const fixture = await createAcceptedTurn(stateDir, outcome, maintenanceFails, maintenanceInfo);
    try {
      await run(fixture);
    } finally {
      fixture.releaseMaintenance.resolve();
      await waitForDeferredTurnMaintenanceForSession(fixture.facts.sessionKey);
      await fixture.lease.dispose();
      await fixture.source.release();
      await fixture.sourceDisposed.promise;
      resetCommandQueueStateForTest();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
}

// Each fixture has a distinct registration so a deliberately failed hook's
// quarantine cannot change another case's selected engine.
async function createAcceptedTurn(
  stateDir: string,
  outcome: "committed" | "duplicate" | "failed",
  maintenanceFails: boolean,
  maintenanceInfo: Pick<ContextEngine["info"], "turnMaintenanceMode">,
) {
  const engineId = `accepted-maintenance-${fixtureSequence++}`;
  const target = {
    agentId: "main",
    sessionId: engineId,
    sessionKey: `agent:main:${engineId}`,
    storePath: path.join(stateDir, "sessions.json"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const admitted = await appendTranscriptMessage(target, {
    message: { role: "user", content: "Synthetic question" },
    now: 1_000,
  });
  const terminal = await appendTranscriptMessage(target, {
    message: { role: "assistant", content: "Synthetic answer" },
    parentId: admitted?.messageId,
    now: 2_000,
  });
  if (!admitted?.anchor || !terminal?.anchor) {
    throw new Error("Expected a durable accepted transcript range");
  }
  const admission = {
    ...admitted.anchor,
    logicalTurnId: `${engineId}-turn`,
    role: "user" as const,
  };
  const database = openOpenClawAgentDatabase({ agentId: "main", path: admission.storePath });
  const facts: ContextEngineTurnAttemptFacts = {
    boundary: { admission, terminal: terminal.anchor },
    sessionIdUsed: target.sessionId,
    sessionKey: target.sessionKey,
    sessionTarget: target,
    promptError: false,
    aborted: false,
    yieldAborted: false,
    runtimeContext: { provider: "fixture", modelId: "fixture-model", tokenBudget: 1_000 },
  };

  // The logical lease must retain this database after its supplying inspection
  // retires, including while deferred maintenance is waiting on external work.
  const probe = new DatabaseSync(path.join(stateDir, "engine-resource.sqlite"));
  const source = new PluginRegistryInspectionResources(retireInspectionInstances);
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    createPluginRecord({ id: engineId, source: path.join(stateDir, "plugin") }),
  );
  source.attach(registry);
  const sourceDisposed = createDeferredCore();
  source.register(engineId, {
    id: "probe",
    dispose() {
      probe.close();
      sourceDisposed.resolve();
    },
  });
  const releaseMaintenance = createDeferredCore();
  const maintenanceStarted = createDeferredCore();
  const events: string[] = [];
  const resourceReads: unknown[] = [];
  const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => {
    events.push("commit");
    if (outcome === "failed") {
      throw new Error("Synthetic commit failure");
    }
    return { status: outcome };
  });
  const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async () => {
    events.push("maintenance-started");
    resourceReads.push(probe.prepare("SELECT 42 AS value").get()?.value);
    maintenanceStarted.resolve();
    await releaseMaintenance.promise;
    resourceReads.push(probe.prepare("SELECT 42 AS value").get()?.value);
    events.push("maintenance-settled");
    if (maintenanceFails) {
      throw new Error("Synthetic maintenance failure");
    }
    return unchanged;
  });
  const dispose = vi.fn(async () => {
    resourceReads.push(probe.prepare("SELECT 42 AS value").get()?.value);
    events.push("engine-disposed");
  });
  const engine: ContextEngine = {
    info: {
      id: engineId,
      name: "Accepted maintenance fixture",
      ...maintenanceInfo,
      transcriptSemantics: {
        currentTurnFence: "before-current-turn-entry-v1",
        turnAdvancementIdempotency: "atomic-idempotent-v1",
      },
    },
    ingest: async () => ({ ingested: true }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: true, compacted: false }),
    commitTurn,
    maintain,
    dispose,
  };
  registerContextEngineInRegistry(registry, "legacy", () => new LegacyContextEngine(), "core");
  source.runRegistration(engineId, () => {
    registerContextEngineInRegistry(registry, engineId, () => engine, `plugin:${engineId}`);
  });
  const config = {
    plugins: { slots: { contextEngine: engineId } },
    session: { store: target.storePath },
  };
  const lease = await withPluginRuntimeRegistryScope(registry, () =>
    createContextEngineLogicalTurnLease({
      identity: { runId: `${engineId}-run`, sessionId: target.sessionId },
      config,
    }),
  );
  lease.begin();
  enqueueContextEngineTurnIntent({
    admission,
    database,
    engineId: lease.effectiveEngineId,
    ownerPluginId: lease.effectiveEnginePluginId,
    isHeartbeat: false,
  });
  await source.release();
  const pendingTurn = () =>
    database.db
      .prepare("SELECT attempt_count FROM context_engine_turn_outbox WHERE advancement_key = ?")
      .get(admission.logicalTurnId);
  return {
    facts,
    lease,
    config,
    source,
    sourceDisposed,
    probe,
    releaseMaintenance,
    maintenanceStarted,
    commitTurn,
    maintain,
    dispose,
    events,
    resourceReads,
    pendingTurn,
  };
}

describe("durable accepted-turn maintenance handoff", () => {
  it.each(["foreground", undefined] as const)(
    "awaits %s maintenance with durable runtime capabilities",
    async (turnMaintenanceMode) => {
      await withAcceptedTurn(
        "committed",
        false,
        async (fixture) => {
          const finalized = finalizeAcceptedContextEngineTurn(fixture).then(() => {
            fixture.events.push("finalized");
            return "finalized";
          });
          try {
            expect(
              await Promise.race([
                fixture.maintenanceStarted.promise.then(() => "maintenance"),
                finalized,
              ]),
            ).toBe("maintenance");
            expect(fixture.pendingTurn()).toBeUndefined();
            const runtimeContext = fixture.maintain.mock.calls[0]?.[0].runtimeContext;
            expect(runtimeContext).toMatchObject({
              ...fixture.facts.runtimeContext,
              sessionTarget: {
                ...fixture.facts.sessionTarget,
                storePath: fixture.facts.boundary.admission.storePath,
              },
              llm: { complete: expect.any(Function) },
              rewriteTranscriptEntries: expect.any(Function),
            });
            expect(runtimeContext?.allowDeferredCompactionExecution).toBeUndefined();
            // Reopen the durable target through the supplied capability while the
            // finalizer is waiting; no live SessionManager or rewrite lock is supplied.
            expect(await runtimeContext?.rewriteTranscriptEntries?.({ replacements: [] })).toEqual({
              ...unchanged,
              reason: "no replacements requested",
            });
            expect(fixture.events).toEqual(["commit", "maintenance-started"]);
            expect(fixture.probe.isOpen).toBe(true);
          } finally {
            fixture.releaseMaintenance.resolve();
            await finalized;
          }
          await fixture.lease.dispose();
          await fixture.sourceDisposed.promise;
          expect(fixture.events).toEqual([
            "commit",
            "maintenance-started",
            "maintenance-settled",
            "finalized",
            "engine-disposed",
          ]);
          expect(fixture.resourceReads).toEqual([42, 42, 42]);
        },
        { turnMaintenanceMode },
      );
    },
  );

  it.each([
    { outcome: "committed", maintenanceFails: false },
    { outcome: "duplicate", maintenanceFails: false },
    { outcome: "committed", maintenanceFails: true },
    { outcome: "duplicate", maintenanceFails: true },
  ] as const)(
    "returns before maintenance settles and retains resources ($outcome, failure=$maintenanceFails)",
    async ({ outcome, maintenanceFails }) => {
      await withAcceptedTurn(outcome, maintenanceFails, async (fixture) => {
        await finalizeAcceptedContextEngineTurn(fixture);
        expect(fixture.commitTurn).toHaveBeenCalledOnce();
        expect(fixture.pendingTurn()).toBeUndefined();
        // No second user turn or explicit scheduler invocation starts the work.
        const maintenanceResult = await Promise.race([
          fixture.maintenanceStarted.promise.then(() => "started"),
          waitForDeferredTurnMaintenanceForSession(fixture.facts.sessionKey).then(() => "settled"),
        ]);
        expect(maintenanceResult).toBe("started");
        expect(fixture.maintain).toHaveBeenCalledOnce();
        expect(fixture.maintain.mock.calls[0]?.[0]).toMatchObject({
          sessionId: fixture.facts.sessionIdUsed,
          sessionKey: fixture.facts.sessionKey,
          runtimeContext: {
            ...fixture.facts.runtimeContext,
            allowDeferredCompactionExecution: true,
          },
        });
        await fixture.lease.dispose();
        expect(fixture.dispose).not.toHaveBeenCalled();
        expect(fixture.probe.isOpen).toBe(true);
        expect(fixture.events).toEqual(["commit", "maintenance-started"]);

        fixture.releaseMaintenance.resolve();
        await waitForDeferredTurnMaintenanceForSession(fixture.facts.sessionKey);
        await fixture.sourceDisposed.promise;
        expect(fixture.events).toEqual([
          "commit",
          "maintenance-started",
          "maintenance-settled",
          "engine-disposed",
        ]);
        expect(fixture.resourceReads).toEqual([42, 42, 42]);
        expect(fixture.dispose).toHaveBeenCalledOnce();
        expect(fixture.probe.isOpen).toBe(false);
        expect(fixture.pendingTurn()).toBeUndefined();
      });
    },
  );

  it.each(["commit-failed", "aborted", "promptError", "yieldAborted"] as const)(
    "does not schedule maintenance for %s",
    async (failure) => {
      await withAcceptedTurn(
        failure === "commit-failed" ? "failed" : "committed",
        false,
        async (fixture) => {
          const facts =
            failure === "commit-failed" ? fixture.facts : { ...fixture.facts, [failure]: true };
          await finalizeAcceptedContextEngineTurn({ ...fixture, facts, warn: () => {} });
          await fixture.lease.dispose();
          await waitForDeferredTurnMaintenanceForSession(fixture.facts.sessionKey);
          expect(fixture.maintain).not.toHaveBeenCalled();
          expect(fixture.dispose).toHaveBeenCalledOnce();
          expect(fixture.commitTurn).toHaveBeenCalledTimes(failure === "commit-failed" ? 1 : 0);
          if (failure === "commit-failed") {
            expect(fixture.pendingTurn()).toMatchObject({ attempt_count: 1 });
          } else {
            expect(fixture.pendingTurn()).toBeUndefined();
          }
        },
      );
    },
  );
});
