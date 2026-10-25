import { DatabaseSync, StatementSync } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, vi } from "vitest";
import { execution as sessionExecution } from "./lifecycle-sync-fixtures.test-support.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { sqliteOnly as test } from "./test/sqlite-only.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

const setup = () => createWorkboardSqliteTestHarness({ createStores: createKernelStores });

function observeReads(onRows: (sql: string, rows: Record<string, unknown>[]) => void) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain native methods for the same receiver.
  const all = StatementSync.prototype.all;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain native methods for the same receiver.
  const get = StatementSync.prototype.get;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain native methods for the same receiver.
  const iterate = StatementSync.prototype.iterate;
  const allSpy = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
    this: StatementSync,
    ...params: Parameters<typeof all>
  ) {
    const rows = all.apply(this, params);
    onRows(this.sourceSQL, rows);
    return rows;
  });
  const getSpy = vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
    this: StatementSync,
    ...params: Parameters<typeof get>
  ) {
    const row = get.apply(this, params);
    onRows(this.sourceSQL, row ? [row] : []);
    return row;
  });
  const iterateSpy = vi.spyOn(StatementSync.prototype, "iterate").mockImplementation(function (
    this: StatementSync,
    ...params: Parameters<typeof iterate>
  ) {
    const rows = Array.from(iterate.apply(this, params));
    onRows(this.sourceSQL, rows);
    return rows.values();
  });
  return () => {
    allSpy.mockRestore();
    getSpy.mockRestore();
    iterateSpy.mockRestore();
  };
}

async function captureRead<T>(
  read: () => Promise<T>,
  onRows?: (sql: string, rows: Record<string, unknown>[]) => void,
) {
  const ids: unknown[] = [];
  let queries = 0;
  let rowCount = 0;
  const restore = observeReads((sql, rows) => {
    ids.push(...rows.filter((row) => "notes" in row).map((row) => row.id));
    if (/^select\b/iu.test(sql) && /\bfrom "?workboard_/iu.test(sql)) {
      queries++;
      rowCount += rows.length;
    }
    onRows?.(sql, rows);
  });
  try {
    const value = await read();
    return { value, ids, queries, rowCount };
  } finally {
    restore();
  }
}

function scopedCard(id: string, overrides: Partial<WorkboardCard> = {}): WorkboardCard {
  return {
    id,
    title: id,
    status: "done",
    priority: "normal",
    labels: [],
    notes: `Payload for ${id}`,
    position: 1,
    createdAt: 100,
    updatedAt: 200,
    metadata: { automation: { boardId: "ops", summary: `${id} result` } },
    ...overrides,
  };
}

