import { DatabaseSync, StatementSync } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

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

function fixtureCard(id: string, overrides: Partial<WorkboardCard> = {}): WorkboardCard {
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
  it("hydrates only the completed parents and recent assignee work included in context", async () => {
    const { store, stores, dbPath } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const parents = Array.from({ length: 8 }, (_, index) =>
      fixtureCard(`parent-${index}`, {
        metadata: { automation: { boardId: "other", summary: `Parent result ${index}` } },
      }),
    );
    const unfinished = fixtureCard("unfinished-parent", { status: "running" });
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
    const current = fixtureCard("current", {
      status: "ready",
      agentId: "agent-a",
      metadata: { automation: { boardId: "ops" }, links },
    });
    const siblings = [
      fixtureCard("sibling-z", { agentId: "agent-a" }),
      fixtureCard("sibling-a", { agentId: "agent-a" }),
      fixtureCard("sibling-earlier", { agentId: "agent-a", createdAt: 50 }),
      fixtureCard("sibling-archived", {
        agentId: "agent-a",
        position: 0,
        metadata: {
          archivedAt: 1,
          automation: { boardId: "ops", summary: "sibling-archived result" },
        },
      }),
      fixtureCard("sibling-newest", { agentId: "agent-a", updatedAt: 300 }),
      fixtureCard("sibling-too-old", { agentId: "agent-a", updatedAt: 190 }),
      fixtureCard("other-agent", { agentId: "agent-b", updatedAt: 400 }),
      fixtureCard("other-board", {
        agentId: "agent-a",
        updatedAt: 400,
        metadata: { automation: { boardId: "other" } },
      }),
      fixtureCard("not-done", { agentId: "agent-a", status: "review", updatedAt: 400 }),
    ];
    for (const card of [...parents, unfinished, ...siblings, current]) {
      await stores.cards.register(card.id, { version: 1, card });
    }
    const hydratedIds: unknown[] = [];
    const raw = new DatabaseSync(dbPath);
    let changedParent = false;
    const restore = observeReads((_sql, rows) => {
      hydratedIds.push(...rows.filter((row) => "notes" in row).map((row) => row.id));
      if (!changedParent && rows.some((row) => row.id === parents[7]!.id)) {
        changedParent = true;
        raw
          .prepare("UPDATE workboard_cards SET status = 'review' WHERE id = ?")
          .run(parents[7]!.id);
      }
    });
    let context: string;
    try {
      context = await store.buildWorkerContext(current.id);
    } finally {
      restore();
      raw.close();
    }
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
    expect(new Set(hydratedIds)).toEqual(
      new Set([current.id, ...selectedParents.map((parent) => parent.id), ...selectedSiblings]),
    );
    expect(hydratedIds.length).toBeLessThanOrEqual(12);
    expect(changedParent).toBe(true);
    await expect(store.get(parents[7]!.id)).resolves.toMatchObject({ status: "review" });
  });

  it("isolates unrelated corruption while preserving selected context and capture failures through the worker", async () => {
    const { store, stores, dbPath } = createWorkboardSqliteTestHarness();
    const parent = fixtureCard("selected-parent");
    const current = fixtureCard("selected", {
      status: "ready",
      sessionKey: "selected-session",
      metadata: {
        automation: { boardId: "ops" },
        links: [{ id: "parent-link", type: "parent", targetCardId: parent.id, createdAt: 1 }],
      },
    });
    const unrelated = fixtureCard("unrelated");
    for (const card of [parent, current, unrelated]) {
      await stores.cards.register(card.id, { version: 1, card });
    }
    await store.addComment(parent.id, { body: "Valid parent comment" });
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE workboard_cards SET automation_json = '{invalid' WHERE id = ?")
        .run(unrelated.id);
      await expect(store.buildWorkerContext(current.id)).resolves.toContain(
        "selected-parent result",
      );
      await expect(
        store.captureSession({
          title: "Reuse",
          sessionKey: "selected-session",
          boardId: "elsewhere",
        }),
      ).resolves.toMatchObject({ id: current.id });
      raw
        .prepare("UPDATE workboard_cards SET automation_json = '{invalid' WHERE id = ?")
        .run(current.id);
      await expect(store.buildWorkerContext(current.id)).rejects.toThrow(SyntaxError);
      await expect(
        store.captureSession({ title: "Reuse", sessionKey: "selected-session" }),
      ).rejects.toThrow(SyntaxError);
      raw
        .prepare("UPDATE workboard_cards SET automation_json = ? WHERE id = ?")
        .run(JSON.stringify(current.metadata?.automation), current.id);
      raw.prepare("UPDATE workboard_card_comments SET body = '' WHERE card_id = ?").run(parent.id);
      await expect(store.buildWorkerContext(current.id)).rejects.toThrow("missing body");
      await expect(
        store.captureSession({ title: "Reuse", sessionKey: "selected-session" }),
      ).resolves.toMatchObject({ id: current.id });
    } finally {
      raw.close();
    }
  });

  it("scopes session capture while preserving existing IDs, match preference, and execution fallback", async () => {
    const { store, stores, dbPath } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const cases: Array<{
      name: string;
      left: Partial<WorkboardCard>;
      right: Partial<WorkboardCard>;
    }> = [
      {
        name: "active",
        left: { updatedAt: 1 },
        right: { updatedAt: 999, metadata: { archivedAt: 1 } },
      },
      {
        name: "status",
        left: { status: "ready", position: 99 },
        right: { status: "done", position: 0 },
      },
      { name: "position", left: { position: 0 }, right: { position: 1 } },
      { name: "created", left: { createdAt: 1 }, right: { createdAt: 2 } },
      { name: "id", left: {}, right: {} },
    ];
    for (const { name, left, right } of cases) {
      const sessionKey = `session-${name}`;
      const cards = [
        fixtureCard(`arbitrary-${name}-z`, { sessionKey, ...right }),
        fixtureCard(`arbitrary-${name}-a`, { sessionKey, ...left }),
      ];
      for (const card of cards) {
        await stores.cards.register(card.id, { version: 1, card });
      }
    }
    const execution = (sessionKey: string): NonNullable<WorkboardCard["execution"]> => ({
      id: `execution-${sessionKey}`,
      kind: "agent-session",
      mode: "autonomous",
      status: "idle",
      sessionKey,
      startedAt: 1,
      updatedAt: 2,
    });
    const direct = fixtureCard("direct", {
      sessionKey: "direct-session",
      execution: execution("shadowed-session"),
    });
    const nullFallback = fixtureCard("null-fallback", { execution: execution("null-session") });
    const emptyFallback = fixtureCard("empty-fallback", { execution: execution("empty-session") });
    const absentExecution = fixtureCard("absent-execution", {
      execution: execution("absent-session"),
    });
    for (const card of [direct, nullFallback, emptyFallback, absentExecution]) {
      await stores.cards.register(card.id, { version: 1, card });
    }
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare("UPDATE workboard_cards SET session_key = '' WHERE id = ?").run(emptyFallback.id);
      raw
        .prepare("UPDATE workboard_cards SET execution_id = NULL WHERE id = ?")
        .run(absentExecution.id);
      for (const { name } of cases) {
        const hydratedIds: unknown[] = [];
        const restore = observeReads((_sql, rows) => {
          hydratedIds.push(...rows.filter((row) => "notes" in row).map((row) => row.id));
        });
        try {
          await expect(
            store.captureSession({
              title: "Reuse",
              sessionKey: `session-${name}`,
              boardId: "elsewhere",
            }),
          ).resolves.toMatchObject({ id: `arbitrary-${name}-a` });
        } finally {
          restore();
        }
        expect(hydratedIds.length).toBeGreaterThan(0);
        expect(hydratedIds.length).toBeLessThanOrEqual(2);
        expect(
          hydratedIds.every((id) => id === `arbitrary-${name}-a` || id === `arbitrary-${name}-z`),
        ).toBe(true);
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
    } finally {
      raw.close();
    }
  });
});

