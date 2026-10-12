import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteAdmission,
} from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { memoryCpuProcessEntrypoints } from "./memory/manager-cpu-entrypoints.js";
import { createStandingIntentExecutor } from "./standing-intents-tool.js";
import {
  createStandingIntent,
  listStandingIntents,
  matchStandingIntents,
} from "./standing-intents.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const writerDrains: Array<() => Promise<unknown>> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      try {
        for (const release of releases.splice(0)) {
          release();
        }
        await Promise.allSettled(pending.splice(0));
        await Promise.allSettled(writerDrains.splice(0).map((drain) => drain()));
      } finally {
        resetGlobalHookRunner();
        resetPluginRuntimeStateForTest();
      }
      // Worker lease retirement still needs its original shared-state file.
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  }),
);

let stateDir: string;
beforeEach(() => {
  stateDir = tempDirs.make("standing-intent-async-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

function keep<T>(work: Promise<T>): Promise<T> {
  pending.push(work);
  void work.catch(() => {});
  return work;
}

async function holdWriter(beforeRelease?: () => void, beforeLock?: () => Promise<void>) {
  const target = {
    agentId: "main",
    sessionId: "standing-intent-writer",
    sessionKey: "agent:main:standing-intent-writer",
    storePath: resolveStorePath(undefined, { agentId: "main" }),
  };
  const database = {
    agentId: target.agentId,
    path: resolveOpenClawAgentSqlitePath({ agentId: target.agentId }),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  await beforeLock?.();
  const entered = deferred();
  const finish = deferred();
  releases.push(finish.resolve);
  const done = keep(
    runOpenClawAgentWriteAdmission(database, async () => {
      entered.resolve();
      await finish.promise;
      beforeRelease?.();
    }),
  );
  const drain = () => runOpenClawAgentWriteAdmission(database, () => undefined);
  writerDrains.push(drain);
  await Promise.race([entered.promise, done]);
  return { entered: entered.promise, release: finish.resolve, done, drain };
}

function failStandingIntentWrites(action: "create" | "list" | "cancel" | "match") {
  const operation = action === "create" ? "insert into" : "update";
  const moduleUrl = resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.standingIntents);
  const fixturePath = path.join(stateDir, "standing-intent-statement-fault.mjs");
  // Prototype interception also reaches statements prepared by the seed operation.
  fs.writeFileSync(
    fixturePath,
    `import { StatementSync } from "node:sqlite";
import { bindSqliteWorkerBackend as bind } from ${JSON.stringify(moduleUrl.href)};
export function bindSqliteWorkerBackend(input, context) {
  const backend = bind(input, context);
  const action = ${JSON.stringify(action)};
  const originals = new Map();
  for (const method of ["run", "get", "all", "iterate"]) {
    const original = StatementSync.prototype[method];
    originals.set(method, original);
    StatementSync.prototype[method] = function (...args) {
      const sql = this.sourceSQL.toLowerCase().replaceAll('"', '');
      const selected = action === 'create' || (action === 'match'
        ? sql.includes('set fire_count =')
        : args.includes(action === 'list' ? 'expired' : 'cancelled'));
      if (selected && sql.startsWith(${JSON.stringify(`${operation} standing_intents `)})) {
        throw new Error('fixture standing-intent write rejected');
      }
      return Reflect.apply(original, this, args);
    };
  }
  return { ...backend, close() {
    for (const [method, original] of originals) StatementSync.prototype[method] = original;
    return backend.close();
  } };
}
`,
  );
  const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
  return vi
    .spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2")
    .mockImplementation((options, source, worker) =>
      open(
        options,
        source,
        worker.moduleUrl.href === moduleUrl.href
          ? { ...worker, moduleUrl: pathToFileURL(fixturePath) }
          : worker,
      ),
    );
}

async function expectWaiting(work: Promise<unknown>, entered: Promise<void>) {
  let settled = false;
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.race([entered, work.catch(() => undefined)]);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(settled).toBe(false);
}

async function seed(expired = false) {
  return await createStandingIntent({
    agentId: "main",
    description: "Confirm the rollback owner.",
    triggerKeywords: ["launch"],
    creatorSender: "owner",
    maxFires: 1,
    ...(expired ? { nowMs: 100, expiresAt: 200 } : {}),
  });
}

function readStored(id: string) {
  return openOpenClawAgentDatabase({ agentId: "main" })
    .db.prepare("SELECT status, fire_count FROM standing_intents WHERE id = ?")
    .get(id);
}

function observeStandingIntentHostSql() {
  const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
  const calibration = "SELECT id FROM standing_intents LIMIT 1";
  const statement = db.prepare(calibration);
  const observation = observeHostDataSql();
  try {
    // Prove that already-prepared native statements remain visible to the observer.
    statement.get();
    expect(observation.queries).toContain(calibration);
    observation.queries.length = 0;
    for (const call of observation.calls) {
      call.mockClear();
    }
    return observation;
  } catch (error) {
    observation.restore();
    throw error;
  }
}

function expectNoHostStandingIntentSql(observation: ReturnType<typeof observeHostDataSql>) {
  // Keep other observed SQL visible; this cut excludes cold bootstrap and native lease checks.
  expect(observation.queries.filter((sql) => /\bstanding_intents(?:_fts)?\b/i.test(sql))).toEqual(
    [],
  );
}

async function registerHooks() {
  const config: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const builder = createPluginRegistry({
    logger,
    runtime: createPluginRuntimeMock({ config: { current: () => config } }),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "memory-core",
    origin: "bundled",
    kind: "memory",
    contracts: manifest.contracts,
  });
  builder.registry.plugins.push(record);
  plugin.register(builder.createApi(record, { config, registrationMode: "full" }));
  setActivePluginRegistry(builder.registry);
  initializeGlobalHookRunner(builder.registry);
  const runner = getGlobalHookRunner();
  if (!runner) {
    throw new Error("Expected the real registered hook runner");
  }
  // Finish lazy hook loading before the writer barrier; loading delay is not admission proof.
  await runner.runBeforePromptBuild({ prompt: "", messages: [] }, { ...context, trigger: "user" });
  return { runner, logger, registry: builder.registry, config };
}

const context = {
  agentId: "main",
  sessionKey: "agent:main:intent-proof",
  sessionId: "intent-proof",
  messageProvider: "webchat",
  senderId: "owner",
};

async function registeredIntentTool(assertInvocationCurrent?: () => void) {
  const { registry, config } = await registerHooks();
  const registration = registry.tools.find((tool) => tool.names.includes("intent"));
  const registered = registration?.factory({
    ...context,
    config,
    senderIsOwner: true,
    messageChannel: "webchat",
    requesterSenderId: "owner",
    assertInvocationCurrent: assertInvocationCurrent ?? (() => {}),
  });
  const tool = Array.isArray(registered)
    ? registered.find((entry) => entry.name === "intent")
    : registered;
  if (!tool) {
    throw new Error("Expected the registered standing-intent tool");
  }
  return tool;
}

describe("standing-intent admitted operations", () => {
  it.each(["create", "list", "cancel"] as const)(
    "rejects %s after owner revocation during writer admission without changing persisted rows",
    async (action) => {
      const existing = await seed(action === "list");
      let current = true;
      const tool = await registeredIntentTool(() => {
        if (!current) {
          throw new Error("owner revoked");
        }
      });
      const held = await holdWriter();
      const work = keep(
        tool.execute("revoked-intent-call", {
          action,
          id: existing.id,
          description: "Must not persist",
          triggerKeywords: ["revocation"],
        }),
      );
      await expectWaiting(work, held.entered);
      current = false;
      held.release();
      await expect(work).rejects.toThrow("owner revoked");
      await held.drain();
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const reopened = new DatabaseSync(databasePath);
      try {
        expect(
          reopened.prepare("SELECT status FROM standing_intents WHERE id = ?").get(existing.id)
            ?.status,
        ).toBe("armed");
        expect(
          reopened.prepare("SELECT COUNT(*) AS count FROM standing_intents").get()?.count,
        ).toBe(1);
      } finally {
        reopened.close();
      }
    },
  );

  it("waits for the writer before restoring the first-use standing-intent schema", async () => {
    const held = await holdWriter();
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.exec("DROP TABLE standing_intents; DROP TABLE standing_intents_fts");
    const schemaExists = () =>
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'standing_intents'").get();
    const work = keep(seed());
    await expectWaiting(work, held.entered);
    expect(schemaExists()).toBeUndefined();
    held.release();
    const created = await work;
    expect(schemaExists()).toBeDefined();
    expect(readStored(created.id)).toMatchObject({ status: "armed", fire_count: 0 });
  });

  it.each(["create", "list", "cancel"] as const)(
    "awaits %s before the registered tool reports success",
    async (action) => {
      const existing = await seed();
      const tool = await registeredIntentTool();
      const held = await holdWriter();
      const work = keep(
        tool.execute("intent-call", {
          action,
          id: existing.id,
          description: "Check the migration.",
          triggerKeywords: ["migration"],
        }),
      );
      await expectWaiting(work, held.entered);
      const observation = observeStandingIntentHostSql();
      let result: Awaited<typeof work>;
      try {
        held.release();
        result = await work;
      } finally {
        observation.restore();
      }
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      const payload: unknown = JSON.parse(text);
      expect(payload).toMatchObject(
        action === "cancel"
          ? { cancelled: true }
          : action === "list"
            ? { intents: [{ id: existing.id }] }
            : { intent: { description: "Check the migration." } },
      );
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      const reopened = new DatabaseSync(databasePath);
      try {
        expect(
          reopened.prepare("SELECT COUNT(*) AS count FROM standing_intents").get()?.count,
        ).toBe(action === "create" ? 2 : 1);
        if (action === "cancel") {
          expect(
            reopened.prepare("SELECT status FROM standing_intents WHERE id = ?").get(existing.id)
              ?.status,
          ).toBe("cancelled");
        }
      } finally {
        reopened.close();
      }
      expectNoHostStandingIntentSql(observation);
    },
  );

  it.each(["create", "list", "cancel"] as const)(
    "propagates rejected %s writes without changing rows",
    async (action) => {
      const existing = await seed(action === "list");
      const fault = failStandingIntentWrites(action);
      try {
        const held = await holdWriter();
        const execute = createStandingIntentExecutor({
          agentId: "main",
          provider: "webchat",
          senderId: "owner",
        });
        const work = keep(
          execute("intent-call", {
            action,
            id: existing.id,
            description: "Check migration.",
            triggerKeywords: ["migration"],
          }),
        );
        await expectWaiting(work, held.entered);
        held.release();
        await expect(work).rejects.toThrow("fixture standing-intent write rejected");
        expect(readStored(existing.id)?.status).toBe("armed");
        expect(
          openOpenClawAgentDatabase({ agentId: "main" })
            .db.prepare("SELECT COUNT(*) AS count FROM standing_intents")
            .get()?.count,
        ).toBe(1);
      } finally {
        fault.mockRestore();
      }
    },
  );

  it("waits for the registered prompt hook's claim before injecting context", async () => {
    const existing = await seed();
    const { runner } = await registerHooks();
    const held = await holdWriter();
    const work = keep(
      runner.runBeforePromptBuild(
        { prompt: "launch", messages: [] },
        { ...context, trigger: "user" },
      ),
    );
    await expectWaiting(work, held.entered);
    expect(readStored(existing.id)?.fire_count).toBe(0);
    const observation = observeStandingIntentHostSql();
    try {
      held.release();
      expect((await work)?.prependContext).toContain("Confirm the rollback owner.");
    } finally {
      observation.restore();
    }
    expect(readStored(existing.id)?.fire_count).toBe(1);
    expect(readStored(existing.id)?.status).toBe("done");
    expectNoHostStandingIntentSql(observation);
  });

  it("keeps rejected prompt matching fail-open without spending its fire budget", async () => {
    const existing = await seed();
    const { runner, logger } = await registerHooks();
    const fault = failStandingIntentWrites("match");
    try {
      const held = await holdWriter();
      const work = keep(
        runner.runBeforePromptBuild(
          { prompt: "launch", messages: [] },
          { ...context, trigger: "user" },
        ),
      );
      held.release();
      expect((await work)?.prependContext).toBeUndefined();
      expect(readStored(existing.id)?.fire_count).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("standing intent matching failed"),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("fixture standing-intent write rejected"),
      );
    } finally {
      fault.mockRestore();
    }
  });

  it("does not spend a fire after the registered prompt hook times out", async () => {
    const existing = await seed();
    const { runner } = await registerHooks();
    const held = await holdWriter();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const work = keep(
        runner.runBeforePromptBuild(
          { prompt: "launch", messages: [] },
          { ...context, trigger: "user" },
        ),
      );
      await expectWaiting(work, held.entered);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await work).toBeUndefined();

      held.release();
      await held.drain();
      expect(readStored(existing.id)).toMatchObject({ status: "armed", fire_count: 0 });
    } finally {
      held.release();
      vi.useRealTimers();
    }
  });

  it("skips matching with a diagnostic when the host lacks the invocation capability", async () => {
    const existing = await seed();
    const { runner, registry, logger } = await registerHooks();
    const handler = registry.typedHooks.find(
      (hook) => hook.pluginId === "memory-core" && hook.hookName === "before_prompt_build",
    )?.handler as
      | ((...args: Parameters<typeof runner.runBeforePromptBuild>) => unknown)
      | undefined;
    expect(handler).toBeDefined();
    expect(
      await handler?.({ prompt: "launch", messages: [] }, { ...context, trigger: "user" }),
    ).toBeUndefined();
    expect(readStored(existing.id)).toMatchObject({ status: "armed", fire_count: 0 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "prompt hook invocation support is required; intent matching skipped",
      ),
    );
  });

  it("preserves a queued live caller after an expired hook and a cold database reopen", async () => {
    const existing = await seed();
    const { runner } = await registerHooks();
    // Drain before either caller captures its capability, then hold only admission.
    // Closing again at release would revoke the live caller's capability too.
    const held = await holdWriter(undefined, () => closeOpenClawAgentDatabasesAsync(stateDir));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hookWork = keep(
        runner.runBeforePromptBuild(
          { prompt: "launch", messages: [] },
          { ...context, trigger: "user" },
        ),
      );
      await expectWaiting(hookWork, held.entered);
      const liveCaller = keep(listStandingIntents({ agentId: "main" }));
      await expectWaiting(liveCaller, held.entered);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await hookWork).toBeUndefined();
      held.release();
      await expect(liveCaller).resolves.toMatchObject([
        { id: existing.id, status: "armed", fireCount: 0 },
      ]);
      await held.drain();
      expect(readStored(existing.id)).toMatchObject({ status: "armed", fire_count: 0 });
    } finally {
      held.release();
      vi.useRealTimers();
    }
  });

  it.each(["heartbeat", "cron"] as const)(
    "awaits registered %s lifecycle maintenance",
    async (trigger) => {
      const existing = await seed(true);
      const { runner } = await registerHooks();
      const held = await holdWriter();
      const work = keep(
        runner.runBeforeAgentReply(
          { cleanedBody: "ordinary scheduled turn" },
          { ...context, trigger },
        ),
      );
      await expectWaiting(work, held.entered);
      expect(readStored(existing.id)?.status).toBe("armed");
      const observation = observeStandingIntentHostSql();
      try {
        held.release();
        await work;
      } finally {
        observation.restore();
      }
      expect(readStored(existing.id)?.status).toBe("expired");
      expectNoHostStandingIntentSql(observation);
    },
  );

  it("refuses a queued create when its original database path is replaced", async () => {
    const replacementState = tempDirs.make("standing-intent-replacement-");
    vi.stubEnv("OPENCLAW_STATE_DIR", replacementState);
    const replacement = await seed();
    const replacementPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const original = await seed();
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const retiredPath = `${databasePath}.retired`;
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const originalStat = fs.statSync(databasePath);
    const replacementStat = fs.statSync(replacementPath);
    expect([replacementStat.dev, replacementStat.ino]).not.toEqual([
      originalStat.dev,
      originalStat.ino,
    ]);

    const held = await holdWriter(() => {
      // No worker has entered this queued operation; do not await our own writer drain.
      closeOpenClawAgentDatabasesForTest();
      expect(sourceDb.isOpen).toBe(false);
      fs.renameSync(databasePath, retiredPath);
      fs.renameSync(replacementPath, databasePath);
    });
    const sourceDb = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const work = keep(seed());
    await expectWaiting(work, held.entered);
    held.release();
    await expect(work).rejects.toThrow("Agent database target changed before write admission");
    await held.done;
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();

    for (const { filename, expectedId } of [
      { filename: retiredPath, expectedId: original.id },
      { filename: databasePath, expectedId: replacement.id },
    ]) {
      const reopened = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(
          reopened.prepare("SELECT id, status, fire_count FROM standing_intents").all(),
        ).toEqual([{ id: expectedId, status: "armed", fire_count: 0 }]);
      } finally {
        reopened.close();
      }
    }
  });

  it("uses admission-time default matching time after waiting for a writer", async () => {
    const existing = await seed(true);
    const held = await holdWriter();
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const work = keep(matchStandingIntents({ agentId: "main", prompt: "launch" }));
    try {
      await expectWaiting(work, held.entered);
    } finally {
      // Only queue-time host reads see 100; the admitted native worker keeps its real clock.
      clock.mockRestore();
      held.release();
    }
    await expect(work).resolves.toEqual([]);
    await held.done;
    expect(readStored(existing.id)).toMatchObject({ status: "expired", fire_count: 0 });
    expect(
      openOpenClawAgentDatabase({ agentId: "main" })
        .db.prepare("SELECT expires_at FROM standing_intents WHERE id = ?")
        .get(existing.id)?.expires_at,
    ).toBe(200);
  });

  it("serializes concurrent matching inside the original fire-budget transaction", async () => {
    const existing = await seed();
    const held = await holdWriter();
    const first = keep(
      Promise.resolve(matchStandingIntents({ agentId: "main", prompt: "launch" })),
    );
    const second = keep(
      Promise.resolve(matchStandingIntents({ agentId: "main", prompt: "launch" })),
    );
    await expectWaiting(first, held.entered);
    held.release();
    const results = await Promise.all([first, second]);
    expect(results.flat().length).toBe(1);
    expect(readStored(existing.id)?.fire_count).toBe(1);
  });

  it("retains the admitted database identity when the ambient state path changes", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const held = await holdWriter();
    const work = keep(Promise.resolve(seed()));
    await expectWaiting(work, held.entered);
    const replacementState = tempDirs.make("standing-intent-other-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", replacementState);
    const otherPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    held.release();
    const created = await work;
    expect(fs.existsSync(otherPath)).toBe(false);
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    const reopened = new DatabaseSync(databasePath);
    try {
      expect(
        reopened.prepare("SELECT description FROM standing_intents WHERE id = ?").get(created.id)
          ?.description,
      ).toBe("Confirm the rollback owner.");
    } finally {
      reopened.close();
    }
    expect(path.dirname(databasePath).startsWith(stateDir)).toBe(true);
  });
});
