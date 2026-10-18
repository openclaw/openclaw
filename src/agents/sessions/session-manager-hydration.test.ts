import fs from "node:fs";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import * as configEnv from "../../config/config-env-vars.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { historyLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { SessionManager, type SessionEntry } from "../../plugin-sdk/agent-sessions.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { recordOpenClawAgentDatabaseOpenFailure } from "../../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  clearOpenClawAgentDatabaseOpenFailure,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";

function canonicalTarget(
  state: OpenClawTestState,
  sessionId: string,
  sessionKey = `agent:main:${sessionId}`,
) {
  return {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
}

async function seedHistory(target: ReturnType<typeof canonicalTarget>, text: string) {
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  return SessionManager.open(target).appendMessage(makeUserMessage(text, 1));
}

function expectMessages(manager: SessionManager, ...messages: unknown[]) {
  expect(manager.buildSessionContext().messages).toEqual(messages);
}

function pauseRead(
  pool: Pick<WorkerTaskPool<unknown, unknown>, "run">,
  at: "request" | "reply",
  inspect?: (request: unknown) => void,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const spy = vi.spyOn(pool, "run").mockImplementationOnce(function (
    this: Pick<WorkerTaskPool<unknown, unknown>, "run">,
    input,
    options,
  ) {
    spy.mockRestore();
    const pause = async () => {
      entered.resolve();
      await release.promise;
    };
    const reading = this.run(async () => {
      if (at === "request") {
        await pause();
      }
      const request = typeof input === "function" ? await input() : input;
      inspect?.(request);
      return request;
    }, options);
    if (at === "reply") {
      return reading.then(async (result) => {
        await pause();
        return result;
      });
    }
    return reading;
  });
  return {
    release: () => release.resolve(),
    restore: () => spy.mockRestore(),
    wait: (pending: Promise<unknown>, message: string) =>
      Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error(message);
        }),
      ]),
  };
}