describe("Workboard board-scoped SQLite hydration", () => {
  it("reads only the requested board while preserving complete cards and order", async () => {
    const { store } = createWorkboardSqliteTestHarness({ createStores: createKernelStores });
    const later = await store.create({ title: "Later", boardId: "ops", labels: ["one", "two"] });
    await store.addComment(later.id, { body: "Retain this comment" });
    const earlier = await store.create({ title: "Earlier", boardId: "ops", position: 0 });
    const other = await store.create({ title: "Other board", boardId: "product" });
    await store.addComment(other.id, { body: "Unrelated payload" });
    await store.create({ title: "Default board" });
    const expected = [await store.get(earlier.id), await store.get(later.id)];
    let fetchedRows = 0;
    let queries = 0;
    const restore = observeReads((sql, rows) => {
      if (/^select\b/iu.test(sql) && /\bfrom "?workboard_/iu.test(sql)) {
        queries++;
        fetchedRows += rows.length;
      }
    });
    try {
      await expect(store.list({ boardId: " OPS " })).resolves.toEqual(expected);
    } finally {
      restore();
    }
    // Two card rows, their three events, two labels and one comment.
    expect(fetchedRows).toBeGreaterThan(0);
    expect(fetchedRows).toBeLessThanOrEqual(8);
    expect(queries).toBeGreaterThan(0);
    expect(queries).toBeLessThanOrEqual(13);
    await expect(store.list({ boardId: "missing" })).resolves.toEqual([]);
    await expect(store.list({ boardId: "default" })).resolves.toEqual([
      expect.objectContaining({ title: "Default board" }),
    ]);
    await expect(store.list()).resolves.toHaveLength(4);
  });

  it("isolates unrelated corruption while retaining requested-board and full-list errors", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const selected = await store.create({ title: "Selected", boardId: "ops" });
    const unrelated = await store.create({ title: "Unrelated", boardId: "other" });
    await store.addComment(unrelated.id, { body: "Valid before corruption" });
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE workboard_card_comments SET body = '' WHERE card_id = ?")
        .run(unrelated.id);
      await expect(store.list({ boardId: "ops" })).resolves.toEqual([selected]);
      await expect(store.list({ boardId: "missing" })).resolves.toEqual([]);
      await expect(store.list({ boardId: "other" })).rejects.toThrow("missing body");
      await expect(store.list()).rejects.toThrow("missing body");
      raw
        .prepare("UPDATE workboard_card_comments SET body = 'Repaired' WHERE card_id = ?")
        .run(unrelated.id);
      raw
        .prepare("UPDATE workboard_cards SET automation_json = '{invalid' WHERE id = ?")
        .run(unrelated.id);
      await expect(store.list({ boardId: "ops" })).resolves.toEqual([selected]);
      await expect(store.list({ boardId: "other" })).rejects.toThrow(SyntaxError);
      await expect(store.list()).rejects.toThrow(SyntaxError);
    } finally {
      raw.close();
    }
  });

  it("hydrates captured card IDs even if another connection moves the card after selection", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const created = await store.create({ title: "Moving card", boardId: "ops", labels: ["keep"] });
    const expected = await store.addComment(created.id, { body: "Keep across the move" });
    const raw = new DatabaseSync(dbPath);
    let moved = false;
    const restore = observeReads((sql) => {
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
    });
    try {
      await expect(store.list({ boardId: "ops" })).resolves.toEqual([expected]);
      expect(moved).toBe(true);
    } finally {
      restore();
      raw.close();
    }
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
  it("bounds fetched rows and preserves card scope, missing cards, and cursor advancement", async () => {
    const { store } = createWorkboardSqliteTestHarness({ createStores: createKernelStores });
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
    let fetchedRows = 0;
    const restore = observeReads((sql, rows) => {
      if (/^select\b/iu.test(sql) && /\bfrom "?workboard_/iu.test(sql)) {
        fetchedRows += rows.length;
      }
    });
    try {
      await expect(
        store.notificationEvents({ subscriptionId: subscription.id, cardId: other.id, limit: 1 }),
      ).resolves.toMatchObject({ events: [{ id: "earlier" }] });
    } finally {
      restore();
    }
    expect(fetchedRows).toBeGreaterThan(0);
    expect(
      fetchedRows,
      "card notification reads must not hydrate unrelated cards",
    ).toBeLessThanOrEqual(5);
    await expect(store.notificationEvents({ cardId: ` ${selected.id} ` })).resolves.toMatchObject({
      events: [{ id: "earlier" }, { id: "later" }],
    });
    await expect(store.notificationEvents({ cardId: "missing" })).resolves.toEqual({ events: [] });
    await expect(
      store.advanceNotificationEvents({ subscriptionId: subscription.id, limit: 1 }),
    ).resolves.toMatchObject({ events: [{ id: "earlier" }] });
    await expect(
      store.advanceNotificationEvents({ subscriptionId: subscription.id, limit: 1 }),
    ).resolves.toMatchObject({ events: [{ id: "later" }] });
    await expect(
      store.notificationEvents({ subscriptionId: subscription.id }),
    ).resolves.toMatchObject({ events: [] });
  });

  it("isolates unrelated card corruption while retaining selected-card and board-wide failures", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const selected = await store.create({
      title: "Selected",
      boardId: "ops",
      metadata: {
        notifications: [
          { id: "selected-event", kind: "completed", createdAt: 100, message: "Done" },
        ],
      },
    });
    const other = await store.create({ title: "Unrelated", boardId: "ops" });
    await store.addComment(other.id, { body: "Valid before corruption" });
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare("UPDATE workboard_card_comments SET body = '' WHERE card_id = ?").run(other.id);
      await expect(store.notificationEvents({ cardId: selected.id })).resolves.toMatchObject({
        events: [{ id: "selected-event" }],
      });
      await expect(store.notificationEvents({ cardId: "missing" })).resolves.toEqual({
        events: [],
      });
      await expect(store.notificationEvents({ cardId: other.id })).rejects.toThrow("missing body");
      await expect(store.notificationEvents({ boardId: "ops" })).rejects.toThrow("missing body");
      await expect(store.notificationEvents()).rejects.toThrow("missing body");
      raw
        .prepare("UPDATE workboard_card_comments SET body = 'Repaired' WHERE card_id = ?")
        .run(other.id);
      raw
        .prepare("UPDATE workboard_cards SET automation_json = '{invalid' WHERE id = ?")
        .run(selected.id);
      await expect(store.notificationEvents({ cardId: selected.id })).rejects.toThrow(SyntaxError);
    } finally {
      raw.close();
    }
  });
});

