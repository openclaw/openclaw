import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteAdmission,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  useSqliteWorkerFault,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { createStandingIntentExecutor } from "./standing-intents-tool.js";
import {
  createStandingIntent,
  cancelStandingIntent,
  listStandingIntents,
  matchStandingIntents,
  startStandingIntentMaintenance,
} from "./standing-intents.js";

const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const writerDrains: Array<() => Promise<unknown>> = [];
const writeActions = ["create", "list", "cancel", "match"] as const;
const writeFault = useSqliteWorkerFault(
  writeActions.map((action) => {
    const insert = action === "create";
    const condition = insert
      ? ""
      : action === "match"
        ? "WHEN NEW.fire_count != OLD.fire_count"
        : `WHEN NEW.status = '${action === "list" ? "expired" : "cancelled"}'`;
    return {
      match: new RegExp(`^${insert ? "insert into" : "update"} standing_intents `),
      name: `reject_intent_${action}`,
      sql: `CREATE TEMP TRIGGER reject_intent_${action}
        BEFORE ${insert ? "INSERT" : "UPDATE"} ON standing_intents ${condition}
        BEGIN SELECT RAISE(ABORT, 'fixture standing-intent write rejected'); END`,
    };
  }),
);
const failStandingIntentWrites = (action: (typeof writeActions)[number]) =>
  writeFault.enable(writeActions.indexOf(action));
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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
      await closeAgents();
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
  const entered = createDeferred<void>();
  const finish = createDeferred<void>();
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

async function expectWaiting(work: Promise<unknown>, entered: Promise<void>) {
  let settled = false;
  const onSettled = () => {
    settled = true;
  };
  void work.then(onSettled, onSettled);
  await Promise.race([entered, work.catch(() => undefined)]);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(settled).toBe(false);
}

async function queue<T>(start: () => Promise<T>) {
  const held = await holdWriter();
  const work = keep(start());
  await expectWaiting(work, held.entered);
  return { ...held, work };
}

async function closeAgents(directory?: string) {
  await closeOpenClawAgentDatabasesAsync(directory);
  closeOpenClawAgentDatabasesForTest();
}

function withDatabase<T>(filename: string, read: (db: DatabaseSync) => T) {
  using db = new DatabaseSync(filename, { readOnly: true });
  return read(db);
}
type IntentDatabase = ReturnType<typeof openOpenClawAgentDatabase>["db"];
const rowCount = (db: IntentDatabase) =>
  db.prepare("SELECT COUNT(*) AS count FROM standing_intents").get()?.count;
const storedStatus = (db: IntentDatabase, id: string) =>
  db.prepare("SELECT status FROM standing_intents WHERE id = ?").get(id)?.status;
async function readDurable<T>(read: (db: DatabaseSync) => T) {
  const filename = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  await closeAgents();
  return withDatabase(filename, read);
}
const intentArgs = (action: string, id: string) => ({
  action,
  id,
  description: "Check the migration.",
  triggerKeywords: ["migration"],
});
const promptHook = (runner: NonNullable<ReturnType<typeof getGlobalHookRunner>>) =>
  runner.runBeforePromptBuild({ prompt: "launch", messages: [] }, { ...context, trigger: "user" });

function maintenance() {
  const clock = createGatewaySchedulerClock(1_000);
  const gateway = createTestGatewayScheduler(clock.clock);
  const scheduler = createTestPluginServiceScheduler(gateway);
  const warn = vi.fn();
  const stop = startStandingIntentMaintenance({ agentIds: ["main"], scheduler, warn });
  releases.push(stop);
  writerDrains.push(async () => {
    await scheduler.stop();
    await gateway.stop();
  });
  return { clock, gateway, warn, stop };
}

const expiredSeed = { nowMs: 100, expiresAt: 200 };
async function seed(options: Partial<Parameters<typeof createStandingIntent>[0]> = {}) {
  return await createStandingIntent({
    agentId: "main",
    description: "Confirm the rollback owner.",
    triggerKeywords: ["launch"],
    creatorSender: "owner",
    maxFires: 1,
    ...options,
  });
}