it.each(["canonical", "shared"])(
  "opens cold and bounded %s SDK views without host SQLite and preserves complete durable history",
  async (layout) => {
    await withOpenClawTestState({ label: "session-hydration" }, async (state) => {
      const target = canonicalTarget(state, "hydration");
      if (layout === "shared") {
        Object.assign(target, {
          agentId: "worker",
          sessionKey: "agent:worker:hydration",
          storePath: state.path("shared.sqlite"),
        });
      }
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const source = SessionManager.open(target, "/stored");
      for (let index = 0; index < 12; index++) {
        source.appendMessage(makeUserMessage(`message ${index}`, index));
      }
      await waitForSessionTranscriptProjection(target);
      const expected = source.getPersistedEntries();
      const limits = { maxBytes: 4096, maxEvents: 3 };
      const expectedBounded = SessionManager.openBounded(target, limits).buildSessionContext();
      const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
      const statement = Object.getPrototypeOf(database.db.prepare("SELECT 1")) as StatementSync;
      const probes = [
        vi.spyOn(statement, "all"),
        vi.spyOn(statement, "get"),
        vi.spyOn(statement, "run"),
        vi.spyOn(statement, "iterate"),
        vi.spyOn(Object.getPrototypeOf(database.db), "exec"),
        vi.spyOn(Object.getPrototypeOf(database.db), "prepare"),
      ];
      try {
        SessionManager.open(target);
        expect(probes.some((probe) => probe.mock.calls.length > 0)).toBe(true);
        await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        probes.forEach((probe) => probe.mockClear());
        const cold = await SessionManager.openAsync(target, "/runtime");
        expect(cold.getPersistedEntries()).toEqual(expected);
        expect(cold.getCwd()).toBe("/runtime");
        const truncated = vi.fn();
        const bounded = await SessionManager.openBoundedAsync(target, {
          ...limits,
          onTruncated: truncated,
        });
        expect(truncated).toHaveBeenCalledOnce();
        expect(bounded.buildSessionContext()).toEqual(expectedBounded);
        const detached = await SessionManager.openDetachedBoundedAsync(target, limits);
        expect(detached.isPersisted()).toBe(false);
        expect(detached.buildSessionContext()).toEqual(expectedBounded);
        detached.appendMessage(makeUserMessage("detached only", 20));
        expect(probes.flatMap((probe) => probe.mock.calls)).toEqual([]);
        // Warm admission must use the requested lane, not the cold reader's reserved-lane fallback.
        const warm = openOpenClawAgentDatabase({ agentId: database.agentId, path: database.path });
        expect(warm.db.isOpen).toBe(true);
        probes.forEach((probe) => probe.mockClear());
        const retirementEntered = createDeferredCore();
        const releaseRetirement = createDeferredCore();
        let following: Promise<void> | undefined;
        const waitForWriter = () => {
          following ??= runOpenClawAgentWriteAdmission(
            { agentId: database.agentId, path: database.path },
            () => {},
          );
          retirementEntered.resolve();
          return Promise.race([following, releaseRetirement.promise]);
        };
        const close = vi
          .spyOn(historyLane.pool, "closeResources")
          .mockImplementation(waitForWriter);
        const rotate = vi.spyOn(historyLane.pool, "rotate").mockImplementation(waitForWriter);
        const reloading = runOpenClawAgentWriteAdmission(
          { agentId: database.agentId, path: database.path },
          () => cold.reloadPersistedTranscriptAsync(),
        );
        try {
          await Promise.race([
            reloading,
            retirementEntered.promise.then(() => {
              throw new Error("Manager reload cleanup waits on its own queued writer");
            }),
          ]);
        } finally {
          releaseRetirement.resolve();
          await Promise.allSettled([reloading, following]);
          close.mockRestore();
          rotate.mockRestore();
        }
        expect(cold.getCwd()).toBe("/runtime");
        expect(cold.getPersistedEntries()).toEqual(expected);
        const reader = prepareSessionTranscriptHydration(
          { ...target, sessionKey: target.sessionKey.toUpperCase() },
          limits,
        );
        const { snapshot } = await reader.read();
        const entryId = source.getLeafId()!;
        const request = { entryId, version: snapshot.version, includeEntry: false };
        const anchorOnly = await reader.readCurrentTurnEntry(request);
        expect(anchorOnly.anchor).toMatchObject({
          entryId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
        });
        expect(anchorOnly.event).toBeUndefined();
        const withEntry = await reader.readCurrentTurnEntry({ ...request, includeEntry: true });
        expect(withEntry.anchor).toEqual(anchorOnly.anchor);
        expect(withEntry.event).toEqual(source.getEntry(entryId));
        expect(
          await reader.readCurrentTurnEntry({ ...request, entryId: "missing", includeEntry: true }),
        ).toMatchObject({ version: snapshot.version, anchor: undefined, event: undefined });
        expect(probes.flatMap((probe) => probe.mock.calls)).toEqual([]);
      } finally {
        probes.forEach((probe) => probe.mockRestore());
      }
    });
  },
);

it("preserves the shipped SDK omitted-history option for bounded views", async () => {
  await withSessionState("sdk-omitted-history", async ({ scope: target }) => {
    const source = SessionManager.open(target);
    const userId = source.appendMessage(makeUserMessage("current SDK user", 1));
    const activity = {
      role: "custom" as const,
      customType: "sdk-activity",
      content: "Omitted activity for the current user",
      display: false,
      excludeFromContext: true as const,
      timestamp: 2,
    };
    const activityId = source.appendMessage(activity);
    const bounded = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents: 10 });
    const isActivity = (entry: SessionEntry) =>
      entry.type === "message" &&
      entry.message.role === "custom" &&
      entry.message.customType === "sdk-activity";
    expect(bounded.getEntry(activityId)).toBeUndefined();
    expect(bounded.resolveCurrentTurnEntryId(isActivity)).toBe(activityId);
    expect(
      bounded.resolveCurrentTurnEntryId(isActivity, { includeOmittedCustomMessages: true }),
    ).toBe(userId);
    const unrelatedId = source.appendMessage({ ...activity, customType: "unrelated-activity" });
    bounded.reloadPersistedTranscript();
    expect(
      bounded.resolveCurrentTurnEntryId(isActivity, { includeOmittedCustomMessages: true }),
    ).toBe(unrelatedId);
  });
});