describe("Workboard dependency status reads", () => {
  it("prepares a card with fifty parents without hydrating each parent's tree", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
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
    let queries = 0;
    let fetchedRows = 0;
    const restore = observeReads((sql, rows) => {
      if (/^select\b/iu.test(sql) && /\bfrom "?workboard_/iu.test(sql)) {
        queries++;
        fetchedRows += rows.length;
      }
    });
    try {
      await expect(store.prepareStart(child.id)).resolves.toEqual(expected);
    } finally {
      restore();
    }
    expect(queries).toBeLessThanOrEqual(14);
    expect(fetchedRows).toBeLessThanOrEqual(102);
    expect(queries).toBeGreaterThan(0);
    expect(fetchedRows).toBeGreaterThan(0);
  });

  it("checks dependency statuses without decoding unrelated cards or parent payloads", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const parent = await store.create({ title: "Done parent", status: "done" });
    const child = await store.create({ title: "Child", parents: [parent.id] });
    const unrelated = await store.create({ title: "Unrelated", boardId: "other" });
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE workboard_cards SET automation_json = '{invalid' WHERE id IN (?, ?)")
        .run(parent.id, unrelated.id);
      await expect(store.prepareStart(child.id)).resolves.toMatchObject({
        id: child.id,
        status: "ready",
      });
      await expect(store.move(child.id, "done", child.position)).resolves.toMatchObject({
        id: child.id,
        status: "done",
      });
      await expect(store.get(parent.id)).rejects.toThrow(SyntaxError);
      await expect(store.get(unrelated.id)).rejects.toThrow(SyntaxError);
      await expect(store.list()).rejects.toThrow(SyntaxError);
      raw
        .prepare("UPDATE workboard_cards SET automation_json = '{invalid' WHERE id = ?")
        .run(child.id);
      await expect(store.prepareStart(child.id)).rejects.toThrow(SyntaxError);
    } finally {
      raw.close();
    }
  });

  it.each([false, true])(
    "preserves repeated parent IDs and lookup trimming (spaced: %s)",
    async (spaced) => {
      const { store, stores } = createWorkboardSqliteTestHarness();
      const parent = await store.create({ title: "Done parent", status: "done" });
      const child = await store.create({ title: "Ready child", status: "ready" });
      await stores.cards.register(child.id, {
        version: 1,
        card: {
          ...child,
          metadata: {
            ...child.metadata,
            links: [parent.id, spaced ? ` ${parent.id} ` : parent.id].map(
              (targetCardId, index) => ({
                id: `parent-${index}`,
                type: "parent",
                targetCardId,
                createdAt: 1,
              }),
            ),
          },
        },
      });
      await expect(store.prepareStart(child.id)).resolves.toMatchObject({
        id: child.id,
        status: "ready",
      });
      if (spaced) {
        await expect(store.move(child.id, "done", child.position)).rejects.toThrow(
          "card dependencies are not done.",
        );
      } else {
        await expect(store.move(child.id, "done", child.position)).resolves.toMatchObject({
          status: "done",
        });
      }
    },
  );

  it("retains missing, unknown and invalid parent status holds", async () => {
    const { store, stores, dbPath } = createWorkboardSqliteTestHarness();
    const parent = await store.create({ title: "Parent", status: "done" });
    const child = await store.create({ title: "Child", parents: [parent.id] });
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE workboard_cards SET status = 'future-status' WHERE id = ?")
        .run(parent.id);
      await expect(store.prepareStart(child.id)).resolves.toMatchObject({ status: "todo" });
      await expect(store.move(child.id, "ready", child.position)).rejects.toThrow(
        "card dependencies are not done.",
      );
      raw.prepare("UPDATE workboard_cards SET status = '' WHERE id = ?").run(parent.id);
      await expect(store.prepareStart(child.id)).rejects.toThrow(
        "workboard sqlite row missing status",
      );
      await expect(store.move(child.id, "ready", child.position)).rejects.toThrow(
        "workboard sqlite row missing status",
      );
      await stores.cards.delete(parent.id);
      await expect(store.prepareStart(child.id)).resolves.toMatchObject({ status: "todo" });
      await expect(store.move(child.id, "ready", child.position)).rejects.toThrow(
        "card dependencies are not done.",
      );
    } finally {
      raw.close();
    }
  });
});