describe("Workboard context and session-scoped reads", () => {
  test("normalizes structural session casing without hydrating colliding opaque identities", async () => {
    const { store, stores, dbPath } = setup();
    const cases = [
      [
        "direct",
        " Agent:Main:Matrix:Channel:!Room:example.org ",
        "agent:main:matrix:channel:!Room:example.org",
        "agent:main:matrix:channel:!room:example.org",
      ],
      [
        "execution",
        "Agent:Main:Matrix:Channel:!Room:example.org:THREAD:$Event",
        "agent:main:matrix:channel:!Room:example.org:thread:$Event",
        "agent:main:matrix:channel:!Room:example.org:thread:$event",
      ],
      [
        "attempt",
        "Agent:Main:Signal:Group: OpaqueGroup :THREAD:REPLY",
        "agent:main:signal:group:OpaqueGroup:thread:reply",
        "agent:main:signal:group:opaquegroup:thread:reply",
      ],
      [
        "event",
        "Agent:Main:Agent:Worker:catalog:SourceID",
        "agent:main:agent:worker:catalog:SourceID",
        "agent:main:agent:worker:catalog:sourceid",
      ],
      ["unicode-direct", "Agent:Main:ChÄt", "agent:main:chät", "agent:main:chât"],
      ["unicode-event", "Agent:Main:catalog:Ä", "agent:main:catalog:Ä", "agent:main:catalog:ä"],
      ["kelvin-event", "Agent:Main:Key", "agent:main:key", "agent:main:other"],
    ] as const;
    for (const [kind, stored, , other] of cases) {
      for (const [suffix, sessionKey] of [
        ["selected", stored],
        ["collision", other],
      ] as const) {
        const id = `${kind}-${suffix}`;
        const link = kind.endsWith("direct")
          ? { sessionKey }
          : kind === "execution"
            ? {
                sessionKey: "another-session",
                execution: { ...sessionExecution(sessionKey, id, "done"), id },
              }
            : kind === "attempt"
              ? {
                  metadata: {
                    attempts: [{ id, status: "succeeded" as const, startedAt: 1, sessionKey }],
                  },
                }
              : { events: [{ id, kind: "created" as const, at: 1, sessionKey }] };
        await stores.cards.register(id, { version: 1, card: scopedCard(id, link) });
      }
    }
    using raw = new DatabaseSync(dbPath);
    raw
      .prepare("UPDATE workboard_cards SET automation_json = '{' WHERE id LIKE '%-collision'")
      .run();
    const { ids } = await captureRead(async () => {
      for (const [kind, , key] of cases) {
        expect((await store.listCards(undefined, key)).cards.map((card) => card.id)).toEqual([
          `${kind}-selected`,
        ]);
      }
    });
    expect(new Set(ids)).toEqual(new Set(cases.map(([kind]) => `${kind}-selected`)));
    expect((await store.listCards("other", cases[0][2])).cards).toEqual([]);
    expect((await store.listCards(undefined, "missing-session")).cards).toEqual([]);
    await expect(store.listCards(undefined)).rejects.toThrow(SyntaxError);
  });

  // Intercepts native SQLite statements and edits the underlying file mid-read.
  test("hydrates only the completed parents and recent assignee work included in context", async () => {
    const { store, stores, dbPath } = setup();
    const parents = Array.from({ length: 8 }, (_, index) =>
      scopedCard(`parent-${index}`, {
        metadata: { automation: { boardId: "other", summary: `Parent result ${index}` } },
      }),
    );
    const unfinished = scopedCard("unfinished-parent", { status: "running" });
    const links = [
      parents[0]!.id,
      "missing-parent",
      parents[1]!.id,
      unfinished.id,
      ...parents.slice(2).map((card) => card.id),
    ].map((targetCardId, index) => ({
      id: `link-${index}`,
      type: "parent" as const,
      targetCardId,
      createdAt: 1,
    }));
    const current = scopedCard("current", {
      status: "ready",
      agentId: "agent-a",
      metadata: { automation: { boardId: "ops" }, links },
    });
    const siblings = [
      scopedCard("sibling-z", { agentId: "agent-a" }),
      scopedCard("sibling-a", { agentId: "agent-a" }),
      scopedCard("sibling-earlier", { agentId: "agent-a", createdAt: 50 }),
      scopedCard("sibling-archived", {
        agentId: "agent-a",
        position: 0,
        metadata: {
          archivedAt: 1,
          automation: { boardId: "ops", summary: "sibling-archived result" },
        },
      }),
      scopedCard("sibling-newest", { agentId: "agent-a", updatedAt: 300 }),
      scopedCard("sibling-too-old", { agentId: "agent-a", updatedAt: 190 }),
      scopedCard("other-agent", { agentId: "agent-b", updatedAt: 400 }),
      scopedCard("other-board", {
        agentId: "agent-a",
        updatedAt: 400,
        metadata: { automation: { boardId: "other" } },
      }),
      scopedCard("not-done", { agentId: "agent-a", status: "review", updatedAt: 400 }),
    ];
    for (const card of [...parents, unfinished, ...siblings, current]) {
      await stores.cards.register(card.id, { version: 1, card });
    }
    using raw = new DatabaseSync(dbPath);
    let changedParent = false;
    const { value: context, ids } = await captureRead(
      () => store.buildWorkerContext(current.id),
      (_sql, rows) => {
        if (!changedParent && rows.some((row) => row.id === parents[7]!.id)) {
          changedParent = true;
          raw
            .prepare("UPDATE workboard_cards SET status = 'review' WHERE id = ?")
            .run(parents[7]!.id);
        }
      },
    );
    const selectedParents = parents.slice(2);
    const selectedSiblings = [
      "sibling-newest",
      "sibling-archived",
      "sibling-earlier",
      "sibling-a",
      "sibling-z",
    ];
    expect(context).toContain(
      [
        "## Parent results",
        ...selectedParents.map(
          (parent, index) => `- ${parent.id} ${parent.title}: Parent result ${index + 2}`,
        ),
      ].join("\n"),
    );
    expect(context).toContain(
      [
        "## Recent done work by agent-a",
        ...selectedSiblings.map((id) => `- ${id} ${id}: ${id} result`),
      ].join("\n"),
    );
    expect(new Set(ids)).toEqual(
      new Set([current.id, ...selectedParents.map((parent) => parent.id), ...selectedSiblings]),
    );
    expect(ids.length).toBeLessThanOrEqual(12);
    expect(changedParent).toBe(true);
    await expect(store.get(parents[7]!.id)).resolves.toMatchObject({ status: "review" });
  });

  // Injects legacy rows and counts reads through native SQLite handles.
  test("scopes session capture while preserving existing IDs, match preference, and execution fallback", async () => {
    const { store, stores, dbPath } = setup();
    const cases: Array<[string, Partial<WorkboardCard>, Partial<WorkboardCard>]> = [
      ["active", { updatedAt: 1 }, { updatedAt: 999, metadata: { archivedAt: 1 } }],
      ["status", { status: "ready", position: 99 }, { status: "done", position: 0 }],
      ["position", { position: 0 }, { position: 1 }],
      ["created", { createdAt: 1 }, { createdAt: 2 }],
      ["id", {}, {}],
    ];
    for (const [name, left, right] of cases) {
      const sessionKey = `session-${name}`;
      const cards = [
        scopedCard(`arbitrary-${name}-z`, { sessionKey, ...right }),
        scopedCard(`arbitrary-${name}-a`, { sessionKey, ...left }),
      ];
      for (const card of cards) {
        await stores.cards.register(card.id, { version: 1, card });
      }
    }
    const execution = (sessionKey: string) =>
      sessionExecution(sessionKey, `execution-${sessionKey}`, "idle");
    const direct = scopedCard("direct", {
      sessionKey: "direct-session",
      execution: execution("shadowed-session"),
    });
    const nullFallback = scopedCard("null-fallback", { execution: execution("null-session") });
    const emptyFallback = scopedCard("empty-fallback", { execution: execution("empty-session") });
    const absentExecution = scopedCard("absent-execution", {
      execution: execution("absent-session"),
    });
    for (const card of [direct, nullFallback, emptyFallback, absentExecution]) {
      await stores.cards.register(card.id, { version: 1, card });
    }
    using raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE workboard_cards SET session_key = '' WHERE id = ?").run(emptyFallback.id);
    raw
      .prepare("UPDATE workboard_cards SET execution_id = NULL WHERE id = ?")
      .run(absentExecution.id);
    for (const [name] of cases) {
      const { value: captured, ids } = await captureRead(() =>
        store.captureSession({
          title: "Reuse",
          sessionKey: `session-${name}`,
          boardId: "elsewhere",
        }),
      );
      expect(captured).toMatchObject({ id: `arbitrary-${name}-a` });
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.length).toBeLessThanOrEqual(2);
      expect(ids.every((id) => id === `arbitrary-${name}-a` || id === `arbitrary-${name}-z`)).toBe(
        true,
      );
    }
    for (const [sessionKey, id] of [
      ["direct-session", direct.id],
      ["null-session", nullFallback.id],
      ["empty-session", emptyFallback.id],
    ]) {
      await expect(store.captureSession({ title: "Reuse", sessionKey })).resolves.toMatchObject({
        id,
      });
    }
    const shadowed = await store.captureSession({
      title: "New shadowed",
      sessionKey: "shadowed-session",
    });
    expect(shadowed.id).not.toBe(direct.id);
    expect(shadowed.sessionKey).toBe("shadowed-session");
    for (const executionId of [null, ""]) {
      const sessionKey = `absent-session-${executionId === null ? "null" : "empty"}`;
      raw
        .prepare(
          "UPDATE workboard_cards SET execution_id = ?, execution_session_key = ? WHERE id = ?",
        )
        .run(executionId, sessionKey, absentExecution.id);
      const absent = await store.captureSession({ title: "New absent", sessionKey });
      expect(absent.id).not.toBe(absentExecution.id);
      expect(absent.sessionKey).toBe(sessionKey);
    }
  });
});