it("pairs current-turn entries with the complete hydrated version and captured prefix in durable storage", async () => {
  await withSessionState("current-turn-version", async ({ scope: target }) => {
    const source = SessionManager.open(target);
    const beforeEntryId = source.appendMessage(makeUserMessage("earlier user", 0));
    const entryId = source.appendMessage(makeUserMessage("current user", 1));
    await waitForSessionTranscriptProjection(target);
    const reader = prepareSessionTranscriptHydration(target, { maxBytes: 4096, maxEvents: 5 });
    const { snapshot } = await reader.read();
    const request = { entryId, version: snapshot.version, includeEntry: true };
    const current = await reader.readCurrentTurnEntry(request);
    expect(current.event).toEqual(source.getEntry(entryId));
    if (!current.anchor) {
      throw new Error("expected current-turn anchor");
    }
    const changedVersions = [
      { ...snapshot.version, generation: "other-generation" },
      { ...snapshot.version, rawSeq: (snapshot.version.rawSeq ?? 0) + 1 },
      { ...snapshot.version, updatedAt: (snapshot.version.updatedAt ?? 0) + 1 },
    ];
    for (const version of changedVersions) {
      await expect(reader.readCurrentTurnEntry({ ...request, version })).rejects.toThrow(
        "changed before replay admission",
      );
    }
    const laterEntryId = source.appendMessage(makeUserMessage("newer user", 2));
    await waitForSessionTranscriptProjection(target);
    await expect(reader.readCurrentTurnEntry(request)).rejects.toThrow(
      "changed before replay admission",
    );
    const fencedReader = runWithSessionTranscriptReadFence(
      { ...current.anchor, logicalTurnId: "current-turn-prefix", role: "user" },
      () => prepareSessionTranscriptHydration(target, { maxBytes: 4096, maxEvents: 5 }),
    );
    const { snapshot: fencedSnapshot } = await fencedReader.read();
    expect(fencedSnapshot.events).toContainEqual(source.getEntry(beforeEntryId));
    expect(fencedSnapshot.events).not.toContainEqual(source.getEntry(entryId));
    const fencedRequest = { ...request, version: fencedSnapshot.version };
    expect(
      (await fencedReader.readCurrentTurnEntry({ ...fencedRequest, entryId: beforeEntryId })).event,
    ).toEqual(source.getEntry(beforeEntryId));
    for (const hiddenEntryId of [entryId, laterEntryId]) {
      for (const includeEntry of [false, true]) {
        const hidden = await fencedReader.readCurrentTurnEntry({
          ...fencedRequest,
          entryId: hiddenEntryId,
          includeEntry,
        });
        expect(hidden.anchor).toBeUndefined();
        expect(hidden.event).toBeUndefined();
      }
    }
    await expect(fencedReader.readCurrentTurnEntry(request)).rejects.toThrow(
      "changed before replay admission",
    );
  });
});

it("does not publish a stale retarget over a manager changed while its worker read waits", async () => {
  await withSessionState("retarget", async ({ scope: target }) => {
    SessionManager.open(target).appendMessage(makeUserMessage("persisted", 1));
    const manager = SessionManager.inMemory("/detached");
    const gate = pauseRead(historyLane.pool, "request");
    const pending = manager.setSessionTargetAsync(target);
    const refused = expect(pending).rejects.toThrow("changed during transcript hydration");
    try {
      await gate.wait(refused, "Retarget settled before the intercepted worker read");
      manager.appendMessage(makeUserMessage("newer detached view", 2));
      gate.release();
      await refused;
      expect(manager.isPersisted()).toBe(false);
      expectMessages(manager, makeUserMessage("newer detached view", 2));
      await manager.setSessionTargetAsync(target);
      expect(manager.getSessionId()).toBe(target.sessionId);
      expectMessages(manager, makeUserMessage("persisted", 1));
    } finally {
      gate.release();
      gate.restore();
      await Promise.allSettled([pending]);
    }
  });
});

