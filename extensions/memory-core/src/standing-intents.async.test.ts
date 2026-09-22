import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withSessionTranscriptWriteLock } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { createStandingIntentTool } from "./standing-intents-tool.js";
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
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.allSettled(pending.splice(0));
    await Promise.allSettled(writerDrains.splice(0).map((drain) => drain()));
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
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

async function holdWriter(beforeRelease?: () => void) {
  const target = {
    agentId: "main",
    sessionId: "standing-intent-writer",
    sessionKey: "agent:main:standing-intent-writer",
    storePath: resolveStorePath(undefined, { agentId: "main" }),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const entered = deferred();
  const finish = deferred();
  releases.push(finish.resolve);
  const done = keep(
    withSessionTranscriptWriteLock(target, async () => {
      entered.resolve();
      await finish.promise;
      beforeRelease?.();
    }),
  );
  const drain = () => withSessionTranscriptWriteLock(target, () => undefined);
  writerDrains.push(drain);
  await Promise.race([entered.promise, done]);
  return { entered: entered.promise, release: finish.resolve, done, drain };
}

function failStandingIntentWrites(action: "create" | "list" | "cancel" | "match") {
  const operation = action === "create" ? "INSERT" : "UPDATE";
  openOpenClawAgentDatabase({ agentId: "main" }).db.exec(`
    CREATE TRIGGER fail_standing_intent BEFORE ${operation} ON standing_intents
    BEGIN SELECT RAISE(ABORT, 'fixture standing-intent write rejected'); END;
  `);
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

async function registeredIntentTool() {
  const { registry, config } = await registerHooks();
  const registration = registry.tools.find((tool) => tool.names.includes("intent"));
  const registered = registration?.factory({
    ...context,
    config,
    senderIsOwner: true,
    messageChannel: "webchat",
    requesterSenderId: "owner",
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
      held.release();
      const result = await work;
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
    },
  );

  it.each(["create", "list", "cancel"] as const)(
    "propagates rejected %s writes without changing rows",
    async (action) => {
      const existing = await seed(action === "list");
      failStandingIntentWrites(action);
      const held = await holdWriter();
      const tool = createStandingIntentTool({
        agentId: "main",
        provider: "webchat",
        senderId: "owner",
      });
      const work = keep(
        tool.execute("intent-call", {
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
    held.release();
    expect((await work)?.prependContext).toContain("Confirm the rollback owner.");
    expect(readStored(existing.id)?.fire_count).toBe(1);
    expect(readStored(existing.id)?.status).toBe("done");
  });

  it("keeps rejected prompt matching fail-open without spending its fire budget", async () => {
    const existing = await seed();
    const { runner, logger } = await registerHooks();
    failStandingIntentWrites("match");
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
    const held = await holdWriter(closeOpenClawAgentDatabasesForTest);
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
      held.release();
      await work;
      expect(readStored(existing.id)?.status).toBe("expired");
    },
  );

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