describe("Workboard board-scoped SQLite hydration", () => {
  // Injects legacy JSON through a native SQLite file handle.
  test("prunes empty legacy automation fields without losing persisted details", async () => {
    const { store, stores, dbPath } = setup();
    const card = await store.create({ title: "Legacy automation" });
    const automation = {
      summary: "Keep persisted details",
      skills: [],
      createdCardIds: [],
      workspace: {},
      workspaceAccess: {},
    };
    {
      using raw = new DatabaseSync(dbPath);
      raw
        .prepare("UPDATE workboard_cards SET automation_json = ? WHERE id = ?")
        .run(JSON.stringify(automation), card.id);
    }
    expect((await store.get(card.id))?.metadata?.automation).toEqual(automation);

    const updated = await store.update(card.id, { metadata: {} });
    expect(updated.metadata?.automation).toEqual({ summary: "Keep persisted details" });
    expect((await stores.cards.lookup(card.id))?.card.metadata?.automation).toEqual({
      summary: "Keep persisted details",
    });
  });

  // Measures fetched rows through the native SQLite statement prototype.
  test("reads only the requested board while preserving complete cards and order", async () => {
    const { store } = setup();
    const later = await store.create({ title: "Later", boardId: "ops", labels: ["one", "two"] });
    await store.addComment(later.id, { body: "Retain this comment" });
    const earlier = await store.create({ title: "Earlier", boardId: "ops", position: 0 });
    const other = await store.create({ title: "Other board", boardId: "product" });
    await store.addComment(other.id, { body: "Unrelated payload" });
    await store.create({ title: "Default board" });
    const expected = [await store.get(earlier.id), await store.get(later.id)];
    const { value, rowCount, queries } = await captureRead(() => store.list({ boardId: " OPS " }));
    expect(value).toEqual(expected);
    // Two card rows, their three events, two labels and one comment.
    expect(rowCount).toBeLessThanOrEqual(8);
    expect(queries).toBeLessThanOrEqual(13);
    await expect(store.list({ boardId: "missing" })).resolves.toEqual([]);
    await expect(store.list({ boardId: "default" })).resolves.toEqual([
      expect.objectContaining({ title: "Default board" }),
    ]);
    await expect(store.list()).resolves.toHaveLength(4);
  });

  // Moves the card through a native SQLite file handle during statement interception.
  test("hydrates captured card IDs even if another connection moves the card after selection", async () => {
    const { store, dbPath } = setup();
    const created = await store.create({ title: "Moving card", boardId: "ops", labels: ["keep"] });
    const expected = await store.addComment(created.id, { body: "Keep across the move" });
    using raw = new DatabaseSync(dbPath);
    let moved = false;
    const { value } = await captureRead(
      () => store.list({ boardId: "ops" }),
      (sql) => {
        if (!moved && /^select\b.*\bfrom "?workboard_cards"?(?:\s|$)/iu.test(sql)) {
          moved = true;
          raw
            .prepare("UPDATE workboard_cards SET board_id = ?, automation_json = ? WHERE id = ?")
            .run(
              "other",
              JSON.stringify({ ...expected.metadata?.automation, boardId: "other" }),
              expected.id,
            );
        }
      },
    );
    expect(value).toEqual([expected]);
    expect(moved).toBe(true);
    await expect(store.list({ boardId: "ops" })).resolves.toEqual([]);
    await expect(store.list({ boardId: "other" })).resolves.toEqual([
      {
        ...expected,
        metadata: {
          ...expected.metadata,
          automation: { ...expected.metadata?.automation, boardId: "other" },
        },
      },
    ]);
  });
});

