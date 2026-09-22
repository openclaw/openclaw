import fs from "node:fs";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import * as configEnv from "../../config/config-env-vars.js";
import {
  upsertSessionEntryCore,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { SessionTranscriptStorageUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { historyPages } from "../../config/sessions/session-transcript-worker-resources.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { SessionManager } from "../../plugin-sdk/agent-sessions.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabases,
  openOpenClawAgentDatabase,
  listOpenIncognitoAgentDatabases,
  recordOpenClawAgentDatabaseOpenFailure,
  clearOpenClawAgentDatabaseOpenFailure,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";

it.each(["canonical", "custom", "shared"])(
  "opens cold and bounded %s SDK views without host SQLite and preserves complete durable history",
  async (layout) => {
    await withOpenClawTestState({ label: "session-hydration" }, async (state) => {
      const target = {
        agentId: layout === "shared" ? "worker" : "main",
        sessionId: "hydration",
        sessionKey: `agent:${layout === "shared" ? "worker" : "main"}:hydration`,
        storePath:
          layout === "canonical"
            ? path.join(state.agentDir("main"), "openclaw-agent.sqlite")
            : path.join(state.root, "shared.sqlite"),
      };
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
        await cold.reloadPersistedTranscriptAsync();
        expect(cold.getCwd()).toBe("/runtime");
        expect(cold.getPersistedEntries()).toEqual(expected);
        expect(probes.flatMap((probe) => probe.mock.calls)).toEqual([]);
      } finally {
        probes.forEach((probe) => probe.mockRestore());
      }
    });
  },
);

it("does not publish a stale retarget over a manager changed while its worker read waits", async () => {
  await withOpenClawTestState({ label: "session-hydration-retarget" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "retarget",
      sessionKey: "agent:main:retarget",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const source = SessionManager.open(target);
    source.appendMessage(makeUserMessage("persisted", 1));
    const manager = SessionManager.inMemory("/detached");
    const release = createDeferredCore();
    const entered = createDeferredCore();
    const spy = vi
      .spyOn(WorkerTaskPool.prototype, "run")
      .mockImplementationOnce(function (this: WorkerTaskPool<unknown, unknown>, input, options) {
        spy.mockRestore();
        return this.run(async () => {
          entered.resolve();
          await release.promise;
          return typeof input === "function" ? await input() : input;
        }, options);
      });
    const pending = manager.setSessionTargetAsync(target);
    const refused = expect(pending).rejects.toThrow("changed during transcript hydration");
    try {
      await entered.promise;
      manager.appendMessage(makeUserMessage("newer detached view", 2));
      release.resolve();
      await refused;
      expect(manager.isPersisted()).toBe(false);
      expect(manager.buildSessionContext().messages).toEqual([
        makeUserMessage("newer detached view", 2),
      ]);
      await manager.setSessionTargetAsync(target);
      expect(manager.getSessionId()).toBe(target.sessionId);
      expect(manager.buildSessionContext().messages).toEqual([makeUserMessage("persisted", 1)]);
    } finally {
      release.resolve();
      spy.mockRestore();
      await Promise.allSettled([pending]);
    }
  });
});

it("releases queued hydration admission on abort before its predecessor finishes", async () => {
  await withOpenClawTestState({ label: "session-hydration-queued-abort" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "queued-abort",
      sessionKey: "agent:main:queued-abort",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    SessionManager.open(target).appendMessage(makeUserMessage("preserved predecessor", 1));
    const entered = createDeferredCore();
    const queued = createDeferredCore();
    const release = createDeferredCore();
    const run = historyPages.run.bind(historyPages);
    let submissions = 0;
    const spy = vi.spyOn(historyPages, "run").mockImplementation((input, options) => {
      if (submissions++ === 0) {
        return run(async () => {
          entered.resolve();
          await release.promise;
          return typeof input === "function" ? await input() : input;
        }, options);
      }
      const result = run(input, options);
      queued.resolve();
      return result;
    });
    const predecessor = SessionManager.openAsync(target);
    const reads: Promise<unknown>[] = [predecessor];
    try {
      await entered.promise;
      expect(historyPages.getSnapshot()).toMatchObject({ activeTasks: 1, pendingTasks: 1 });
      const controller = new AbortController();
      const reason = new Error("queued hydration cancelled");
      const canceled = SessionManager.openAsync(target, undefined, undefined, controller.signal);
      const refused = expect(canceled).rejects.toBe(reason);
      reads.push(canceled, refused);
      await queued.promise;
      expect(historyPages.getSnapshot()).toMatchObject({ activeTasks: 1, pendingTasks: 2 });
      controller.abort(reason);
      expect(historyPages.getSnapshot()).toMatchObject({ activeTasks: 1, pendingTasks: 1 });
      await refused;
      release.resolve();
      expect((await predecessor).buildSessionContext().messages).toEqual([
        makeUserMessage("preserved predecessor", 1),
      ]);
    } finally {
      release.resolve();
      spy.mockRestore();
      await Promise.allSettled(reads);
    }
  });
});

it("keeps absent storage absent, lazy headers unpersisted, and malformed retargets atomic", async () => {
  await withOpenClawTestState({ label: "session-hydration-empty" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "empty",
      sessionKey: "agent:main:empty",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
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
    await withOpenClawTestState({ label: "session-hydration-revoked" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "revoked",
        sessionKey: "agent:main:revoked",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      SessionManager.open(target).appendMessage(makeUserMessage("retained", 1));
      const controller = new AbortController();
      const received = createDeferredCore();
      const release = createDeferredCore();
      const spy = vi
        .spyOn(WorkerTaskPool.prototype, "run")
        .mockImplementationOnce(function (this: WorkerTaskPool<unknown, unknown>, input, options) {
          spy.mockRestore();
          return this.run(input, options).then(async (result) => {
            received.resolve();
            await release.promise;
            return result;
          });
        });
      const pending = SessionManager.openAsync(target, undefined, undefined, controller.signal);
      const refused = expect(pending).rejects.toThrow(
        reason === "abort" ? "cancelled hydration" : "revoked",
      );
      try {
        await received.promise;
        if (reason === "abort") {
          controller.abort(new Error("cancelled hydration"));
        } else {
          await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        }
        release.resolve();
        await refused;
        const reopened = await SessionManager.openAsync(target);
        expect(reopened.buildSessionContext().messages).toEqual([makeUserMessage("retained", 1)]);
      } finally {
        release.resolve();
        spy.mockRestore();
        await Promise.allSettled([pending]);
      }
    });
  },
);

it.each(["full", "bounded"])(
  "keeps %s incognito hydration on an existing process-local SQLite identity",
  async (mode) => {
    await withOpenClawTestState({ label: "session-hydration-incognito" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "private",
        sessionKey: "agent:main:dashboard:incognito-hydration",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      const open = () =>
        mode === "full"
          ? SessionManager.openAsync(target)
          : SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 5 });
      const owners = listOpenIncognitoAgentDatabases();
      await expect(open()).rejects.toThrow(SessionTranscriptStorageUnavailableError);
      expect(listOpenIncognitoAgentDatabases()).toEqual(owners);
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        incognito: true,
      });
      SessionManager.open(target).appendMessage(makeUserMessage("process local", 1));
      expect((await open()).buildSessionContext().messages).toEqual([
        makeUserMessage("process local", 1),
      ]);
      expect(fs.existsSync(target.storePath)).toBe(false);
    });
  },
);

