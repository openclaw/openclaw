// Workboard tests cover batched card persistence and hydration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardNotificationSubscription,
} from "./persistence-types.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { WorkboardStore } from "./store.js";
import {
  createWorkboardSqliteKernel,
  createWorkboardSqliteStores,
  workboardTestDatabaseInput,
} from "./test/database-config.js";
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
            engine: "codex" as const,
            model: "gpt-5.5",
            sessionKey: `session-${index}`,
            runId: `run-${index}`,
            startedAt: 0,
            updatedAt: 1,
          },
        }
      : {}),
    events: [{ id: `${id}-event`, kind: "created", at: 1000 + index }],
    metadata: {
      lifecycleStatusSourceUpdatedAt: 1234,
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

const persisted = (card: WorkboardCard) => ({ version: 1 as const, card });

function withStores<T>(run: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-batch-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  return run(dbPath).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

async function withKernelStores(
  run: (stores: ReturnType<typeof createKernelStores>, dbPath: string) => Promise<void>,
) {
  await withStores(async (dbPath) => {
    const stores = createKernelStores(dbPath);
    try {
      await run(stores, dbPath);
    } finally {
      await stores.close();
    }
  });
}

describe("workboard sqlite batch card persistence", () => {
  it("replaces ordered child collections across batches and clears them on a later write", async () => {
    await withKernelStores(async (stores) => {
      const original = fixtureCard(0);
      // Descending IDs make resetting ordinals at the next batch observable on readback.
      const children = Array.from({ length: 65 }, (_, index) => fixtureCard(100 - index));
      const replacement: WorkboardCard = {
        ...original,
        title: "Replaced children",
        updatedAt: original.updatedAt + 1,
        labels: children.map((card) => card.labels[0]!),
        events: children.flatMap((card) => card.events!),
        metadata: {
          ...original.metadata,
          attempts: children.flatMap((card) => card.metadata!.attempts!),
          comments: children.flatMap((card) => card.metadata!.comments!),
          links: children.flatMap((card) => card.metadata!.links!),
          proof: children.flatMap((card) => card.metadata!.proof!),
          artifacts: children.flatMap((card) => card.metadata!.artifacts!),
          attachments: children.flatMap((card) =>
            card.metadata!.attachments!.map((attachment) =>
              Object.assign(attachment, { cardId: original.id }),
            ),
          ),
          diagnostics: children.flatMap((card) =>
            card.metadata!.diagnostics!.map((diagnostic) =>
              Object.assign(diagnostic, { detail: card.title }),
            ),
          ),
          notifications: children.flatMap((card) => card.metadata!.notifications!),
          workerLogs: children.flatMap((card) => card.metadata!.workerLogs!),
        },
      };
      await stores.cards.register(original.id, persisted(original));
      const before = sqliteStatements.count;
      await expect(
        stores.cards.registerIfUpdatedAt(
          replacement.id,
          persisted(replacement),
          original.updatedAt,
        ),
      ).resolves.toBe(true);
      if (!workboardTestDatabaseInput()) {
        // A row-at-a-time write exceeds 700 statements for this bounded fixture.
        expect(sqliteStatements.count - before).toBeLessThan(100);
      }
      await expect(stores.cards.lookup(original.id)).resolves.toEqual(persisted(replacement));
      const cleared = {
        ...replacement,
        updatedAt: replacement.updatedAt + 1,
        labels: [],
        events: [],
        metadata: undefined,
      };
      await expect(
        stores.cards.registerIfUpdatedAt(cleared.id, persisted(cleared), replacement.updatedAt),
      ).resolves.toBe(true);
      await expect(stores.cards.lookup(original.id)).resolves.toEqual(
        persisted({ ...cleared, events: undefined }),
      );
    });
  });

  // Counts statements by intercepting the native SQLite open boundary.
  test.each(["worker log", "proof"])("hydrates once when adding a %s", async (operation) => {
    await withKernelStores(async (stores) => {
      const store = new WorkboardStore(stores.cards, sqliteTestAuxStores(stores));
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
    });
  });

  // Regression for large-board stalls from per-card child reads.
  test("issues the same number of statements no matter how many cards exist", async () => {
    await withKernelStores(async (stores) => {
      const prepared = async (cardCount: number): Promise<number> => {
        for (let index = 0; index < cardCount; index++) {
          await stores.cards.register(`card-${index}`, persisted(fixtureCard(index)));
        }
        const before = sqliteStatements.count;
        await stores.cards.entries();
        return sqliteStatements.count - before;
      };
      const few = await prepared(3);
      const many = await prepared(30);

      expect(few).toBeGreaterThan(0);
      expect(many).toBe(few);
    });
  });

  // Injects malformed values through a native SQLite file handle.
  test("preserves native, child, and execution error order through entries and remains reusable", async () => {
    await withKernelStores(async (stores, dbPath) => {
      using raw = new DatabaseSync(dbPath);
      const card = fixtureCard(1);
      card.events = [...(card.events ?? []), { id: "late-event", kind: "created", at: 1002 }];
      const read = () => stores.cards.entries();
      await stores.cards.register(card.id, persisted(card));
      raw.prepare("UPDATE workboard_card_events SET kind = '' WHERE ordinal = 0").run();
      raw
        .prepare("UPDATE workboard_card_events SET ordinal = ? WHERE id = ?")
        .run(9007199254740993n, "late-event");
      await expect(read()).rejects.toMatchObject({ code: "ERR_OUT_OF_RANGE" });

      raw.prepare("UPDATE workboard_card_events SET ordinal = 1 WHERE id = ?").run("late-event");
      await expect(read()).rejects.toThrow("workboard sqlite row missing kind");
      raw.prepare("UPDATE workboard_cards SET execution_mode = NULL, automation_json = '{'").run();
      await expect(read()).rejects.toThrow(SyntaxError);
      raw.prepare("UPDATE workboard_cards SET automation_json = NULL").run();
      await expect(read()).rejects.toThrow("workboard sqlite row missing kind");
      raw.prepare("UPDATE workboard_card_events SET kind = 'created'").run();
      await expect(read()).rejects.toThrow("workboard sqlite row missing execution_mode");
      raw.prepare("UPDATE workboard_cards SET execution_mode = 'autonomous'").run();

      const expected = persisted(card);
      await expect(read()).resolves.toEqual([{ key: card.id, value: expected }]);
    });
  });

  // Injects malformed rows and counts native SQLite statements.
  test("checks the claim revision before decoding unrelated malformed children", async () => {
    await withKernelStores(async (stores, dbPath) => {
      using raw = new DatabaseSync(dbPath);
      const target = fixtureCard(2);
      const busy = { ...fixtureCard(0), status: "running" as const, agentId: "slot-owner" };
      await stores.cards.register(busy.id, persisted(busy));
      await stores.cards.register("card-1", persisted(fixtureCard(1)));
      await stores.cards.register(target.id, persisted(target));
      raw
        .prepare("UPDATE workboard_card_events SET ordinal = ? WHERE card_id = ?")
        .run(9007199254740993n, "card-1");
      const before = sqliteStatements.count;
      const claim = stores.cards.claimIfOwnerAvailable(
        target.id,
        persisted({ ...target, updatedAt: target.updatedAt + 1 }),
        target.updatedAt - 1,
        "slot-owner",
        3000,
      );
      await expect(claim).resolves.toBe("conflict");
      expect(sqliteStatements.count - before).toBe(1);
      expect(
        raw.prepare("SELECT updated_at FROM workboard_cards WHERE id = ?").get(target.id),
      ).toEqual({ updated_at: target.updatedAt });
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
    await withKernelStores(async (stores) => {
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
      await stores.cards.register(occupied.id, persisted(occupied));
      await stores.cards.register(target.id, persisted(target));
      const next = { ...target, updatedAt: target.updatedAt + 1 };
      await expect(
        stores.cards.claimIfOwnerAvailable(
          target.id,
          persisted(next),
          target.updatedAt,
          "slot-owner",
          1_000_000,
        ),
      ).resolves.toBe(scenario.expected);
      await expect(stores.cards.lookup(target.id)).resolves.toEqual(
        persisted(scenario.expected === "updated" ? next : target),
      );
    });
  });

  // Injects an unsafe integer through a native SQLite file handle.
  test("claims an available owner without reading or replacing unrelated malformed children", async () => {
    await withKernelStores(async (stores, dbPath) => {
      using raw = new DatabaseSync(dbPath);
      const target = fixtureCard(2);
      await stores.cards.register("card-0", persisted(fixtureCard(0)));
      await stores.cards.register(target.id, persisted(target));
      raw
        .prepare("UPDATE workboard_card_events SET ordinal = ? WHERE card_id = 'card-0'")
        .run(9007199254740993n);
      const next = { ...target, updatedAt: target.updatedAt + 1 };
      await expect(
        stores.cards.claimIfOwnerAvailable(
          target.id,
          persisted(next),
          target.updatedAt,
          "slot-owner",
          3000,
        ),
      ).resolves.toBe("updated");
      await expect(stores.cards.lookup(target.id)).resolves.toEqual(persisted(next));
      await expect(stores.cards.lookup("card-0")).rejects.toMatchObject({
        code: "ERR_OUT_OF_RANGE",
      });
    });
  });

  it.each(["constraint", "binding"])(
    "rolls back earlier batches, grouped writes, and claims after a later child %s fails",
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
            target: persisted(target),
            sibling: persisted(sibling),
          });
          expect(result).toHaveProperty("board", undefined);
          return;
        }
        const stores = createWorkboardSqliteKernel(dbPath);
        try {
          stores.cards.register(sibling.id, persisted(sibling));
          stores.cards.register(target.id, persisted(target));
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
                ...Array.from({ length: 65 }, (_, index) => ({
                  id: `replacement-comment-${index}`,
                  body: `Row ${index}`,
                  createdAt: 1000,
                })),
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
                persisted(next),
                target.updatedAt,
                "slot-owner",
                3000,
              );
            }),
          ).toThrow(fault === "constraint" ? "UNIQUE constraint failed" : TypeError);
          expect(stores.boards.lookup("grouped")).toBeUndefined();
          expect(stores.cards.lookup(target.id)).toEqual(persisted(target));
          expect(stores.cards.lookup(sibling.id)).toEqual(persisted(sibling));
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
                description: "Operational work",
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
          byteSize: index === ids.length - 1 ? 70 * 1024 : 3,
          createdAt: index % 2,
          ...(index % 2 ? { mimeType: "application/octet-stream", note: `Note ${id}` } : {}),
        },
        contentBase64: (index === ids.length - 1
          ? Buffer.alloc(70 * 1024)
          : Buffer.from([0, index, 255])
        ).toString("base64"),
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
        await stores.cards.register(card.id, persisted(card));
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

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);