it.each(["hydration", "current-turn"] as const)(
  "releases queued %s admission on abort before its predecessors finish",
  async (kind) => {
    await withSessionState("queued-abort", async ({ scope: target }) => {
      const entryId = SessionManager.open(target).appendMessage(
        makeUserMessage("preserved predecessor", 1),
      );
      const { snapshot } = await prepareSessionTranscriptHydration(target).read();
      const entered = createDeferredCore();
      const queued = createDeferredCore();
      const release = createDeferredCore();
      const run = historyLane.pool.run.bind(historyLane.pool);
      const capacity = historyLane.pool.getSnapshot().maxWorkers;
      const expectQueue = (pendingTasks = capacity) =>
        expect(historyLane.pool.getSnapshot()).toMatchObject({
          activeTasks: capacity,
          pendingTasks,
        });
      let submissions = 0;
      let enteredCount = 0;
      const spy = vi.spyOn(historyLane.pool, "run").mockImplementation((input, options) => {
        if (submissions++ < capacity) {
          return run(async () => {
            if (++enteredCount === capacity) {
              entered.resolve();
            }
            await release.promise;
            return typeof input === "function" ? await input() : input;
          }, options);
        }
        const result = run(input, options);
        queued.resolve();
        return result;
      });
      const predecessorReads = Array.from({ length: capacity }, () =>
        SessionManager.openAsync(target),
      );
      const predecessors = Promise.all(predecessorReads);
      const reads: Promise<unknown>[] = [...predecessorReads, predecessors];
      try {
        await Promise.race([
          entered.promise,
          predecessors.then(() => {
            throw new Error("Hydration predecessors settled before filling the worker pool");
          }),
        ]);
        expectQueue();
        const controller = new AbortController();
        const reason = new Error("queued hydration cancelled");
        const canceled =
          kind === "hydration"
            ? SessionManager.openAsync(target, undefined, undefined, controller.signal)
            : prepareSessionTranscriptHydration(
                target,
                undefined,
                controller.signal,
              ).readCurrentTurnEntry({
                entryId,
                version: snapshot.version,
                includeEntry: true,
              });
        const refused = expect(canceled).rejects.toBe(reason);
        reads.push(canceled, refused);
        await queued.promise;
        expectQueue(capacity + 1);
        controller.abort(reason);
        expectQueue();
        await refused;
        release.resolve();
        for (const predecessor of await predecessors) {
          expectMessages(predecessor, makeUserMessage("preserved predecessor", 1));
        }
      } finally {
        release.resolve();
        spy.mockRestore();
        await Promise.allSettled(reads);
      }
    });
  },
);

it("keeps absent storage absent, lazy headers unpersisted, and malformed retargets atomic", async () => {
  await withOpenClawTestState({ label: "session-hydration-empty" }, async (state) => {
    const target = canonicalTarget(state, "empty");
    await expect(SessionManager.openAsync(target)).rejects.toThrow("storage");
    expect(fs.existsSync(target.storePath)).toBe(false);
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const empty = await SessionManager.openAsync(target);
    expect(empty.getHeader()?.id).toBe(target.sessionId);
    expect(empty.getEntries()).toEqual([]);
    const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
    expect(database.db.prepare("SELECT COUNT(*) AS count FROM transcript_events").get()).toEqual({
      count: 0,
    });
    await replaceTranscriptEvents(target, [{ type: "future-row", id: "opaque" }]);
    const manager = SessionManager.inMemory("/retained");
    manager.appendMessage(makeUserMessage("keep", 1));
    const before = manager.getPersistedEntries();
    await expect(manager.setSessionTargetAsync(target)).rejects.toThrow();
    expect(manager.getPersistedEntries()).toEqual(before);
    expect(manager.getCwd()).toBe("/retained");
    expect(manager.isPersisted()).toBe(false);
  });
});

it.each(["abort", "database-close"] as const)(
  "rejects a prepared result after %s before publication",
  async (reason) => {
    await withSessionState("revoked", async ({ scope: target }) => {
      SessionManager.open(target).appendMessage(makeUserMessage("retained", 1));
      const controller = new AbortController();
      const gate = pauseRead(historyLane.pool, "reply");
      const pending = SessionManager.openAsync(target, undefined, undefined, controller.signal);
      const refused = expect(pending).rejects.toThrow(
        reason === "abort" ? "cancelled hydration" : "revoked",
      );
      try {
        await gate.wait(refused, "Hydration settled before the intercepted reply");
        if (reason === "abort") {
          controller.abort(new Error("cancelled hydration"));
        } else {
          await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        }
        gate.release();
        await refused;
        const reopened = await SessionManager.openAsync(target);
        expectMessages(reopened, makeUserMessage("retained", 1));
      } finally {
        gate.release();
        gate.restore();
        await Promise.allSettled([pending]);
      }
    });
  },
);