it.each(
  ["full", "bounded", "retarget", "reload"].flatMap((entry) =>
    ["close", "replace"].map((transition) => ({ entry, transition })),
  ),
)("rejects incognito $entry publication after owner $transition", async ({ entry, transition }) => {
  await withOpenClawTestState({ label: "session-hydration-incognito-owner" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "private-owner",
      sessionKey: "agent:main:dashboard:incognito-owner",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      incognito: true,
    });
    const source = SessionManager.open(target);
    source.appendMessage(makeUserMessage("discarded private history", 1));
    const receiver = entry === "reload" ? source : SessionManager.inMemory();
    const originalView = receiver.buildSessionContext();
    const pending =
      entry === "full"
        ? SessionManager.openAsync(target)
        : entry === "bounded"
          ? SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 5 })
          : entry === "retarget"
            ? receiver.setSessionTargetAsync(target)
            : receiver.reloadPersistedTranscriptAsync();
    const rejected = expect(pending).rejects.toThrow(
      "incognito database owner is no longer current",
    );
    closeOpenClawAgentDatabases(state.root);
    if (transition === "replace") {
      SessionManager.open(target).appendMessage(makeUserMessage("replacement private history", 2));
    }
    await rejected;
    expect(receiver.buildSessionContext()).toEqual(originalView);
    expect(fs.existsSync(target.storePath)).toBe(false);
  });
});

