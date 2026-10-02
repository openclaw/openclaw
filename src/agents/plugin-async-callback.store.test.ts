import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  PLUGIN_CALLBACK_MAX_PENDING,
  pluginAsyncCallbackSlot,
} from "./plugin-async-callback-policy.js";
import {
  cancelPluginAsyncCallbackInDatabase,
  completePluginAsyncCallbackInDatabase,
  findPluginAsyncCallbackInDatabase,
  expirePluginAsyncCallbackInDatabase,
  issuePluginAsyncCallbackInDatabase,
  readPluginAsyncCallbackStatusInDatabase,
  settlePluginAsyncCallbackInDatabase,
} from "./plugin-async-callback.store.js";

// This is the documented contract, not an import of the implementation threshold.
const EXPECTED_PLUGIN_LIMIT = 100;
const dirs = useAutoCleanupTempDirTracker(afterEach);
const base = {
  pluginId: "example",
  toolName: "render",
  childSessionKey: "agent:main:subagent:first",
  childSessionId: "first-session",
  childRunId: "first-run",
  childCreatedAt: 1,
};

describe("durable plugin callback claim and outbox", () => {
  let database: OpenClawStateDatabase;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    const dir = dirs.make("openclaw-plugin-callback-", resolvePreferredOpenClawTmpDir());
    env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    database = openOpenClawStateDatabase({ env });
  });
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests();
  });

  const transact = <T>(db: OpenClawStateDatabase, work: () => T): T =>
    runOpenClawStateWriteTransaction(work, { database: db });
  const queue = (db: OpenClawStateDatabase) =>
    db.db
      .prepare(
        "SELECT entry_json FROM delivery_queue_entries WHERE queue_name = 'session-native-child'",
      )
      .all()
      .filter((row) => !JSON.parse(String(row.entry_json)).callbackExpiryKey) as Array<{
      entry_json: string;
    }>;

  it.each([false, true])(
    "keeps an expiry outcome after receipt GC without overriding an accepted result (%s)",
    (accepted) => {
      const now = 10_000;
      const issued = transact(database, () =>
        issuePluginAsyncCallbackInDatabase(database, base, 1_000, now),
      );
      const key = createHash("sha256").update(issued.token).digest("hex");
      if (accepted) {
        transact(database, () =>
          completePluginAsyncCallbackInDatabase({
            database,
            token: issued.token,
            resultText: "retained result",
            now: now + 1,
            assertOwnerCurrent: () => {},
          }),
        );
      }
      // The real GC predicate is expires_at <= now; only receipt rows are eligible.
      database.db
        .prepare("DELETE FROM plugin_state_entries WHERE expires_at <= ?")
        .run(issued.expiresAt + 24 * 60 * 60_000);
      expect(findPluginAsyncCallbackInDatabase(database, issued.token)).toBeUndefined();
      expect(
        transact(database, () =>
          expirePluginAsyncCallbackInDatabase(
            database,
            key,
            issued.expiresAt + 2 * 24 * 60 * 60_000,
          ),
        ),
      ).toBe(!accepted);
      transact(database, () =>
        settlePluginAsyncCallbackInDatabase(database, {
          key,
          slot: pluginAsyncCallbackSlot(base),
          queueId: issued.queueId,
          expiry: true,
          outcome: "delivered",
        }),
      );
      if (accepted) {
        expect(() =>
          transact(database, () => issuePluginAsyncCallbackInDatabase(database, base, 1_000)),
        ).toThrow("outstanding callback");
      } else {
        expect(
          transact(database, () => issuePluginAsyncCallbackInDatabase(database, base, 1_000)).token,
        ).toBeTruthy();
      }
    },
  );

  it("rejects a callback beyond the 24-hour redemption bound before persistence", () => {
    expect(() =>
      transact(database, () =>
        issuePluginAsyncCallbackInDatabase(database, base, 24 * 60 * 60_000 + 1),
      ),
    ).toThrow("deadline");
    expect(
      database.db.prepare("SELECT count(*) AS count FROM delivery_queue_entries").get(),
    ).toMatchObject({ count: 0 });
  });

  it("retains ordinary receipts for one day after the separate redemption deadline", () => {
    const now = 10_000;
    const issued = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(database, base, 24 * 60 * 60_000, now),
    );
    expect(issued.expiresAt).toBe(now + 24 * 60 * 60_000);
    const key = createHash("sha256").update(issued.token).digest("hex");
    expect(
      database.db
        .prepare("SELECT expires_at FROM plugin_state_entries WHERE entry_key = ?")
        .get(key),
    ).toMatchObject({ expires_at: issued.expiresAt + 24 * 60 * 60_000 });
  });

  it("allows only one outstanding callback for a native child across plugins", () => {
    const first = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(database, base, 60_000),
    );
    const second = { ...base, pluginId: "other", toolName: "verify" };
    expect(() =>
      transact(database, () => issuePluginAsyncCallbackInDatabase(database, second, 60_000)),
    ).toThrow("outstanding callback");
    expect(
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: first.token,
          resultText: "first result",
          assertOwnerCurrent: () => {},
        }),
      ).status,
    ).toBe("accepted");
    // Queued is not delivered: keep the reservation until the delivery owner settles it.
    expect(() =>
      transact(database, () => issuePluginAsyncCallbackInDatabase(database, second, 60_000)),
    ).toThrow("outstanding callback");
    expect(queue(database)).toHaveLength(1);
  });

  it("never admits an incognito binding to durable callback storage", () => {
    expect(() =>
      transact(database, () =>
        issuePluginAsyncCallbackInDatabase(
          database,
          { ...base, childSessionKey: "agent:main:subagent:incognito-private" },
          60_000,
        ),
      ),
    ).toThrow("memory-only owner");
    expect(
      database.db.prepare("SELECT count(*) AS count FROM plugin_state_entries").get(),
    ).toMatchObject({ count: 0 });
    expect(
      database.db.prepare("SELECT count(*) AS count FROM delivery_queue_entries").get(),
    ).toMatchObject({ count: 0 });
  });

  it("refuses a plugin burst without evicting admitted callbacks and frees cancelled capacity", () => {
    const issued = transact(database, () =>
      Array.from({ length: EXPECTED_PLUGIN_LIMIT }, (_, index) =>
        issuePluginAsyncCallbackInDatabase(
          database,
          { ...base, childRunId: "burst-" + index },
          60_000,
        ),
      ),
    );
    const next = { ...base, childRunId: "burst-next" };
    expect(() =>
      transact(database, () => issuePluginAsyncCallbackInDatabase(database, next, 60_000)),
    ).toThrow("capacity reached");
    expect(findPluginAsyncCallbackInDatabase(database, issued[0]!.token)).toMatchObject({
      status: "pending",
    });
    transact(database, () =>
      cancelPluginAsyncCallbackInDatabase(database, issued[0]!.token, () => {}),
    );
    expect(
      transact(database, () => issuePluginAsyncCallbackInDatabase(database, next, 60_000)).token,
    ).toBeTruthy();
  });

  it("bounds total outstanding callbacks across plugin namespaces", () => {
    transact(database, () => {
      for (let index = 0; index < PLUGIN_CALLBACK_MAX_PENDING; index += 1) {
        issuePluginAsyncCallbackInDatabase(
          database,
          {
            ...base,
            pluginId: "global-" + Math.floor(index / EXPECTED_PLUGIN_LIMIT),
            childRunId: "global-" + index,
          },
          60_000,
        );
      }
    });
    expect(() =>
      transact(database, () =>
        issuePluginAsyncCallbackInDatabase(
          database,
          { ...base, pluginId: "new-plugin", childRunId: "global-overflow" },
          60_000,
        ),
      ),
    ).toThrow("capacity reached");
  });

  it.each(["delivered", "failed"] as const)(
    "records %s separately from acceptance and fences late slot cleanup",
    (outcome) => {
      const first = transact(database, () =>
        issuePluginAsyncCallbackInDatabase(database, base, 60_000),
      );
      const status = () =>
        transact(database, () =>
          readPluginAsyncCallbackStatusInDatabase(database, first.token, () => {}),
        );
      expect(status()).toEqual({
        status: "pending",
        expiresAt: first.expiresAt,
        storage: "persistent",
      });
      const accepted = transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: first.token,
          resultText: "bounded result",
          assertOwnerCurrent: () => {},
        }),
      );
      expect(accepted.status).toBe("accepted");
      if (accepted.status !== "accepted") {
        throw new Error("missing admitted callback result");
      }
      expect(status().status).toBe("accepted");
      const key = createHash("sha256").update(first.token).digest("hex");
      const settle = () =>
        transact(database, () =>
          settlePluginAsyncCallbackInDatabase(database, {
            key,
            slot: pluginAsyncCallbackSlot(base),
            queueId: accepted.queueId,
            expiry: false,
            outcome,
          }),
        );
      // The obsolete expiry receipt cannot release an accepted result's reservation.
      transact(database, () =>
        settlePluginAsyncCallbackInDatabase(database, {
          key,
          slot: pluginAsyncCallbackSlot(base),
          queueId: first.queueId,
          expiry: true,
          outcome: "delivered",
        }),
      );
      expect(() =>
        transact(database, () => issuePluginAsyncCallbackInDatabase(database, base, 60_000)),
      ).toThrow("outstanding callback");
      settle();
      expect(status().status).toBe(outcome);
      const next = transact(database, () =>
        issuePluginAsyncCallbackInDatabase(database, base, 60_000),
      );
      settle();
      expect(findPluginAsyncCallbackInDatabase(database, next.token)?.status).toBe("pending");
      expect(() =>
        transact(database, () => issuePluginAsyncCallbackInDatabase(database, base, 60_000)),
      ).toThrow("outstanding callback");
    },
  );

  it("keeps the host callback binding outside plugin-owned state namespaces", () => {
    const issued = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(database, base, 60_000),
    );
    const key = createHash("sha256").update(issued.token).digest("hex");
    const spoofedHost = createPluginStateSyncKeyedStore("@openclaw-host", {
      namespace: "async-tool-callback",
      maxEntries: 10,
      env,
    });
    expect(spoofedHost.lookup(key)).toBeUndefined();
    spoofedHost.register(key, {
      ...base,
      status: "pending",
      childSessionKey: "agent:main:subagent:other",
      childRunId: "other-run",
      expiresAt: Date.now() + 60_000,
    });
    expect(findPluginAsyncCallbackInDatabase(database, issued.token)).toMatchObject(base);
    expect(
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: issued.token,
          resultText: "original child result",
          assertOwnerCurrent: (owner) => expect(owner).toMatchObject(base),
        }),
      ).status,
    ).toBe("accepted");
    expect(() =>
      createPluginStateSyncKeyedStore("core:plugin-async-callback", {
        namespace: "async-tool-callback",
        maxEntries: 10,
        env,
      }),
    ).toThrow("reserved for core consumers");
  });

  it("isolates two children and consumes each capability exactly once", () => {
    const first = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(database, base, 60_000),
    );
    const second = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(
        database,
        {
          ...base,
          childSessionKey: "agent:main:subagent:second",
          childSessionId: "second-session",
          childRunId: "second-run",
        },
        60_000,
      ),
    );
    expect(first.token).not.toBe(second.token);
    expect(
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: second.token,
          resultText: "second answer",
          assertOwnerCurrent: (owner) => expect(owner.childRunId).toBe("second-run"),
        }),
      ).status,
    ).toBe("accepted");
    expect(
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: first.token,
          resultText: "first answer",
          assertOwnerCurrent: (owner) => expect(owner.childRunId).toBe("first-run"),
        }),
      ).status,
    ).toBe("accepted");
    expect(queue(database)).toHaveLength(2);
    // Previous runtimes read only this namespace: callbacks survive rollback untouched.
    expect(
      database.db
        .prepare("SELECT id FROM delivery_queue_entries WHERE queue_name = 'session'")
        .all(),
    ).toEqual([]);
    const payloads = queue(database).map(({ entry_json }) => JSON.parse(entry_json));
    for (const payload of payloads) {
      expect(payload.completionRetention).toEqual({
        idPrefix: payload.id,
        maxAgeMs: 24 * 60 * 60_000,
        maxEntries: 1,
      });
    }
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionKey: base.childSessionKey,
          expectedSessionId: base.childSessionId,
          message: expect.stringContaining("first answer"),
        }),
        expect.objectContaining({
          sessionKey: "agent:main:subagent:second",
          expectedSessionId: "second-session",
          message: expect.stringContaining("second answer"),
        }),
      ]),
    );
    expect(
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: first.token,
          resultText: "overwrite",
          assertOwnerCurrent: () => {},
        }),
      ).status,
    ).toBe("duplicate");
    expect(queue(database)).toHaveLength(2);
  });

  it("refuses expiry, forgery and replaced child without queuing", () => {
    const issued = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(database, base, 1_000, 10_000),
    );
    const complete = (token: string, now: number, assertOwnerCurrent = () => {}) =>
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token,
          now,
          resultText: "sensitive result",
          assertOwnerCurrent,
        }),
      );
    expect(complete("bad", 10_100).status).toBe("unknown");
    expect(complete(issued.token, 11_000).status).toBe("expired");
    expect(() =>
      complete(issued.token, 10_100, () => {
        throw new Error("child replaced");
      }),
    ).toThrow("child replaced");
    expect(queue(database)).toHaveLength(0);
  });

  it("rolls back the claim when the outbox insert fails, then allows the original claim", () => {
    const issued = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(database, base, 60_000),
    );
    database.db.exec(`CREATE TEMP TRIGGER reject_callback BEFORE INSERT ON delivery_queue_entries
      BEGIN SELECT RAISE(ABORT, 'outbox rejected'); END;`);
    const complete = () =>
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: issued.token,
          resultText: "final",
          assertOwnerCurrent: () => {},
        }),
      );
    expect(complete).toThrow("outbox rejected");
    database.db.exec("DROP TRIGGER reject_callback");
    expect(complete().status).toBe("accepted");
    expect(queue(database)).toHaveLength(1);
  });

  it("cancels only a pending capability, leaving sibling children untouched", () => {
    const first = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(database, base, 60_000),
    );
    const second = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(database, { ...base, childRunId: "second-run" }, 60_000),
    );
    expect(
      transact(database, () =>
        cancelPluginAsyncCallbackInDatabase(database, first.token, (owner) =>
          expect(owner.childRunId).toBe("first-run"),
        ),
      ),
    ).toBe("cancelled");
    expect(
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: first.token,
          resultText: "too late",
          assertOwnerCurrent: () => {},
        }),
      ).status,
    ).toBe("cancelled");
    expect(
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: second.token,
          resultText: "sibling result",
          assertOwnerCurrent: () => {},
        }),
      ).status,
    ).toBe("accepted");
    expect(queue(database)).toHaveLength(1);
  });

  it("recovers the opaque token binding after a new database handle and isolates plugin owners", async () => {
    const first = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(database, base, 60_000),
    );
    const second = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(
        database,
        { ...base, pluginId: "other", childRunId: "other-plugin-run" },
        60_000,
      ),
    );
    const path = database.path;
    await closeOpenClawStateDatabaseAsync();
    database = openOpenClawStateDatabase({ path });
    const owner = transact(database, () =>
      findPluginAsyncCallbackInDatabase(database, first.token),
    );
    expect(owner).toMatchObject(base);
    expect(findPluginAsyncCallbackInDatabase(database, "forged")).toBeUndefined();
    expect(findPluginAsyncCallbackInDatabase(database, second.token)?.pluginId).toBe("other");
    expect(
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: first.token,
          resultText: "after restart",
          assertOwnerCurrent: (actual) => expect(actual).toMatchObject(base),
        }),
      ).status,
    ).toBe("accepted");
    expect(queue(database)).toHaveLength(1);
  });
  it("durably expires pending work and never expires a completed callback", () => {
    const issued = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(database, base, 1000, 10000),
    );
    const expiry = JSON.parse(
      String(
        database.db
          .prepare("SELECT entry_json FROM delivery_queue_entries WHERE id = ?")
          .get(issued.queueId)!.entry_json,
      ),
    );
    expect(expiry.availableAt).toBe(11000);
    expect(expiry.enqueuedAt).toBe(10000);
    expect(expiry.completionRetention).toEqual({
      idPrefix: issued.queueId,
      maxAgeMs: 24 * 60 * 60_000,
      maxEntries: 1,
    });
    expect(expiry.sessionKey).toBe(base.childSessionKey);
    expect(() =>
      transact(database, () =>
        expirePluginAsyncCallbackInDatabase(database, expiry.callbackExpiryKey, 10999),
      ),
    ).toThrow("not due");
    expect(
      transact(database, () =>
        expirePluginAsyncCallbackInDatabase(database, expiry.callbackExpiryKey, 11000),
      ),
    ).toBe(true);
    expect(
      transact(database, () =>
        expirePluginAsyncCallbackInDatabase(database, expiry.callbackExpiryKey, 11001),
      ),
    ).toBe(true);
    expect(
      transact(database, () =>
        completePluginAsyncCallbackInDatabase({
          database,
          token: issued.token,
          resultText: "late",
          now: 11001,
          assertOwnerCurrent: () => {},
        }),
      ).status,
    ).toBe("expired");
    const completed = transact(database, () =>
      issuePluginAsyncCallbackInDatabase(
        database,
        { ...base, childRunId: "completed-run" },
        1000,
        20000,
      ),
    );
    const completedExpiry = JSON.parse(
      String(
        database.db
          .prepare("SELECT entry_json FROM delivery_queue_entries WHERE id = ?")
          .get(completed.queueId)!.entry_json,
      ),
    );
    transact(database, () =>
      completePluginAsyncCallbackInDatabase({
        database,
        token: completed.token,
        resultText: "early",
        now: 20001,
        assertOwnerCurrent: () => {},
      }),
    );
    expect(
      transact(database, () =>
        expirePluginAsyncCallbackInDatabase(database, completedExpiry.callbackExpiryKey, 21001),
      ),
    ).toBe(false);
  });
});
