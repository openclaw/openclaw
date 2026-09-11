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
import { createStandingIntentTool } from "./standing-intents-tool.js";
import {
  createStandingIntent,
  listStandingIntents,
  matchStandingIntents,
} from "./standing-intents.js";

const admission = vi.hoisted(() => ({
  pause: undefined as ((db: DatabaseSync) => Promise<void>) | undefined,
  started: undefined as (() => void) | undefined,
  operations: [] as Promise<unknown>[],
}));

// Delay the operation inside the real admission owner so its actual connection
// and original path remain retained while the registered caller is waiting.
vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-runtime")>();
  return {
    ...actual,
    withOpenClawAgentDatabaseAsync: <T>(
      options: Parameters<typeof actual.openOpenClawAgentDatabase>[0],
      operation: (database: ReturnType<typeof actual.openOpenClawAgentDatabase>) => T | Promise<T>,
      assertCurrent?: () => void,
    ): Promise<T> => {
      const pause = admission.pause;
      const work = actual.withOpenClawAgentDatabaseAsync(
        options,
        pause
          ? async (database) => {
              await pause(database.db);
              return await operation(database);
            }
          : operation,
        assertCurrent,
      );
      admission.operations.push(work);
      void work.catch(() => {});
      admission.started?.();
      return work;
    },
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pending: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.allSettled([...pending.splice(0), ...admission.operations.splice(0)]);
    admission.pause = undefined;
    admission.started = undefined;
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

function holdAdmission(failure?: Error) {
  const entered = deferred();
  const finish = deferred();
  releases.push(finish.resolve);
  admission.pause = async () => {
    entered.resolve();
    await finish.promise;
    if (failure) {
      throw failure;
    }
  };
  return { entered: entered.promise, release: finish.resolve };
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

function registerHooks() {
  const config: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const builder = createPluginRegistry({
    logger,
    runtime: createPluginRuntimeMock({ config: { current: () => config } }),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "memory-core", origin: "bundled", kind: "memory" });
  builder.registry.plugins.push(record);
  plugin.register(builder.createApi(record, { config, registrationMode: "full" }));
  setActivePluginRegistry(builder.registry);
  initializeGlobalHookRunner(builder.registry);
  const runner = getGlobalHookRunner();
  if (!runner) {
    throw new Error("Expected the real registered hook runner");
  }
  return { runner, logger, registry: builder.registry };
}

const context = {
  agentId: "main",
  sessionKey: "agent:main:intent-proof",
  sessionId: "intent-proof",
  messageProvider: "webchat",
  senderId: "owner",
};

describe("standing-intent admitted operations", () => {
  it.each(["create", "list", "cancel"] as const)(
    "awaits %s before the tool reports success",
    async (action) => {
      const existing = await seed();
      const held = holdAdmission();
      const tool = createStandingIntentTool({
        agentId: "main",
        provider: "webchat",
        senderId: "owner",
      });
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
      admission.pause = undefined;
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
    "propagates rejected %s admission without changing rows",
    async (action) => {
      const existing = await seed();
      const failure = new Error("fixture database admission rejected");
      const held = holdAdmission(failure);
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
      held.release();
      await expect(work).rejects.toBe(failure);
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
    const { runner } = registerHooks();
    const held = holdAdmission();
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
    const { runner, logger } = registerHooks();
    const held = holdAdmission(new Error("fixture matching admission rejected"));
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
    const { runner } = registerHooks();
    const held = holdAdmission();
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
      await Promise.allSettled(admission.operations);
      expect(readStored(existing.id)).toMatchObject({ status: "armed", fire_count: 0 });
    } finally {
      held.release();
      vi.useRealTimers();
    }
  });

  it("skips matching with a diagnostic when the host lacks the invocation capability", async () => {
    const existing = await seed();
    const { runner, registry, logger } = registerHooks();
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

  it("preserves a live caller sharing the expired hook's cold database admission", async () => {
    const existing = await seed();
    const { runner } = registerHooks();
    closeOpenClawAgentDatabasesForTest();
    const started = deferred();
    admission.started = started.resolve;
    const held = holdAdmission();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hookWork = keep(
        runner.runBeforePromptBuild(
          { prompt: "launch", messages: [] },
          { ...context, trigger: "user" },
        ),
      );
      await started.promise;
      const liveCaller = keep(listStandingIntents({ agentId: "main" }));
      // Expire the hook before the native cold-open child can deliver its result.
      vi.advanceTimersByTime(15_000);
      expect(await hookWork).toBeUndefined();
      await expectWaiting(liveCaller, held.entered);
      held.release();
      await expect(liveCaller).resolves.toMatchObject([
        { id: existing.id, status: "armed", fireCount: 0 },
      ]);
      await Promise.allSettled(admission.operations);
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
      const { runner } = registerHooks();
      const held = holdAdmission();
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
    const held = holdAdmission();
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
    const held = holdAdmission();
    const work = keep(Promise.resolve(seed()));
    await expectWaiting(work, held.entered);
    const replacementState = tempDirs.make("standing-intent-other-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", replacementState);
    const otherPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    held.release();
    const created = await work;
    expect(fs.existsSync(otherPath)).toBe(false);
    admission.pause = undefined;
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