it("rejects incognito bounded publication when its truncation callback closes the owner", async () => {
  await withOpenClawTestState({ label: "session-hydration-incognito-callback" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "private-callback",
      sessionKey: "agent:main:dashboard:incognito-callback",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      incognito: true,
    });
    const source = SessionManager.open(target);
    source.appendMessage(makeUserMessage("older private history", 1));
    source.appendMessage(makeUserMessage("latest private history", 2));
    const onTruncated = vi.fn(() => closeOpenClawAgentDatabases(state.root));
    await expect(
      SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 1, onTruncated }),
    ).rejects.toThrow("incognito database owner is no longer current");
    expect(onTruncated).toHaveBeenCalledOnce();
    expect(fs.existsSync(target.storePath)).toBe(false);
  });
});

it.each([
  { entry: "openAsync", environment: "process" },
  { entry: "openAsync", environment: "explicit" },
  { entry: "openBoundedAsync", environment: "process" },
  { entry: "openBoundedAsync", environment: "explicit" },
  { entry: "setSessionTargetAsync", environment: "process" },
  { entry: "setSessionTargetAsync", environment: "explicit" },
])(
  "$entry retains $environment environment identity after publication",
  async ({ entry, environment }) => {
    await withOpenClawTestState({ label: "session-hydration-environment" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "private-environment",
        sessionKey: "agent:main:dashboard:incognito-environment",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        incognito: true,
      });
      SessionManager.open(target).appendMessage(makeUserMessage("original private history", 1));
      const originalEnvironment = process.env.OPENCLAW_STATE_DIR;
      const env = { OPENCLAW_STATE_DIR: state.stateDir };
      const input = environment === "explicit" ? { ...target, env } : target;
      const detached = SessionManager.inMemory();
      const pending =
        entry === "openAsync"
          ? SessionManager.openAsync(input)
          : entry === "openBoundedAsync"
            ? SessionManager.openBoundedAsync(input, { maxBytes: 4096, maxEvents: 10 })
            : detached.setSessionTargetAsync(input).then(() => detached);
      if (environment === "explicit") {
        env.OPENCLAW_STATE_DIR = state.statePath("different-root");
      } else {
        process.env.OPENCLAW_STATE_DIR = state.statePath("different-root");
      }
      try {
        const manager = await pending;
        expect(manager.buildSessionContext().messages).toEqual([
          makeUserMessage("original private history", 1),
        ]);
        const exposed = manager.getSessionTarget();
        expect(exposed?.env?.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        Object.assign(exposed?.env ?? {}, { OPENCLAW_STATE_DIR: state.statePath("getter-root") });
        await manager.reloadPersistedTranscriptAsync();
        expect(manager.buildSessionContext().messages).toEqual([
          makeUserMessage("original private history", 1),
        ]);
        manager.appendMessage(makeUserMessage("same private owner", 2));
        const original = { ...target, env: { OPENCLAW_STATE_DIR: state.stateDir } };
        expect(SessionManager.open(original).buildSessionContext().messages).toEqual([
          makeUserMessage("original private history", 1),
          makeUserMessage("same private owner", 2),
        ]);
      } finally {
        if (originalEnvironment === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = originalEnvironment;
        }
        await Promise.allSettled([pending]);
      }
    });
  },
);

it.each(["process", "explicit"])(
  "keeps file-backed metadata writes in the published %s storage environment",
  async (environment) => {
    const canary = "synthetic-hydration-private-value";
    await withOpenClawTestState(
      {
        label: "session-hydration-file-environment",
        env: { SESSION_HYDRATION_TEST_CANARY: canary, OPENCLAW_SUPERVISOR_MODE: undefined },
      },
      async (state) => {
        const target = {
          agentId: "main",
          sessionId: "file-environment",
          sessionKey: "agent:main:file-environment",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        SessionManager.open(target).appendMessage(makeUserMessage("file history", 1));
        await waitForSessionTranscriptProjection(target);
        await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        const originalEnvironment = process.env.OPENCLAW_STATE_DIR;
        const env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: state.stateDir };
        const input = environment === "explicit" ? { ...target, env } : target;
        const pending = SessionManager.openAsync(input);
        const otherState = state.statePath("different-root");
        if (environment === "explicit") {
          env.OPENCLAW_STATE_DIR = otherState;
          env.OPENCLAW_SUPERVISOR_MODE = "external";
        } else {
          process.env.OPENCLAW_STATE_DIR = otherState;
          process.env.OPENCLAW_SUPERVISOR_MODE = "external";
        }
        try {
          const manager = await pending;
          // Check a boolean so a faulty environment capture cannot print real process values.
          expect(JSON.stringify(manager.getSessionTarget()).includes(canary)).toBe(false);
          expect(manager.getSessionTarget()?.env?.OPENCLAW_SUPERVISOR_MODE).toBeUndefined();
          await manager.appendThinkingLevelChange("high");
          expect(fs.existsSync(path.join(otherState, "state", "openclaw.sqlite"))).toBe(false);
          const original = { ...target, env: { OPENCLAW_STATE_DIR: state.stateDir } };
          expect(SessionManager.open(original).buildSessionContext().thinkingLevel).toBe("high");
        } finally {
          if (originalEnvironment === undefined) {
            delete process.env.OPENCLAW_STATE_DIR;
          } else {
            process.env.OPENCLAW_STATE_DIR = originalEnvironment;
          }
          delete process.env.OPENCLAW_SUPERVISOR_MODE;
          await Promise.allSettled([pending]);
        }
      },
    );
  },
);

