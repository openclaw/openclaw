// Workboard tests cover the sqlite batch card read path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardNotificationSubscription,
} from "./persistence-types.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteKernel, workboardTestDatabaseInput } from "./test/database-config.js";
import { runPostgresGroupedRollback } from "./test/postgres-fixture.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { sqliteOnly as test } from "./test/sqlite-only.js";
import { sqliteTestAuxStores } from "./test/sqlite-store.js";

const sqliteStatements = vi.hoisted(() => ({
  count: 0,
  executed: [] as string[],
}));

vi.mock("openclaw/plugin-sdk/sqlite-worker-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-worker-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const db = actual.openNodeSqliteDatabase(...args);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        for (const method of ["all", "get", "iterate", "run"] as const) {
          Object.defineProperty(statement, method, {
            configurable: true,
            writable: true,
            value: new Proxy(statement[method], {
              apply(target, receiver, methodArgs) {
                sqliteStatements.count++;
                sqliteStatements.executed.push(sql);
                return Reflect.apply(target, receiver, methodArgs);
              },
            }),
          });
        }
        return statement;
      });
      return db;
    },
  };
});

function fixtureCard(index: number): WorkboardCard {
  const id = `card-${index}`;
  return {
    id,
    title: `Card ${index}`,
    status: "todo",
    priority: "normal",
    labels: [`label-${index}`, "shared"],
    position: index,
    createdAt: 1000 + index,
    updatedAt: 2000 + index,
    ...(index % 2
      ? {
          execution: {
            id: `${id}-execution`,
            kind: "agent-session" as const,
            mode: "autonomous" as const,
            status: "done" as const,
            startedAt: 0,
            updatedAt: 1,
          },
        }
      : {}),
    events: [{ id: `${id}-event`, kind: "created", at: 1000 + index }],
    metadata: {
      attempts: [{ id: `${id}-attempt`, status: "succeeded", startedAt: 1000 + index }],
      comments: [{ id: `${id}-comment`, body: `note ${index}`, createdAt: 1000 + index }],
      links: [
        { id: `${id}-link`, type: "relates_to", url: "https://example.test", createdAt: 1000 },
      ],
      proof: [{ id: `${id}-proof`, status: "passed", label: "unit", createdAt: 1000 }],
      artifacts: [{ id: `${id}-artifact`, label: "log", createdAt: 1000 }],
      attachments: [
        {
          id: `${id}-attachment`,
          cardId: id,
          fileName: "note.txt",
          byteSize: 4,
          createdAt: 1000,
        },
      ],
      workerLogs: [
        { id: `${id}-log`, level: "info", message: `log ${index}`, createdAt: 1000 + index },
      ],
      diagnostics: [
        {
          kind: "stranded_ready",
          severity: "warning",
          title: "Stranded",
          detail: "detail",
          firstSeenAt: 1000,
          lastSeenAt: 1000,
          count: 1,
          actions: [],
        },
      ],
      notifications: [
        { id: `${id}-notify`, kind: "failed", message: "boom", createdAt: 1000 + index },
      ],
      workerProtocol: { state: "idle", updatedAt: 1000 + index, detail: "waiting" },
    },
  };
}