describe("Workboard card-scoped notification reads", () => {
  // Measures fetched rows through the native SQLite statement prototype.
  test("bounds fetched rows and preserves card scope and missing cards", async () => {
    const { store } = setup();
    const selected = await store.create({
      title: "Selected notifications",
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
      metadata: {
        notifications: [
          { id: "later", kind: "completed", createdAt: 101, sequence: 101000, message: "Later" },
          {
            id: "earlier",
            kind: "completed",
            createdAt: 100,
            sequence: 100000,
            message: "Earlier",
          },
        ],
      },
    });
    const other = await store.create({
      title: "Unrelated",
      boardId: "ops",
      metadata: {
        notifications: [
          { id: "unrelated", kind: "completed", createdAt: 99, message: "Unrelated" },
        ],
      },
    });
    await store.addComment(other.id, { body: "Unrelated payload" });
    await store.create({ title: "Another board", boardId: "other" });
    const subscription = await store.subscribeNotifications({
      cardId: selected.id,
      boardId: "other",
      sessionKey: "session-1",
      runId: "run-1",
      eventKinds: ["completed"],
    });
    const { value, rowCount } = await captureRead(() =>
      store.notificationEvents({ subscriptionId: subscription.id, cardId: other.id, limit: 1 }),
    );
    expect(value).toMatchObject({ events: [{ id: "earlier" }] });
    expect(
      rowCount,
      "card notification reads must not hydrate unrelated cards",
    ).toBeLessThanOrEqual(5);
    await expect(store.notificationEvents({ cardId: ` ${selected.id} ` })).resolves.toMatchObject({
      events: [{ id: "earlier" }, { id: "later" }],
    });
    await expect(store.notificationEvents({ cardId: "missing" })).resolves.toEqual({ events: [] });
  });
});

describe("Workboard dependency status reads", () => {
  // Measures fetched rows through the native SQLite statement prototype.
  test("prepares a card with fifty parents without hydrating each parent's tree", async () => {
    const { store, stores } = setup();
    const parents = [];
    for (let index = 0; index < 50; index++) {
      parents.push(
        await store.create({
          title: `Parent ${index}`,
          status: "done",
          notes: "Parent payload".repeat(100),
        }),
      );
    }
    const child = await store.create({ title: "Ready child", status: "ready" });
    const linked = {
      ...child,
      metadata: {
        ...child.metadata,
        links: parents.map((parent, index) => ({
          id: `parent-${index}`,
          type: "parent" as const,
          targetCardId: parent.id,
          createdAt: 1,
        })),
      },
    };
    await stores.cards.register(child.id, { version: 1, card: linked });
    const expected = await store.get(child.id);
    const { value, queries, rowCount } = await captureRead(() => store.prepareStart(child.id));
    expect(value).toEqual(expected);
    expect(queries).toBeLessThanOrEqual(14);
    expect(rowCount).toBeLessThanOrEqual(102);
  });
});
