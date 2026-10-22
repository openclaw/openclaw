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
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { waitForSessionMaintenance } from "../session-maintenance/coordinator.js";
import { SessionManager } from "../sessions/index.js";
import { createMaintenanceEngine } from "./context-engine-maintenance.fixtures.test-support.js";
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
      owners.openAsync.mockRestore();
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
    openAsync: vi.spyOn(SessionManager, "openAsync"),
    runMaintenance(maintain: Maintain, overrides: Partial<ContextEngineMaintenanceParams> = {}) {
      const run = runContextEngineMaintenance({
        ...target,
        sessionTarget: target,
        sessionFile: `in-memory:${memory.getSessionId()}`,
        reason: "turn",
        contextEngine: createMaintenanceEngine(maintain, {
          info: { id: "ownership-test", name: "Ownership test", turnMaintenanceMode: "background" },
        }),
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

it("joins caller memory rewrite despite an explicit background request", async () => {
  await withTranscriptOwners(async (owner) => {
    const manager = SessionManager.fromEntries(owner.memory.getPersistedEntries());
    const events: string[] = [];
    const maintain = vi.fn<Maintain>(async (params) => {
      await owner.release.promise;
      expect.soft(params.runtimeContext?.allowDeferredCompactionExecution).toBeUndefined();
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
          try {
            return await operation();
          } finally {
            events.push("unlocked");
          }
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
    await Promise.all(owner.deferred);
    expect.soft(result).toMatchObject({ changed: true, rewrittenEntries: 1 });
    expect
      .soft(manager.getBranch().map((entry) => entry.type === "message" && entry.message))
      .toEqual([replacement, tail]);
    expect.soft(events).toEqual(["locked", "unlocked", "maintained", "returned"]);
    expect.soft(owner.openAsync).not.toHaveBeenCalled();
    expect.soft(owner.published).not.toHaveBeenCalled();
    expect.soft(await loadTranscriptEvents(owner.target)).toEqual(owner.durableBefore);
    expect.soft(owner.deferred).toHaveLength(0);
  });
});

it.each([undefined, "background"] as const)(
  "reopens and publishes durable background rewrites with executionMode=%s",
  async (executionMode) => {
    await withTranscriptOwners(async (owner) => {
      const lock = vi.fn();
      await owner.runMaintenance(
        async (params) => {
          expect(params.runtimeContext?.allowDeferredCompactionExecution).toBe(true);
          return await owner.rewrite(params);
        },
        {
          executionMode,
          sessionManager: owner.durable,
          withSessionManagerRewriteLock: async (operation) => {
            lock();
            return await operation();
          },
        },
      );
      await Promise.all(owner.deferred);
      expect(owner.openAsync).toHaveBeenCalledOnce();
      expect(lock).not.toHaveBeenCalled();
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

it("does not coalesce or wait for foreign durable work despite an explicit background request", async ({
  signal,
}) => {
  await withTranscriptOwners(async (owner) => {
    const foreignStarted = createDeferredCore();
    const foreignMaintain = vi.fn(async () => {
      foreignStarted.resolve();
      await owner.release.promise;
      return unchanged;
    });
    await owner.runMaintenance(foreignMaintain, { sessionManager: owner.durable });
    await racePromiseWithAbortSignal(
      Promise.race([foreignStarted.promise, ...owner.deferred]),
      signal,
    );
    expect(foreignMaintain).toHaveBeenCalledOnce();
    const maintain = vi.fn(async () => unchanged);
    const run = owner.runMaintenance(maintain, {
      executionMode: "background",
      sessionManager: owner.memory,
    });
    await expect(run).resolves.toMatchObject({ changed: false });
    expect(maintain).toHaveBeenCalledOnce();
    expect(owner.deferred).toHaveLength(1);
  });
});

it("checks caller memory authority before rewriting after the awaited lock", async () => {
  await withTranscriptOwners(async (owner) => {
    const before = structuredClone(owner.memory.getPersistedEntries());
    const entered = vi.fn();
    const controller = new AbortController();
    const closed = new Error("caller maintenance owner closed");
    let active = true;
    const run = owner.runMaintenance(
      async (params) => {
        expect(params.abortSignal).toBe(controller.signal);
        return await owner.rewrite(params);
      },
      {
        executionMode: "background",
        sessionManager: owner.memory,
        abortSignal: controller.signal,
        assertActive: () => {
          controller.signal.throwIfAborted();
          if (!active) {
            throw closed;
          }
        },
        withSessionManagerRewriteLock: async (operation) => {
          entered();
          await owner.release.promise;
          return await operation();
        },
      },
    );
    const outcome = run.catch((error: unknown) => error);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    active = false;
    owner.release.resolve();
    expect(await outcome).toBe(closed);
    expect(owner.memory.getPersistedEntries()).toEqual(before);
    expect(await loadTranscriptEvents(owner.target)).toEqual(owner.durableBefore);
  });
});