it.each([
  { entry: "openAsync", environment: "explicit", storage: "incognito" },
  { entry: "openBoundedAsync", environment: "process", storage: "incognito" },
  { entry: "setSessionTargetAsync", environment: "explicit", storage: "incognito" },
  { entry: "openAsync", environment: "explicit", storage: "file" },
  { entry: "openAsync", environment: "process", storage: "file" },
])(
  "$entry retains $environment $storage environment identity after publication",
  async ({ entry, environment, storage }) => {
    const privateStorage = storage === "incognito";
    const canary = "synthetic-hydration-private-value";
    await withOpenClawTestState(
      {
        label: "session-hydration-environment",
        ...(!privateStorage && {
          env: { SESSION_HYDRATION_TEST_CANARY: canary, OPENCLAW_SUPERVISOR_MODE: undefined },
        }),
      },
      async (state) => {
        const target = canonicalTarget(
          state,
          privateStorage ? "private-environment" : "file-environment",
          privateStorage
            ? "agent:main:dashboard:incognito-environment"
            : "agent:main:file-environment",
        );
        if (privateStorage) {
          await (
            await SessionManager.openAsync(target)
          ).appendMessageAsync(makeUserMessage("original private history", 1));
        } else {
          await seedHistory(target, "file history");
          await waitForSessionTranscriptProjection(target);
          await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        }
        const originalEnvironment = process.env.OPENCLAW_STATE_DIR;
        const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: state.stateDir };
        const input = environment === "explicit" ? { ...target, env } : target;
        const detached = SessionManager.inMemory();
        const pending =
          entry === "openAsync"
            ? SessionManager.openAsync(input)
            : entry === "openBoundedAsync"
              ? SessionManager.openBoundedAsync(input, { maxBytes: 4096, maxEvents: 10 })
              : detached.setSessionTargetAsync(input).then(() => detached);
        const otherState = state.statePath("different-root");
        const changedEnvironment = environment === "explicit" ? env : process.env;
        changedEnvironment.OPENCLAW_STATE_DIR = otherState;
        if (!privateStorage) {
          changedEnvironment.OPENCLAW_SUPERVISOR_MODE = "external";
        }
        try {
          const manager = await pending;
          const original = { ...target, env: { OPENCLAW_STATE_DIR: state.stateDir } };
          if (privateStorage) {
            const initial = makeUserMessage("original private history", 1);
            expectMessages(manager, initial);
            const exposed = manager.getSessionTarget();
            expect(exposed?.env?.OPENCLAW_STATE_DIR).toBe(state.stateDir);
            Object.assign(exposed?.env ?? {}, {
              OPENCLAW_STATE_DIR: state.statePath("getter-root"),
            });
            await manager.reloadPersistedTranscriptAsync();
            expectMessages(manager, initial);
            const added = makeUserMessage("same private owner", 2);
            await manager.appendMessageAsync(added);
            expectMessages(await SessionManager.openAsync(original), initial, added);
          } else {
            // A boolean prevents a failed environment capture from printing process secrets.
            expect(JSON.stringify(manager.getSessionTarget()).includes(canary)).toBe(false);
            expect(manager.getSessionTarget()?.env?.OPENCLAW_SUPERVISOR_MODE).toBeUndefined();
            await manager.appendThinkingLevelChange("high");
            expect(fs.existsSync(path.join(otherState, "state", "openclaw.sqlite"))).toBe(false);
            expect(SessionManager.open(original).buildSessionContext().thinkingLevel).toBe("high");
          }
        } finally {
          if (originalEnvironment === undefined) {
            delete process.env.OPENCLAW_STATE_DIR;
          } else {
            process.env.OPENCLAW_STATE_DIR = originalEnvironment;
          }
          if (!privateStorage) {
            delete process.env.OPENCLAW_SUPERVISOR_MODE;
          }
          await Promise.allSettled([pending]);
          if (privateStorage) {
            memorySessionActorOwners.closeDatabase({
              agentId: target.agentId,
              path: resolveIncognitoOpenClawAgentSqlitePath({
                agentId: target.agentId,
                env: state.env,
              }),
            });
          }
        }
      },
    );
  },
);