function readStored(id: string) {
  return openOpenClawAgentDatabase({ agentId: "main" })
    .db.prepare("SELECT status, fire_count, expires_at FROM standing_intents WHERE id = ?")
    .get(id);
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
  it("reuses service-owned absence without hiding a queued creation or another agent", async () => {
    const { clock, stop } = maintenance();
    await clock.wake();
    const match = () => matchStandingIntents({ agentId: "main", prompt: "launch", nowMs: 1_000 });
    await expect(match()).resolves.toEqual([]);
    // Startup recovery must not create an unused agent database.
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }))).toBe(false);

    const other = await seed({ agentId: "other" });
    await expect(
      matchStandingIntents({ agentId: "other", prompt: "launch" }),
    ).resolves.toMatchObject([{ id: other.id, fireCount: 1 }]);

    const held = await holdWriter();
    const created = keep(seed());
    const matching = keep(match());
    await expectWaiting(matching, held.entered);
    held.release();
    const intent = await created;
    await expect(matching).resolves.toMatchObject([{ id: intent.id, fireCount: 1 }]);
    await held.done;
    await clock.wake();
    await expect(match()).resolves.toEqual([]);

    stop();
    await expect(match()).resolves.toEqual([]);
  });

  it("recovers overdue intents at restart and schedules writes and cooldowns while idle", async () => {
    const expired = await seed({ nowMs: 0, expiresAt: 500 });
    await closeAgents();
    const { clock, gateway, warn } = maintenance();
    await clock.wake();
    expect(readStored(expired.id)?.status).toBe("expired");
    expect(gateway.nextWakeAtMs).toBeNull();

    const intent = await seed({
      nowMs: 1_000,
      expiresAt: 5_000,
      cooldownSeconds: 1,
      maxFires: 3,
    });
    await clock.wake();
    expect(gateway.nextWakeAtMs).toBe(5_000);
    await matchStandingIntents({ agentId: "main", prompt: "launch", nowMs: 1_000 });
    await clock.wake();
    expect(gateway.nextWakeAtMs).toBe(2_000);
    await clock.advanceTo(2_000);
    expect(readStored(intent.id)?.status).toBe("armed");
    expect(gateway.nextWakeAtMs).toBe(5_000);
    await clock.advanceTo(5_000);
    expect(readStored(intent.id)?.status).toBe("expired");
    expect(gateway.nextWakeAtMs).toBeNull();

    const cancelled = await seed({ nowMs: 5_000, expiresAt: 10_000 });
    await clock.wake();
    await cancelStandingIntent({ agentId: "main", id: cancelled.id });
    await clock.wake();
    expect(gateway.nextWakeAtMs).toBeNull();
    await clock.advanceBy(300_000);
    expect(gateway.nextWakeAtMs).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["owner revocation", "create"],
    ["owner revocation", "list"],
    ["owner revocation", "cancel"],
    ["write failure", "create"],
    ["write failure", "list"],
    ["write failure", "cancel"],
  ] as const)("%s rejects %s without changing rows", async (failure, action) => {
    const existing = await seed(action === "list" ? expiredSeed : {});
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("owner revoked");
      }
    };
    const revoked = failure === "owner revocation";
    const execute = revoked
      ? (await registeredIntentTool(assertCurrent)).execute
      : createStandingIntentExecutor({
          agentId: "main",
          provider: "webchat",
          senderId: "owner",
        });
    if (!revoked) {
      failStandingIntentWrites(action);
    }
    const { work, release, drain } = await queue(() =>
      execute("intent-call", intentArgs(action, existing.id)),
    );
    current = false;
    release();
    await expect(work).rejects.toThrow(
      revoked ? "owner revoked" : "fixture standing-intent write rejected",
    );
    await drain();
    await readDurable((db) => {
      expect([storedStatus(db, existing.id), rowCount(db)]).toEqual(["armed", 1]);
    });
  });

  it("restores first-use schema and creates once under the queued writer", async () => {
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
    await readDurable((durable) => {
      expect(rowCount(durable)).toBe(1);
      expect(durable.prepare("SELECT id, status, fire_count FROM standing_intents").get()).toEqual({
        id: created.id,
        status: "armed",
        fire_count: 0,
      });
    });
  });

  it.each(["create", "cancel"] as const)(
    "awaits %s before the registered tool reports success",
    async (action) => {
      const existing = await seed();
      const tool = await registeredIntentTool();
      const { work, release } = await queue(() =>
        tool.execute("intent-call", intentArgs(action, existing.id)),
      );
      release();
      const result = await work;
      const text = result.content.find((item) => item.type === "text")?.text ?? "";
      const payload: unknown = JSON.parse(text);
      expect(payload).toMatchObject(
        action === "cancel"
          ? { cancelled: true }
          : { intent: { description: "Check the migration." } },
      );
      await readDurable((db) => {
        expect(rowCount(db)).toBe(action === "create" ? 2 : 1);
        if (action === "cancel") {
          expect(storedStatus(db, existing.id)).toBe("cancelled");
        }
      });
    },
  );

  it("waits for the registered prompt hook's claim before injecting context", async () => {
    const existing = await seed();
    const { runner } = await registerHooks();
    const { work, release } = await queue(() => promptHook(runner));
    expect(readStored(existing.id)?.fire_count).toBe(0);
    release();
    expect((await work)?.prependContext).toContain("Confirm the rollback owner.");
    expect(readStored(existing.id)).toMatchObject({ fire_count: 1, status: "done" });
  });

  it("keeps rejected prompt matching fail-open without spending its fire budget", async () => {
    const existing = await seed();
    const { runner, logger } = await registerHooks();
    failStandingIntentWrites("match");
    const { work, release } = await queue(() => promptHook(runner));
    release();
    expect((await work)?.prependContext).toBeUndefined();
    expect(readStored(existing.id)?.fire_count).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("standing intent matching failed"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("fixture standing-intent write rejected"),
    );
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
    const hookWork = keep(promptHook(runner));
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
  });

  it("refuses a queued create when its original database path is replaced", async () => {
    const replacementState = tempDirs.make("standing-intent-replacement-");
    vi.stubEnv("OPENCLAW_STATE_DIR", replacementState);
    const replacement = await seed();
    const replacementPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await closeAgents();

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const original = await seed();
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const retiredPath = `${databasePath}.retired`;
    await closeAgents();
    const { dev, ino } = fs.statSync(databasePath);
    expect(fs.statSync(replacementPath)).not.toMatchObject({ dev, ino });

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
    await closeAgents();

    for (const { filename, expectedId } of [
      { filename: retiredPath, expectedId: original.id },
      { filename: databasePath, expectedId: replacement.id },
    ]) {
      withDatabase(filename, (db) => {
        expect(db.prepare("SELECT id, status, fire_count FROM standing_intents").all()).toEqual([
          { id: expectedId, status: "armed", fire_count: 0 },
        ]);
      });
    }
  });

  it("uses admission-time default matching time after waiting for a writer", async () => {
    const existing = await seed(expiredSeed);
    const held = await holdWriter();
    const clock = vi.spyOn(Date, "now").mockReturnValue(100);
    const work = keep(matchStandingIntents({ agentId: "main", prompt: "launch" }));
    await expectWaiting(work, held.entered);
    // Only queue-time host reads see 100; the admitted native worker keeps its real clock.
    clock.mockRestore();
    held.release();
    await expect(work).resolves.toEqual([]);
    await held.done;
    expect(readStored(existing.id)).toMatchObject({
      status: "expired",
      fire_count: 0,
      expires_at: 200,
    });
  });

  it("serializes concurrent matching inside the original fire-budget transaction", async () => {
    const existing = await seed();
    const held = await holdWriter();
    const first = keep(matchStandingIntents({ agentId: "main", prompt: "launch" }));
    const second = keep(matchStandingIntents({ agentId: "main", prompt: "launch" }));
    await expectWaiting(first, held.entered);
    held.release();
    const results = await Promise.all([first, second]);
    expect(results.flat().length).toBe(1);
    expect(readStored(existing.id)?.fire_count).toBe(1);
  });

  it("retains the admitted database identity when the ambient state path changes", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const { work, release } = await queue(() => seed());
    const replacementState = tempDirs.make("standing-intent-other-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", replacementState);
    const otherPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    release();
    const created = await work;
    expect(fs.existsSync(otherPath)).toBe(false);
    await closeAgents();
    withDatabase(databasePath, (db) => {
      expect(
        db.prepare("SELECT description FROM standing_intents WHERE id = ?").get(created.id)
          ?.description,
      ).toBe("Confirm the rollback owner.");
    });
    expect(path.dirname(databasePath).startsWith(stateDir)).toBe(true);
  });
});
