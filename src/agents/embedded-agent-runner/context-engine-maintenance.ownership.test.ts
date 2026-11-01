import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { waitForSessionMaintenance } from "../session-maintenance/coordinator.js";
import { SessionManager } from "../sessions/index.js";
import {
  createBackgroundMaintenanceEngine,
  createMaintenanceGate,
} from "./context-engine-maintenance.fixtures.test-support.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import type { ContextEngineMaintenanceParams } from "./context-engine-maintenance.types.js";

vi.mock("./context-engine-capabilities.js", () => ({
  resolveContextEngineCapabilities: () => ({}),
}));

const user = (content: string, timestamp = 1) => ({ role: "user" as const, content, timestamp });
const replacement = user("rewritten memory");
const tail = user("memory tail", 2);
const unchanged = { changed: false, rewrittenEntries: 0, bytesFreed: 0 };
type Maintain = NonNullable<ContextEngine["maintain"]>;

async function withTranscriptOwners(
  run: (owners: Awaited<ReturnType<typeof createTranscriptOwners>>) => Promise<void>,
) {
  await withStateDirEnv("openclaw-maintenance-owners-", async ({ stateDir }) => {
    resetCommandQueueStateForTest();
    const owners = await createTranscriptOwners(stateDir);
    try {
      await run(owners);
    } finally {
      owners.release.resolve();
      await Promise.allSettled([...owners.runs, ...owners.deferred]);
      await waitForSessionMaintenance(owners.target.sessionKey);
      owners.unsubscribe();
      resetCommandQueueStateForTest();
    }
  });
}

async function createTranscriptOwners(stateDir: string) {
  const memory = SessionManager.inMemory(stateDir);
  const entryId = expectDefined(
    await memory.appendMessageAsync(user("memory ".repeat(40))),
    "memory owner entry id",
  );
  await memory.appendMessageAsync(tail);
  const identity = {
    agentId: "main",
    sessionId: memory.getSessionId(),
    sessionKey: "agent:main:maintenance-owner",
  };
  const target = { ...identity, storePath: path.join(stateDir, "sessions.json") };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
  // Matching IDs model copied history; ownership must not be inferred from identity.
  const durableEntries = structuredClone(memory.getEntries());
  for (const entry of durableEntries) {
    if (entry.type === "message") {
      entry.message = user("durable-only sentinel");
    }
  }
  await replaceTranscriptEvents(target, [memory.getHeader(), ...durableEntries]);
  const durable = await SessionManager.openAsync(target, stateDir);
  const durableBefore = await loadTranscriptEvents(target);
  const deferred: Promise<void>[] = [];
  const runs: Promise<unknown>[] = [];
  const published = vi.fn();
  const unsubscribe = onSessionTranscriptUpdate(published);
  return {
    memory,
    durable,
    durableBefore,
    identity,
    target,
    release: createDeferredCore(),
    deferred,
    runs,
    published,
    unsubscribe,
    runMaintenance(maintain: Maintain, overrides: Partial<ContextEngineMaintenanceParams> = {}) {
      const run = runContextEngineMaintenance({
        ...target,
        sessionTarget: target,
        sessionFile: `in-memory:${memory.getSessionId()}`,
        reason: "turn",
        contextEngine: createBackgroundMaintenanceEngine(maintain),
        onDeferredMaintenance: (promise) => deferred.push(promise),
        ...overrides,
      });
      runs.push(run);
      return run;
    },
    rewrite: (({ runtimeContext }) =>
      runtimeContext!.rewriteTranscriptEntries!({
        replacements: [{ entryId, message: replacement }],
      })) satisfies Maintain,
  };
}

it("joins caller memory rewrite without coalescing with or awaiting foreign durable work", async () => {
  await withTranscriptOwners(async (owner) => {
    using foreign = createMaintenanceGate();
    await owner.runMaintenance(() => foreign.run(() => unchanged), {
      sessionManager: owner.durable,
    });
    await foreign.entered.promise;
    const manager = SessionManager.fromEntries(owner.memory.getPersistedEntries());
    const events: string[] = [];
    const maintain = vi.fn<Maintain>(async (params) => {
      await owner.release.promise;
      const result = await owner.rewrite(params);
      events.push("maintained");
      return result;
    });
    const run = owner
      .runMaintenance(maintain, {
        executionMode: "background",
        sessionManager: manager,
        withSessionManagerRewriteLock: async (operation) => {
          events.push("locked");
          const result = await operation();
          events.push("unlocked");
          return result;
        },
      })
      .then((result) => {
        events.push("returned");
        return result;
      });
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledOnce());
    await setImmediate();
    expect.soft(events).not.toContain("returned");
    owner.release.resolve();
    const result = await run;
    expect.soft(result).toMatchObject({ changed: true, rewrittenEntries: 1 });
    expect
      .soft(manager.getBranch().map((entry) => entry.type === "message" && entry.message))
      .toEqual([replacement, tail]);
    expect.soft(events).toEqual(["locked", "unlocked", "maintained", "returned"]);
    expect.soft(owner.published).not.toHaveBeenCalled();
    expect.soft(await loadTranscriptEvents(owner.target)).toEqual(owner.durableBefore);
    expect.soft(owner.deferred).toHaveLength(1);
  });
});

it.each([undefined, "background"] as const)(
  "reopens and publishes durable background rewrites with executionMode=%s",
  async (executionMode) => {
    await withTranscriptOwners(async (owner) => {
      await owner.runMaintenance(owner.rewrite, {
        executionMode,
        sessionManager: owner.durable,
        withSessionManagerRewriteLock: async () => {
          throw new Error("durable background rewrite must not borrow caller's lock");
        },
      });
      await Promise.all(owner.deferred);
      expect(owner.published).toHaveBeenCalledExactlyOnceWith({
        ...owner.identity,
        target: owner.identity,
      });
      expect((await SessionManager.openAsync(owner.target)).getBranch()[0]).toMatchObject({
        message: replacement,
      });
      expect(owner.durable.getBranch()[0]).toMatchObject({
        message: { content: "durable-only sentinel" },
      });
      expect(owner.deferred).toHaveLength(executionMode ? 0 : 1);
    });
  },
);

it("checks caller memory authority before rewriting after the awaited lock", async () => {
  await withTranscriptOwners(async (owner) => {
    const before = structuredClone(owner.memory.getPersistedEntries());
    const entered = vi.fn();
    const closed = new Error("caller maintenance owner closed");
    let active = true;
    const run = owner.runMaintenance(owner.rewrite, {
      executionMode: "background",
      sessionManager: owner.memory,
      assertActive: () => {
        if (!active) {
          throw closed;
        }
      },
      withSessionManagerRewriteLock: async (operation) => {
        entered();
        await owner.release.promise;
        return await operation();
      },
    });
    const outcome = run.catch((error: unknown) => error);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    active = false;
    owner.release.resolve();
    expect(await outcome).toBe(closed);
    expect(owner.memory.getPersistedEntries()).toEqual(before);
    expect(await loadTranscriptEvents(owner.target)).toEqual(owner.durableBefore);
  });
});
