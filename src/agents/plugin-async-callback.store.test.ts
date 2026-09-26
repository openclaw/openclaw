import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  cancelPluginAsyncCallbackInDatabase,
  completePluginAsyncCallbackInDatabase,
  findPluginAsyncCallbackInDatabase,
  expirePluginAsyncCallbackInDatabase,
  issuePluginAsyncCallbackInDatabase,
} from "./plugin-async-callback.store.js";

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
  beforeEach(() => {
    const dir = dirs.make("openclaw-plugin-callback-", resolvePreferredOpenClawTmpDir());
    database = openOpenClawStateDatabase({ path: `${dir}/state.sqlite` });
  });
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
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
        maxAgeMs: 7 * 24 * 60 * 60_000,
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
      issuePluginAsyncCallbackInDatabase(database, { ...base, pluginId: "other" }, 60_000),
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
      maxAgeMs: 7 * 24 * 60 * 60_000,
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
      issuePluginAsyncCallbackInDatabase(database, base, 1000, 20000),
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