const WORKBOARD_CARD_CHILD_INDEXES = [
  ["workboard_card_events", "workboard_card_events_card_idx"],
  ["workboard_card_attempts", "workboard_card_attempts_card_idx"],
  ["workboard_card_comments", "workboard_card_comments_card_idx"],
  ["workboard_card_links", "workboard_card_links_card_idx"],
  ["workboard_card_proof", "workboard_card_proof_card_idx"],
  ["workboard_card_artifacts", "workboard_card_artifacts_card_idx"],
  ["workboard_card_notifications", "workboard_card_notifications_card_idx"],
  ["workboard_worker_logs", "workboard_worker_logs_card_idx"],
] as const;

async function reopen(dbPath: string) {
  const stores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  await stores.ready;
  await stores.close();
}

async function legacyDatabase(dbPath: string) {
  await reopen(dbPath);
  // Build the old format on a physical file this process has not admitted.
  fs.renameSync(dbPath, `${dbPath}.seed`);
  fs.copyFileSync(`${dbPath}.seed`, dbPath);
}

describe("Workboard SQLite schema admission", () => {
  // Inspects and repairs native SQLite indexes and EXPLAIN QUERY PLAN output.
  test("restores dropped card child indexes without changing the schema version", async () => {
    await withStores(async (dbPath) => {
      await legacyDatabase(dbPath);
      let initialMigrationIds: Array<{ id: string }>;
      {
        using db = new DatabaseSync(dbPath);
        initialMigrationIds = db
          .prepare("SELECT id FROM workboard_schema_migrations ORDER BY id")
          .all() as Array<{ id: string }>;
        for (const [, index] of WORKBOARD_CARD_CHILD_INDEXES) {
          db.exec(`DROP INDEX ${index}`);
        }
      }

      await reopen(dbPath);
      using verified = new DatabaseSync(dbPath, { readOnly: true });
      const indexes = new Set(
        verified
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")
          .all()
          .map((row) => row.name),
      );
      for (const [table, index] of WORKBOARD_CARD_CHILD_INDEXES) {
        expect(indexes).toContain(index);
        const plan = verified
          .prepare(
            `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE card_id = ? ORDER BY ordinal ASC`,
          )
          .all("card-1")
          .map((row) => row.detail)
          .join("\n");
        expect(plan).toContain(index);
        expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
      }
      expect(
        verified.prepare("SELECT id FROM workboard_schema_migrations ORDER BY id").all(),
      ).toEqual(initialMigrationIds);
    });
  });

  // Builds a legacy SQLite file and verifies its STRICT-table migration.
  test("migrates a version 2 workboard table to STRICT without losing rows", async () => {
    await withStores(async (dbPath) => {
      await legacyDatabase(dbPath);
      {
        using legacy = new DatabaseSync(dbPath);
        legacy.exec(`
        INSERT INTO workboard_boards (
          id, name, description, icon, color, default_workspace_json, orchestration_json,
          created_at, updated_at, archived_at
        ) VALUES ('legacy', 'Legacy board', NULL, NULL, NULL, NULL, NULL, 1, 2, NULL);
        ALTER TABLE workboard_boards RENAME TO workboard_boards_strict;
        CREATE TABLE workboard_boards (
          id TEXT PRIMARY KEY,
          name TEXT,
          description TEXT,
          icon TEXT,
          color TEXT,
          default_workspace_json TEXT,
          orchestration_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        );
        INSERT INTO workboard_boards (
          id, name, description, icon, color, default_workspace_json, orchestration_json,
          created_at, updated_at, archived_at
        ) SELECT
          id, name, description, icon, color, default_workspace_json, orchestration_json,
          created_at, updated_at, archived_at
        FROM workboard_boards_strict;
        DROP TABLE workboard_boards_strict;
        DELETE FROM workboard_schema_migrations WHERE id = 'schema-3';
        INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at)
        VALUES ('schema-2', 1);
      `);
      }

      const migratedStores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
      try {
        await expect(migratedStores.boards.lookup("legacy")).resolves.toMatchObject({
          board: { id: "legacy", name: "Legacy board" },
        });
      } finally {
        await migratedStores.close();
      }
      using migrated = new DatabaseSync(dbPath, { readOnly: true });
      expect(
        migrated
          .prepare("SELECT strict FROM pragma_table_list WHERE name = 'workboard_boards'")
          .get(),
      ).toEqual({ strict: 1 });
      expect(
        migrated
          .prepare("SELECT 1 AS found FROM workboard_schema_migrations WHERE id = 'schema-3'")
          .get(),
      ).toEqual({ found: 1 });
    });
  });
});