function withStores<T>(run: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-batch-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  return run(dbPath).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

describe("workboard sqlite batch card read", () => {
  // Counts statements by intercepting the native SQLite open boundary.
  test.each(["worker log", "proof"])("hydrates once when adding a %s", async (operation) => {
    await withStores(async (dbPath) => {
      const stores = createKernelStores(dbPath);
      const store = new WorkboardStore(stores.cards, sqliteTestAuxStores(stores));
      try {
        const card = await store.create({ title: "Hydration budget" });
        const before = sqliteStatements.executed.length;
        const updated =
          operation === "worker log"
            ? await store.addWorkerLog(card.id, { message: "Recorded progress" })
            : await store.addProof(card.id, { status: "passed", label: "Verified result" });
        const statements = sqliteStatements.executed.slice(before);
        const hydrationReads = statements.filter((sql) => /^SELECT \* FROM workboard_/i.test(sql));
        expect(hydrationReads).toHaveLength(13);
        expect(statements.filter((sql) => /^select\b/i.test(sql.trimStart()))).toHaveLength(15);
        expect(
          operation === "worker log"
            ? updated.metadata?.workerLogs?.[0]?.message
            : updated.metadata?.proof?.[0]?.label,
        ).toBe(operation === "worker log" ? "Recorded progress" : "Verified result");
      } finally {
        await stores.close();
      }
    });
  });

  // Regression for large-board stalls from per-card child reads.
  test("issues the same number of statements no matter how many cards exist", async () => {
    await withStores(async (dbPath) => {
      const stores = createKernelStores(dbPath);
      try {
        const prepared = async (cardCount: number): Promise<number> => {
          for (let index = 0; index < cardCount; index++) {
            await stores.cards.register(`card-${index}`, { version: 1, card: fixtureCard(index) });
          }
          const before = sqliteStatements.count;
          await stores.cards.entries();
          return sqliteStatements.count - before;
        };
        const few = await prepared(3);
        const many = await prepared(30);

        expect(few).toBeGreaterThan(0);
        expect(many).toBe(few);
      } finally {
        await stores.close();
      }
    });
  });

  // Injects malformed values through a native SQLite file handle.
  test("preserves native, child, and execution error order through entries and remains reusable", async () => {
    await withStores(async (dbPath) => {
      const stores = createKernelStores(dbPath);
      const raw = new DatabaseSync(dbPath);
      const card = fixtureCard(1);
      card.events = [...(card.events ?? []), { id: "late-event", kind: "created", at: 1002 }];
      const read = () => stores.cards.entries();
      try {
        await stores.cards.register(card.id, { version: 1, card });
        raw.prepare("UPDATE workboard_card_events SET kind = '' WHERE ordinal = 0").run();
        raw
          .prepare("UPDATE workboard_card_events SET ordinal = ? WHERE id = ?")
          .run(9007199254740993n, "late-event");
        await expect(read()).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });

        raw.prepare("UPDATE workboard_card_events SET ordinal = 1 WHERE id = ?").run("late-event");
        await expect(read()).rejects.toThrow("workboard sqlite row missing kind");
        raw
          .prepare("UPDATE workboard_cards SET execution_mode = NULL, automation_json = '{'")
          .run();
        await expect(read()).rejects.toThrow(SyntaxError);
        raw.prepare("UPDATE workboard_cards SET automation_json = NULL").run();
        await expect(read()).rejects.toThrow("workboard sqlite row missing kind");
        raw.prepare("UPDATE workboard_card_events SET kind = 'created'").run();
        await expect(read()).rejects.toThrow("workboard sqlite row missing execution_mode");
        raw.prepare("UPDATE workboard_cards SET execution_mode = 'autonomous'").run();

        const expected = { version: 1, card };
        await expect(read()).resolves.toEqual([{ key: card.id, value: expected }]);
      } finally {
        raw.close();
        await stores.close();
      }
    });
  });

  // Injects malformed rows and counts native SQLite statements.
  test("checks the claim revision before decoding unrelated malformed children", async () => {
    await withStores(async (dbPath) => {
      const stores = createKernelStores(dbPath);
      const raw = new DatabaseSync(dbPath);
      const target = fixtureCard(2);
      try {
        const busy = { ...fixtureCard(0), status: "running" as const, agentId: "slot-owner" };
        await stores.cards.register(busy.id, { version: 1, card: busy });
        await stores.cards.register("card-1", { version: 1, card: fixtureCard(1) });
        await stores.cards.register(target.id, { version: 1, card: target });
        raw
          .prepare("UPDATE workboard_card_events SET ordinal = ? WHERE card_id = ?")
          .run(9007199254740993n, "card-1");
        const before = sqliteStatements.count;
        const claim = stores.cards.claimIfOwnerAvailable(
          target.id,
          { version: 1, card: { ...target, updatedAt: target.updatedAt + 1 } },
          target.updatedAt - 1,
          "slot-owner",
          3000,
        );
        await expect(claim).resolves.toBe("conflict");
        expect(sqliteStatements.count - before).toBe(1);
        expect(
          raw.prepare("SELECT updated_at FROM workboard_cards WHERE id = ?").get(target.id),
        ).toEqual({ updated_at: target.updatedAt });
      } finally {
        raw.close();
        await stores.close();
      }
    });
  });

  it.each([
    { name: "running execution", status: "done", execution: true, expected: "owner_busy" },
    {
      name: "another claim owner",
      status: "running",
      claimOwner: "other",
      expiresAt: 1_000_001,
      expected: "updated",
    },
  ])("preserves owner capacity for $name", async (scenario) => {
    await withStores(async (dbPath) => {
      const stores = createKernelStores(dbPath);
      const occupied = fixtureCard(0);
      const target = fixtureCard(2);
      occupied.status = scenario.status as WorkboardCard["status"];
      occupied.agentId = "slot-owner";
      occupied.metadata = {
        ...occupied.metadata,
        claim:
          scenario.expiresAt === undefined
            ? undefined
            : {
                ownerId: scenario.claimOwner ?? "slot-owner",
                token: "synthetic-claim-token",
                claimedAt: 1,
                lastHeartbeatAt: 1,
                expiresAt: scenario.expiresAt,
              },
      };
      if (scenario.execution) {
        occupied.execution = {
          id: "occupied-execution",
          kind: "agent-session",
          mode: "autonomous",
          status: "running",
          startedAt: 1,
          updatedAt: 1,
        };
      }
      try {
        await stores.cards.register(occupied.id, { version: 1, card: occupied });
        await stores.cards.register(target.id, { version: 1, card: target });
        const next = { ...target, updatedAt: target.updatedAt + 1 };
        await expect(
          stores.cards.claimIfOwnerAvailable(
            target.id,
            { version: 1, card: next },
            target.updatedAt,
            "slot-owner",
            1_000_000,
          ),
        ).resolves.toBe(scenario.expected);
        await expect(stores.cards.lookup(target.id)).resolves.toEqual({
          version: 1,
          card: scenario.expected === "updated" ? next : target,
        });
      } finally {
        await stores.close();
      }
    });
  });

  // Injects an unsafe integer through a native SQLite file handle.
  test("claims an available owner without reading or replacing unrelated malformed children", async () => {
    await withStores(async (dbPath) => {
      const stores = createKernelStores(dbPath);
      const raw = new DatabaseSync(dbPath);
      const target = fixtureCard(2);
      try {
        await stores.cards.register("card-0", { version: 1, card: fixtureCard(0) });
        await stores.cards.register(target.id, { version: 1, card: target });
        raw
          .prepare("UPDATE workboard_card_events SET ordinal = ? WHERE card_id = 'card-0'")
          .run(9007199254740993n);
        const next = { ...target, updatedAt: target.updatedAt + 1 };
        await expect(
          stores.cards.claimIfOwnerAvailable(
            target.id,
            { version: 1, card: next },
            target.updatedAt,
            "slot-owner",
            3000,
          ),
        ).resolves.toBe("updated");
        await expect(stores.cards.lookup(target.id)).resolves.toEqual({ version: 1, card: next });
        await expect(stores.cards.lookup("card-0")).rejects.toMatchObject({
          code: "ERR_OUT_OF_RANGE",
        });
      } finally {
        raw.close();
        await stores.close();
      }
    });
  });

  it.each(["constraint", "binding"])(
    "rolls back a grouped write and claim after a later child %s fails",
    async (fault) => {
      await withStores(async (dbPath) => {
        const sibling = fixtureCard(0);
        const target = fixtureCard(2);
        const postgresInput = workboardTestDatabaseInput();
        if (postgresInput) {
          const result = await runPostgresGroupedRollback(
            { dbPath, postgresInput },
            { kind: "groupedRollback", sibling, target, fault },
          );
          expect(result).toMatchObject({
            failure:
              fault === "constraint"
                ? { error: { message: expect.stringContaining("UNIQUE constraint failed") } }
                : { name: "TypeError" },
            target: { version: 1, card: target },
            sibling: { version: 1, card: sibling },
          });
          expect(result).toHaveProperty("board", undefined);
          return;
        }
        const stores = createWorkboardSqliteKernel(dbPath);
        try {
          stores.cards.register(sibling.id, { version: 1, card: sibling });
          stores.cards.register(target.id, { version: 1, card: target });
          const invalidComment = { ...sibling.metadata!.comments![0]! };
          if (fault === "binding") {
            Object.defineProperty(invalidComment, "body", { value: { invalid: "native binding" } });
          }
          const next = {
            ...target,
            title: "Claimed",
            updatedAt: target.updatedAt + 1,
            labels: ["changed"],
            metadata: {
              ...target.metadata,
              comments: [
                { id: "replacement-comment", body: "First row", createdAt: 1000 },
                invalidComment,
              ],
            },
          };
          expect(() =>
            stores.withWriteTransaction(() => {
              stores.boards.register("grouped", {
                version: 1,
                board: { id: "grouped", createdAt: 1, updatedAt: 2 },
              });
              stores.cards.claimIfOwnerAvailable(
                target.id,
                { version: 1, card: next },
                target.updatedAt,
                "slot-owner",
                3000,
              );
            }),
          ).toThrow(fault === "constraint" ? "UNIQUE constraint failed" : TypeError);
          expect(stores.boards.lookup("grouped")).toBeUndefined();
          expect(stores.cards.lookup(target.id)).toEqual({
            version: 1,
            card: target,
          });
          expect(stores.cards.lookup(sibling.id)).toEqual({
            version: 1,
            card: sibling,
          });
        } finally {
          stores.close();
        }
      });
    },
  );
  // Measures reads through the native SQLite open boundary.
  test("reads each keyed collection once while preserving rows, binary order, and attachment joins", async () => {
    await withStores(async (dbPath) => {
      let stores = createKernelStores(dbPath);
      // SQLite's binary order differs from locale sorting and from UTF-16 for the last two ids.
      const ids = ["Z", "a", "Å", "ä", "é", "中", "\uE000", "😀"];
      const boards: PersistedWorkboardBoard[] = ids.map((id, index) => ({
        version: 1,
        board: {
          id,
          createdAt: index,
          updatedAt: 30,
          ...(index % 2
            ? {
                name: `Board ${id}`,
                automationJobId: `job-${id}`,
                defaultWorkspace: { kind: "scratch" as const },
                orchestration: { autoDecompose: false },
                archivedAt: 0,
              }
            : {}),
        },
      }));
      const subscriptions: PersistedWorkboardNotificationSubscription[] = ids.map((id, index) => ({
        version: 1,
        subscription: {
          id,
          boardId: id,
          createdAt: index % 2,
          updatedAt: 30,
          ...(index % 2
            ? {
                cardId: "card-0",
                sessionKey: `session-${id}`,
                runId: `run-${id}`,
                target: `target-${id}`,
                eventKinds: [],
                lastEventAt: 0,
                lastEventId: `event-${id}`,
                lastEventSequence: 0,
                deliveredEventIds: [],
              }
            : {}),
        },
      }));
      const attachments: PersistedWorkboardAttachment[] = ids.map((id, index) => ({
        version: 1,
        attachment: {
          id,
          cardId: "card-0",
          fileName: `${id}.bin`,
          byteSize: 3,
          createdAt: index % 2,
          ...(index % 2 ? { mimeType: "application/octet-stream", note: `Note ${id}` } : {}),
        },
        contentBase64: Buffer.from([0, index, 255]).toString("base64"),
      }));
      try {
        for (const board of boards.toReversed()) {
          await stores.boards.register(board.board.id, board);
        }
        for (const subscription of subscriptions.toReversed()) {
          await stores.subscriptions.register(subscription.subscription.id, subscription);
        }
        const card = fixtureCard(0);
        card.metadata = {
          attachments: [
            ...attachments.toReversed().map((entry) => entry.attachment),
            { ...attachments[0]!.attachment, id: "metadata-without-blob" },
          ],
        };
        await stores.cards.register(card.id, { version: 1, card });
        for (const attachment of attachments.toReversed()) {
          await stores.attachments.register(attachment.attachment.id, attachment);
        }
        await stores.attachments.register("blob-without-metadata", {
          ...attachments[0]!,
          attachment: { ...attachments[0]!.attachment, id: "blob-without-metadata" },
        });
        await stores.close();
        stores = createKernelStores(dbPath);

        const beforeBoards = sqliteStatements.count;
        const boardEntries = await stores.boards.entries();
        const boardReads = sqliteStatements.count - beforeBoards;
        const beforeSubscriptions = sqliteStatements.count;
        const subscriptionEntries = await stores.subscriptions.entries();
        const subscriptionReads = sqliteStatements.count - beforeSubscriptions;
        const beforeAttachments = sqliteStatements.count;
        const attachmentEntries = await stores.attachments.entries();
        const attachmentReads = sqliteStatements.count - beforeAttachments;

        expect(boardEntries).toEqual(boards.map((value) => ({ key: value.board.id, value })));
        const timeOrder = [0, 2, 4, 6, 1, 3, 5, 7];
        expect(subscriptionEntries).toEqual(
          timeOrder.map((index) => ({ key: ids[index], value: subscriptions[index] })),
        );
        expect(attachmentEntries).toEqual(
          timeOrder.map((index) => ({ key: ids[index], value: attachments[index] })),
        );
        for (const [collection, entries] of [
          [stores.boards, boardEntries],
          [stores.subscriptions, subscriptionEntries],
          [stores.attachments, attachmentEntries],
        ] as const) {
          for (const { key, value } of entries) {
            await expect(collection.lookup(key)).resolves.toEqual(value);
          }
          await expect(collection.lookup("missing")).resolves.toBeUndefined();
        }
        expect({ boardReads, subscriptionReads, attachmentReads }).toEqual({
          boardReads: 1,
          subscriptionReads: 1,
          attachmentReads: 1,
        });
      } finally {
        await stores.close();
      }
    });
  });
});
