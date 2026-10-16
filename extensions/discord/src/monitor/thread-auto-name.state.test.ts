import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
  type OpenClawStateKyselyDatabaseForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";

vi.mock("../runtime.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...original,
    getDiscordRuntime: () => ({
      state: {
        openKeyedStoreV2: <T>(options: OpenAsyncKeyedStoreOptions) =>
          createPluginStateKeyedStoreV2ForTests<T>("discord", options, { assertCurrent() {} }),
      },
    }),
  };
});

import {
  DiscordThreadAutoNameState,
  DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS,
  DISCORD_THREAD_AUTO_NAME_RATE_WINDOW_MS,
} from "./thread-auto-name.state.js";

const CLAIMS_NAMESPACE = "thread-auto-name-claims";
const RATE_NAMESPACE = "thread-auto-name-rate";

function openClaims() {
  return createPluginStateKeyedStoreV2ForTests<boolean>(
    "discord",
    {
      namespace: CLAIMS_NAMESPACE,
      maxEntries: 10_000,
      overflowPolicy: "reject-new",
      defaultTtlMs: DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS,
    },
    { assertCurrent() {} },
  );
}

function openRate() {
  return createPluginStateKeyedStoreV2ForTests<number[]>(
    "discord",
    {
      namespace: RATE_NAMESPACE,
      maxEntries: 10_000,
      overflowPolicy: "reject-new",
      defaultTtlMs: DISCORD_THREAD_AUTO_NAME_RATE_WINDOW_MS,
    },
    { assertCurrent() {} },
  );
}

type SeedEntry = {
  namespace: string;
  key: string;
  value: boolean | number[];
  createdAt: number;
  expiresAt: number;
};

async function seedEntries(state: OpenClawTestState, entries: SeedEntry[]): Promise<void> {
  // Only fixture preparation writes natively. Close all workers first and hand
  // ownership back before exercising the production state helper.
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  const { db } = openOpenClawStateDatabase({ env: state.env });
  const kysely =
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabaseForTests, "plugin_state_entries">>(db);
  for (let offset = 0; offset < entries.length; offset += 512) {
    const rows = entries.slice(offset, offset + 512).map((entry) => ({
      plugin_id: "discord",
      namespace: entry.namespace,
      entry_key: entry.key,
      value_json: JSON.stringify(entry.value),
      created_at: entry.createdAt,
      expires_at: entry.expiresAt,
    }));
    executeSqliteQuerySync(db, kysely.insertInto("plugin_state_entries").values(rows));
  }
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

async function closeStores(): Promise<void> {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

describe("DiscordThreadAutoNameState worker persistence", () => {
  it("persists expiring claims across a physical reopen and deletes only the owning account's claim", async () => {
    await withOpenClawTestState({ label: "discord-auto-name-claims" }, async () => {
      const observation = observeHostDataSql();
      try {
        const storage = new DiscordThreadAutoNameState({ accountId: "work" });
        const sibling = new DiscordThreadAutoNameState({ accountId: "sibling" });
        expect(await storage.claim("thread")).toBe(true);
        expect(await storage.claim("thread")).toBe(false);
        expect(await sibling.claim("thread")).toBe(true);
        await closeStores();

        const restarted = new DiscordThreadAutoNameState({ accountId: "work" });
        expect(await restarted.hasClaim("thread")).toBe(true);
        expect(await restarted.claim("thread")).toBe(false);
        const entries = await openClaims().entries();
        expect(entries.map((entry) => entry.key).toSorted()).toEqual([
          "sibling:thread",
          "work:thread",
        ]);
        for (const entry of entries) {
          expect(entry.value).toBe(true);
          expect(entry.expiresAt! - entry.createdAt).toBe(DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS);
        }
        await restarted.deleteClaim("thread");
        expect(await restarted.hasClaim("thread")).toBe(false);
        expect(await sibling.hasClaim("thread")).toBe(true);
        expect(observation.queries).toEqual([]);
      } finally {
        observation.restore();
        await closeStores();
      }
    });
  });

  it("shares exactly two rolling reservations across instances and a physical close/reopen", async () => {
    await withOpenClawTestState({ label: "discord-auto-name-restart" }, async () => {
      let now = Date.now();
      try {
        const first = new DiscordThreadAutoNameState({ accountId: "work", nowMs: () => now });
        const second = new DiscordThreadAutoNameState({ accountId: "work", nowMs: () => now });
        const reservations = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            (index % 2 === 0 ? first : second).reserveRename("parent"),
          ),
        );
        expect(reservations.filter(Boolean)).toHaveLength(2);
        await closeStores();
        const restarted = new DiscordThreadAutoNameState({ accountId: "work", nowMs: () => now });
        expect(await restarted.reserveRename("parent")).toBe(false);
        expect(await restarted.reserveRename("different-parent")).toBe(true);
        const sibling = new DiscordThreadAutoNameState({ accountId: "sibling", nowMs: () => now });
        expect(await sibling.reserveRename("parent")).toBe(true);
        now += DISCORD_THREAD_AUTO_NAME_RATE_WINDOW_MS;
        expect(await restarted.reserveRename("parent")).toBe(true);
        expect(await restarted.reserveRename("parent")).toBe(true);
        expect(await restarted.reserveRename("parent")).toBe(false);
        expect(await openRate().lookup("work:parent")).toEqual([now, now]);
      } finally {
        await closeStores();
      }
    });
  });

  it("rejects new claims and budgets at 10,000 rows and recovers capacity from expired rows", async () => {
    await withOpenClawTestState({ label: "discord-auto-name-capacity" }, async (state) => {
      const now = Date.now();
      const entries = Array.from({ length: 10_000 }, (_, index) => ({
        namespace: CLAIMS_NAMESPACE,
        key: `work:thread-${index}`,
        value: true,
        createdAt: now,
        expiresAt: now + DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS,
      }));
      const rateEntries = entries.map((entry, index) => ({
        ...entry,
        namespace: RATE_NAMESPACE,
        key: `work:parent-${index}`,
        value: [now],
        expiresAt: now + DISCORD_THREAD_AUTO_NAME_RATE_WINDOW_MS,
      }));
      await seedEntries(state, [...entries, ...rateEntries]);
      try {
        const storage = new DiscordThreadAutoNameState({ accountId: "work" });
        expect(await storage.claim("overflow")).toBe(false);
        expect(await storage.reserveRename("overflow")).toBe(false);
        expect(await storage.hasClaim("thread-0")).toBe(true);
        expect(await openClaims().count()).toBe(10_000);
        expect(await openRate().count()).toBe(10_000);

        await closeStores();
        const { db } = openOpenClawStateDatabase({ env: state.env });
        const kysely =
          getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabaseForTests, "plugin_state_entries">>(
            db,
          );
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("plugin_state_entries")
            .set({ expires_at: Date.now() - 1 })
            .where("plugin_id", "=", "discord")
            .where("entry_key", "in", ["work:thread-0", "work:parent-0"]),
        );
        await closeStores();

        const reopened = new DiscordThreadAutoNameState({ accountId: "work" });
        expect(await reopened.claim("overflow")).toBe(true);
        expect(await reopened.reserveRename("overflow")).toBe(true);
        expect(await openClaims().lookup("work:thread-0")).toBeUndefined();
        expect(await openRate().lookup("work:parent-0")).toBeUndefined();
        expect(await openClaims().count()).toBe(10_000);
        expect(await openRate().count()).toBe(10_000);
      } finally {
        await closeStores();
      }
    });
  });
});