it.each(["completed-drain", "active-drain", "terminal-owner", "registry-close"])(
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
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        SessionManager.open(target).appendMessage(makeUserMessage("durable shared history", 1));
        await waitForSessionTranscriptProjection(target);
        await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
        const received = createDeferredCore();
        const release = createDeferredCore();
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
        const dispatch = vi
          .spyOn(WorkerTaskPool.prototype, "run")
          .mockImplementationOnce(
            function (this: WorkerTaskPool<unknown, unknown>, input, options) {
              dispatch.mockRestore();
              expect(input).toMatchObject({ kind: "sqlite-target" });
              return this.run(input, options).then(async (reply) => {
                received.resolve();
                await release.promise;
                return reply;
              });
            },
          );
        const pending = SessionManager.openBoundedAsync(target, { maxBytes: 4096, maxEvents: 10 });
        const expected =
          transition === "completed-drain"
            ? expect(pending).resolves.toBeInstanceOf(SessionManager)
            : expect(pending).rejects.toThrow(
                transition === "active-drain"
                  ? "resources are closing"
                  : transition === "terminal-owner"
                    ? "newly forbidden owner"
                    : "read admission",
              );
        let closing: Promise<boolean> | undefined;
        try {
          await received.promise;
          if (transition === "active-drain") {
            closing = closeOpenClawAgentDatabaseByPathAsync(target.storePath);
            await revoked.promise;
          } else if (transition === "terminal-owner") {
            recordOpenClawAgentDatabaseOpenFailure(
              target.storePath,
              new Error("newly forbidden owner"),
            );
          } else if (transition === "registry-close") {
            await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath());
          } else {
            await closeOpenClawAgentDatabaseByPathAsync(target.storePath);
          }
          release.resolve();
          await expected;
          if (transition === "completed-drain") {
            expect((await pending).buildSessionContext().messages).toEqual([
              makeUserMessage("durable shared history", 1),
            ]);
          }
        } finally {
          release.resolve();
          drain.resolve();
          dispatch.mockRestore();
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
      const target = {
        agentId: "main",
        sessionId: "windows-transfer",
        sessionKey: "agent:main:windows-transfer",
        storePath:
          layout === "canonical"
            ? path.join(state.agentDir("main"), "openclaw-agent.sqlite")
            : state.path("windows-shared.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      SessionManager.open(target).appendMessage(makeUserMessage("captured store", 1));
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
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let transferred: unknown;
      const dispatch = vi
        .spyOn(WorkerTaskPool.prototype, "run")
        .mockImplementationOnce(function (this: WorkerTaskPool<unknown, unknown>, input, options) {
          dispatch.mockRestore();
          return this.run(async () => {
            entered.resolve();
            await release.promise;
            transferred = typeof input === "function" ? await input() : input;
            return transferred;
          }, options);
        });
      const inputTarget = { ...target, env };
      const pending = SessionManager.openAsync(inputTarget);
      const result = expect(pending).resolves.toBeInstanceOf(SessionManager);
      try {
        await entered.promise;
        env.OpenClaw_State_Dir = state.path("later-state");
        env.OpenClaw_Supervisor_Mode = "changed-after-capture";
        expect(process.platform).toBe(hostPlatform);
        release.resolve();
        await result;
        expect((await pending).buildSessionContext().messages).toEqual([
          makeUserMessage("captured store", 1),
        ]);
        const expectedEnv = {
          OPENCLAW_STATE_DIR: state.stateDir,
          OPENCLAW_SUPERVISOR_MODE: "external",
        };
        expect(transferred).toMatchObject(
          layout === "canonical" ? { target: { env: expectedEnv } } : { env: expectedEnv },
        );
        expect(fs.existsSync(state.path("later-state"))).toBe(false);
      } finally {
        release.resolve();
        clone.mockRestore();
        dispatch.mockRestore();
        await Promise.allSettled([pending]);
      }
    });
  },
);