it.each(["completed-drain", "active-drain", "terminal-owner"])(
  "preserves physical discovery authority across %s",
  async (transition) => {
    await withOpenClawTestState(
      { label: "session-hydration-discovery-lifecycle" },
      async (state) => {
        const target = {
          agentId: "worker",
          sessionId: "discovery-lifecycle",
          sessionKey: "agent:worker:discovery-lifecycle",
          storePath: state.path("shared.sqlite"),
        };
        await seedHistory(target, "durable shared history");
        await waitForSessionTranscriptProjection(target);
        await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        const drain = createDeferredCore();
        const revoked = createDeferredCore();
        const unregister =
          transition === "active-drain"
            ? registerOpenClawAgentDatabaseAsyncResource({
                agentId: "main",
                path: target.storePath,
                revoke: () => revoked.resolve(),
                close: () => drain.promise,
              })
            : undefined;
        const gate = pauseRead(WorkerTaskPool.prototype, "reply", (request) => {
          expect(request).toMatchObject({ kind: "sqlite-target" });
        });
        const pending = SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 10 });
        const expected =
          transition === "completed-drain"
            ? expect(pending).resolves.toBeInstanceOf(SessionManager)
            : expect(pending).rejects.toThrow(
                transition === "active-drain" ? "resources are closing" : "newly forbidden owner",
              );
        let closing: Promise<boolean> | undefined;
        try {
          await gate.wait(expected, "Discovery settled before the intercepted reply");
          if (transition === "active-drain") {
            closing = closeOpenClawAgentDatabaseByPathAsync(target.storePath);
            await revoked.promise;
          } else if (transition === "terminal-owner") {
            recordOpenClawAgentDatabaseOpenFailure(
              target.storePath,
              new Error("newly forbidden owner"),
            );
          } else {
            await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
          }
          gate.release();
          await expected;
          if (transition === "completed-drain") {
            expectMessages(await pending, makeUserMessage("durable shared history", 1));
          }
        } finally {
          gate.release();
          drain.resolve();
          gate.restore();
          await Promise.allSettled([pending, ...(closing ? [closing] : [])]);
          unregister?.();
          clearOpenClawAgentDatabaseOpenFailure(target.storePath);
        }
      },
    );
  },
);

it.each(["canonical", "custom"])(
  "transfers a Windows environment snapshot through the real %s async opener without retargeting it",
  async (layout) => {
    await withOpenClawTestState({ label: "session-hydration-windows-transfer" }, async (state) => {
      const target = canonicalTarget(state, "windows-transfer");
      if (layout === "custom") {
        target.storePath = state.path("windows-shared.sqlite");
      }
      await seedHistory(target, "captured store");
      const hostPlatform = process.platform;
      const env = { ...state.env };
      for (const key of Object.keys(env)) {
        if (
          key.toUpperCase() === "OPENCLAW_STATE_DIR" ||
          key.toUpperCase() === "OPENCLAW_SUPERVISOR_MODE"
        ) {
          delete env[key];
        }
      }
      env.OpenClaw_State_Dir = state.stateDir;
      env.OpenClaw_Supervisor_Mode = "external";
      const cloneEnv = configEnv.cloneEnvWithPlatformSemantics;
      expect(withMockedPlatform("win32", () => cloneEnv(env)).OPENCLAW_STATE_DIR).toBe(
        state.stateDir,
      );
      const clone = vi
        .spyOn(configEnv, "cloneEnvWithPlatformSemantics")
        .mockImplementation((input) =>
          // Only environment lookup uses Windows semantics; SQLite and paths use the actual host.
          withMockedPlatform("win32", () => cloneEnv(input)),
        );
      let transferred: unknown;
      const gate = pauseRead(
        layout === "canonical" ? historyLane.pool : WorkerTaskPool.prototype,
        "request",
        (request) => {
          transferred = request;
        },
      );
      const inputTarget = { ...target, env };
      const pending = SessionManager.openAsync(inputTarget);
      const result = expect(pending).resolves.toBeInstanceOf(SessionManager);
      try {
        await gate.wait(result, "Hydration settled before the intercepted environment transfer");
        env.OpenClaw_State_Dir = state.path("later-state");
        env.OpenClaw_Supervisor_Mode = "changed-after-capture";
        expect(process.platform).toBe(hostPlatform);
        gate.release();
        await result;
        expectMessages(await pending, makeUserMessage("captured store", 1));
        const expectedEnv = {
          OPENCLAW_STATE_DIR: state.stateDir,
          OPENCLAW_SUPERVISOR_MODE: "external",
        };
        expect(transferred).toMatchObject(
          layout === "canonical" ? { target: { env: expectedEnv } } : { env: expectedEnv },
        );
        expect(fs.existsSync(state.path("later-state"))).toBe(false);
      } finally {
        gate.release();
        clone.mockRestore();
        gate.restore();
        await Promise.allSettled([pending]);
      }
    });
  },
);
