import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDefaultWorkboardSessionsBoardSpec,
  type WorkboardSessionFacts,
  type WorkboardSessionsColumn,
  type WorkboardSessionsBoardSpec,
} from "@openclaw/workboard-contract";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createWorkboardSessionsBoardService } from "./sessions-board.js";
import {
  BOARD_ID,
  DEFAULT_COLUMNS,
  facts,
  FOCUS_COLUMN,
  NOW,
  OTHER_COLUMN,
} from "./sessions-board.test-support.js";
import { WorkboardBoardStore } from "./store-boards.js";
import { createKernelStores } from "./test/sqlite-kernel.js";

// The service consumes the redaction contract, not the host diagnostics scheduler.
vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  redactToolPayloadText: (text: string) => text,
}));

let tempDir: string;
let nextDatabase = 0;
beforeAll(() => {
  // openclaw-temp-dir: allow keeps this synchronous SQLite fixture out of test-env's compiled-worker graph.
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-board-"));
});
afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

type ServiceParams = Parameters<typeof createWorkboardSessionsBoardService>[0];
type SelectedFacts = Parameters<Parameters<ServiceParams["gateway"]["withSessionFacts"]>[1]>[0];
type FactsSelection = Parameters<ServiceParams["gateway"]["withSessionFacts"]>[0];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
});
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  try {
    await dispose?.();
  } finally {
    dispose = undefined;
    vi.useRealTimers();
  }
});
async function createFixture(
  rows: (string | WorkboardSessionFacts)[] = [],
  options: {
    spec?: Partial<WorkboardSessionsBoardSpec>;
    repair?: Promise<{ placements: number; boards: number }>;
  } = {},
) {
  const stores = createKernelStores(path.join(tempDir, `${nextDatabase++}.sqlite`));
  const store = new WorkboardBoardStore(stores.cards, {
    ...stores,
    runWithWriteAuthority: async (assertCurrent, run) => {
      assertCurrent();
      return await run();
    },
  });
  await store.upsertBoard({ id: BOARD_ID, kind: "sessions" });
  await store.updateSessionsBoard(BOARD_ID, {
    columns: [FOCUS_COLUMN, OTHER_COLUMN],
    ...options.spec,
  });
  const state: SelectedFacts = {
    scope: "shared-scope",
    revision: "initial",
    sessions: rows.map((row) => (typeof row === "string" ? facts(row) : row)),
  };
  const selectSessionFacts = vi.fn<(selection: FactsSelection) => Promise<SelectedFacts>>(
    async () => ({ ...state }),
  );
  const readSessionFacts = vi.fn<ServiceParams["gateway"]["readSessionFacts"]>(
    async ({ sessionKeys }) => ({
      sessions: state.sessions.filter((session) => sessionKeys.includes(session.key)),
    }),
  );
  let listener: Parameters<ServiceParams["gateway"]["subscribeSessionChanges"]>[0] | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const gateway: ServiceParams["gateway"] = {
    readSessionFacts,
    withSessionFacts: async (select, run) => run(await selectSessionFacts(select)),
    subscribeSessionChanges: (callback) => {
      listener = callback;
      return unsubscribe;
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = createWorkboardSessionsBoardService({ store, gateway });
  const context = { config: {}, stateDir: "unused", logger };
  const repair = vi.spyOn(store, "repairSessionPlacements");
  if (options.repair) {
    repair.mockReturnValueOnce(options.repair);
  }
  await service.start(context);
  dispose = async () => {
    await service.stop();
    await store.close();
  };
  const emit = (key: string, factsInvalidated?: string) =>
    listener?.({ agentId: "main", sessionKey: key, factsInvalidated });
  return {
    store,
    read: service.read.bind(service, BOARD_ID),
    stored: (id = BOARD_ID) => store.getSessionsBoard(id),
    selectOnce: (snapshot: Partial<SelectedFacts>) =>
      selectSessionFacts.mockResolvedValueOnce({ ...state, ...snapshot }),
    move: service.move.bind(service, BOARD_ID),
    update: service.update.bind(service, BOARD_ID),
    pins: store.listSessionPlacements.bind(store, BOARD_ID),
    state,
    selectFacts: selectSessionFacts,
    readFacts: readSessionFacts,
    logger,
    service,
    unsubscribe,
    repair,
    context,
    emit,
    publish(
      revision: string,
      sessions: SelectedFacts["sessions"],
      changed = sessions.slice(0, 1).map(({ key }) => key),
    ) {
      Object.assign(state, { revision, sessions });
      changed.forEach((key) => emit(key));
    },
  };
}

function ruleColumn(id: string, match: WorkboardSessionsColumn["match"]): WorkboardSessionsColumn {
  return { id, label: id, description: id, match };
}
function pr(number: number, state: "open" | "merged" = "open") {
  return [{ number, state }];
}
function observed(health: NonNullable<WorkboardSessionFacts["observerDigest"]>["health"]) {
  return { health, headline: health, revision: 1 };
}
function authority(isActive: () => boolean) {
  return {
    assertCurrent() {
      if (!isActive()) {
        throw new Error("Caller authority expired");
      }
    },
  };
}
async function expectClassification(
  spec: Partial<WorkboardSessionsBoardSpec>,
  rows: [string, Partial<WorkboardSessionFacts>, string][],
) {
  const board = await createFixture(
    rows.map(([id, overrides]) => facts(id, overrides)),
    { spec },
  );
  const read = await board.read();
  expect(read.sessions.map(({ label, columnId, source }) => [label, columnId, source])).toEqual(
    rows.map(([id, , target]) => [id, target, "state"]),
  );
  expect(await board.pins()).toEqual([]);
  expect(board.selectFacts).toHaveBeenCalledWith(
    expect.objectContaining({
      configuredAgentsOnly: true,
      includeGlobal: false,
      includeUnknown: false,
    }),
  );
  return read;
}

it("always excludes dock conversations and filters automation unless the scope opts in", async () => {
  const board = await createFixture();
  await board.read();
  expect(board.selectFacts.mock.calls[0]?.[0]).toMatchObject({
    excludeCron: true,
    excludeSystem: true,
    excludeDock: true,
  });
  expect(board.selectFacts.mock.calls[0]?.[0]).not.toHaveProperty("excludeSubagents");
  await expect(board.move("agent:main:cron:job:trigger", "other")).rejects.toThrow(
    "not available in this board's scope",
  );
  expect(board.selectFacts.mock.lastCall?.[0]).toMatchObject({
    excludeCron: true,
    excludeSystem: true,
  });
  expect(await board.pins()).toEqual([]);
  await board.update({ scope: { includeAutomation: true } });
  await board.read();
  expect(board.selectFacts.mock.lastCall?.[0]).toHaveProperty("excludeDock", true);
  expect(board.selectFacts.mock.lastCall?.[0]).not.toHaveProperty("excludeCron");
  expect(board.selectFacts.mock.lastCall?.[0]).not.toHaveProperty("excludeSystem");
  expect(board.selectFacts.mock.lastCall?.[0]).not.toHaveProperty("excludeSubagents");
});

it.each([undefined, "home"])(
  "excludes each agent's configured Home session (%s) from reads and moves",
  async (mainKey) => {
    const home = { ...facts(mainKey ?? "main"), isMain: true };
    const otherHome = {
      ...facts("other-home", { key: `agent:ops:${mainKey ?? "main"}`, agentId: "ops" }),
      isMain: true,
    };
    const work = facts("subagent:worker");
    const board = await createFixture([home, otherHome, work]);
    expect((await board.read()).sessions.map(({ key }) => key)).toEqual([work.key]);
    expect(board.readFacts).not.toHaveBeenCalled();
    await expect(board.move(home.key, "other")).rejects.toThrow(
      "not available in this board's scope",
    );
    expect(await board.pins()).toEqual([]);
    await board.update({ scope: { includeHome: true } });
    expect((await board.read()).sessions.map(({ key }) => key)).toEqual([
      home.key,
      otherHome.key,
      work.key,
    ]);
    await board.move(home.key, "focus");
    await board.update({ scope: { includeHome: false } });
    expect((await board.read()).sessions.map(({ key }) => key)).toEqual([work.key]);
  },
);

it("rejects a move when caller authority ends during the facts read", async () => {
  const board = await createFixture(["one"]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = true;
  board.readFacts.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { sessions: [facts("one")] };
  });
  const caller = authority(() => active);
  const pending = board.move(facts("one").key, "other", caller);
  const rejected = expect(pending).rejects.toThrow("Caller authority expired");
  await entered.promise;
  active = false;
  release.resolve();
  await rejected;
  expect(await board.pins()).toEqual([]);
});

it("classifies custom conjunctions, alternatives, and unknown PR state", async () => {
  const digest = observed("on-track");
  const read = await expectClassification(
    {
      scope: { includeArchived: true },
      columns: [
        ruleColumn("review", [
          { health: ["on-track"], run: ["active"], pullRequest: ["open"], archived: false },
          { run: ["failed"], archived: false },
        ]),
        ruleColumn("active", { run: ["active"] }),
        ruleColumn("no-pr", { pullRequest: ["none"] }),
        OTHER_COLUMN,
      ],
    },
    [
      ["all", { run: "active", observerDigest: digest, pullRequests: pr(1) }, "review"],
      ["no-digest", { run: "active", pullRequests: pr(2) }, "active"],
      ["active-no-pr", { run: "active", observerDigest: digest }, "active"],
      [
        "archived",
        { run: "active", observerDigest: digest, archived: true, pullRequests: pr(3) },
        "active",
      ],
      ["idle-pr", { observerDigest: digest, pullRequests: pr(4) }, "other"],
      ["none", {}, "no-pr"],
      ["unknown", { pullRequestsUnavailable: true }, "other"],
      ["failed", { run: "failed" }, "review"],
    ],
  );
  expect(read.columns.map((column) => column.id)).toEqual(["review", "active", "no-pr", "other"]);
  expect(read.warning).toContain("Pull-request facts for 1 session are not loaded yet.");
  expect(read.sessions.find((session) => session.label === "unknown")?.reason).toBe(
    "facts-unavailable",
  );
});

it("classifies default rule priority for unobserved runs and PRs", async () => {
  const read = await expectClassification(createDefaultWorkboardSessionsBoardSpec(), [
    ["active", { run: "active" }, "working"],
    ["failed", { run: "failed" }, "stuck"],
    ["unhealthy-active", { run: "active", observerDigest: observed("stuck") }, "stuck"],
    ["needs-input", { run: "active", observerDigest: observed("waiting-on-user") }, "needs-input"],
    ["review", { pullRequests: pr(1) }, "in-review"],
    ["merged", { pullRequests: pr(2, "merged") }, "merged"],
    ["idle", {}, "done"],
  ]);
  expect(read.columns.map((column) => column.id)).toEqual(DEFAULT_COLUMNS);
  expect(read.warning).toBeUndefined();
});

it.each([false, true])(
  "waits for placement repair on first use and drains it on stop (stop early: %s)",
  async (stopEarly) => {
    const repair = Promise.withResolvers<{ placements: number; boards: number }>();
    const board = await createFixture([], { repair: repair.promise });
    const readDone = vi.fn();
    const updateDone = vi.fn();
    const reading = board.read().finally(readDone);
    const updating = board.update({ scope: { maxAgeHours: 48 } }).finally(updateDone);
    const results = Promise.allSettled([reading, updating]);
    const stopped = vi.fn();
    const stopping = stopEarly ? board.service.stop().then(stopped) : undefined;
    expect([readDone, updateDone, stopped].map((done) => done.mock.calls)).toEqual([[], [], []]);
    repair.resolve({ placements: 3, boards: 0 });
    if (stopEarly) {
      const rejected = {
        status: "rejected",
        reason: expect.objectContaining({ message: "Sessions board service is no longer active." }),
      };
      expect(await results).toEqual([rejected, rejected]);
      await stopping;
      expect((await board.stored()).sessions.scope?.maxAgeHours).not.toBe(48);
    } else {
      expect((await results).map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await board.stored()).sessions.scope?.maxAgeHours).toBe(48);
    }
    expect(board.logger.info).toHaveBeenCalledExactlyOnceWith(
      "Sessions board removed 3 non-operator placements.",
    );
  },
);

it("repairs only old-default rules at startup, preserves custom boards and ordering, and is idempotent", async () => {
  const board = await createFixture();
  expect(board.repair).toHaveBeenCalledOnce();
  await board.read();
  await board.read();
  expect(board.repair).toHaveBeenCalledOnce();
  expect(board.readFacts).not.toHaveBeenCalled();
  await board.service.stop();
  const oldSpec = createDefaultWorkboardSessionsBoardSpec();
  const oldOrder = ["needs-input", "working", "stuck", "in-review", "merged", "done"];
  oldSpec.columns.sort((a, b) => oldOrder.indexOf(a.id) - oldOrder.indexOf(b.id));
  for (const column of oldSpec.columns) {
    if (column.id === "working") {
      column.match = { run: ["active"], health: ["on-track", "grinding", "wrapping-up"] };
      column.label = "Building";
      column.description = "My own description";
    } else if (column.id === "stuck") {
      column.match = { health: ["stuck", "failed"] };
    }
  }
  oldSpec.scope = { maxAgeHours: 24 };
  await board.store.updateSessionsBoard(BOARD_ID, oldSpec);
  await board.store.upsertBoard({ id: "custom", kind: "sessions" });
  const customSpec = structuredClone(oldSpec);
  customSpec.columns = customSpec.columns.map((column) =>
    column.id === "working" ? { ...column, match: { run: ["active"] } } : column,
  );
  const custom = await board.store.updateSessionsBoard("custom", customSpec);
  await board.store.upsertBoard({ id: "custom-order", kind: "sessions" });
  const reordered = structuredClone(oldSpec);
  reordered.columns.reverse();
  await board.store.updateSessionsBoard("custom-order", reordered);
  board.logger.info.mockClear();
  await board.service.start(board.context);
  await board.read();
  const repaired = await board.stored();
  expect(repaired.sessions.columns.map((column) => column.id)).toEqual(DEFAULT_COLUMNS);
  expect(repaired.sessions.columns.find((column) => column.id === "working")).toMatchObject({
    label: "Building",
    description: "My own description",
    match: { run: ["active"] },
  });
  expect(repaired.sessions.columns.find((column) => column.id === "stuck")?.match).toEqual([
    { health: ["stuck", "failed"] },
    { run: ["failed"] },
  ]);
  expect(repaired.sessions.scope).toEqual({ maxAgeHours: 24 });
  expect(await board.stored("custom")).toEqual(custom);
  expect((await board.stored("custom-order")).sessions.columns.map((column) => column.id)).toEqual(
    oldOrder.toReversed(),
  );
  await board.service.stop();
  await board.service.start(board.context);
  expect(await board.stored()).toEqual(repaired);
  expect(board.logger.info).toHaveBeenCalledOnce();
});

it("coalesces notifications and refreshes board facts after publications", async () => {
  const board = await createFixture(["one", "two"]);
  const changed = vi.spyOn(board.store, "announceChangeEpoch");
  expect(board.readFacts).not.toHaveBeenCalled();
  board.emit(facts("one").key);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(changed).not.toHaveBeenCalled();
  await board.read();
  await board.store.upsertBoard({ id: "second", kind: "sessions" });
  expect((await board.service.read("second")).sessions).toHaveLength(2);
  changed.mockClear();
  board.publish("active", [facts("one", { run: "active" }), facts("two")]);
  expect((await board.read()).sessions[0]).toMatchObject({ columnId: "focus" });
  board.state.sessions = [
    facts("one", { run: "active", label: "Updated during burst" }),
    facts("two"),
  ];
  board.state.revision = "updated";
  for (let event = 1; event < 100; event += 1) {
    await vi.advanceTimersByTimeAsync(40);
    board.emit(event === 99 ? "agent:main:not-cached" : facts("one").key);
  }
  await vi.advanceTimersByTimeAsync(1_039);
  expect(changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(changed).toHaveBeenCalledOnce();
  const read = await board.read();
  expect(read.sessions[0]).toMatchObject({ columnId: "focus", label: "Updated during burst" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(changed).toHaveBeenCalledOnce();
  board.emit(facts("two").key);
  await board.service.stop();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(board.unsubscribe).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "classifies confirmed stale PR facts and reports unavailable facts (rate limited: %s)",
  async (rateLimited) => {
    const availability = rateLimited
      ? { pullRequestsRateLimited: true as const }
      : { pullRequestsUnavailable: true };
    const rows = [
      {
        ...facts("review", { pullRequests: pr(1), ...availability }),
        pullRequestsStale: true as const,
      },
      {
        ...facts("merged", { pullRequests: pr(2, "merged"), ...availability }),
        pullRequestsStale: true as const,
      },
      { ...facts("none", availability), pullRequestsStale: true as const },
      facts("unknown", availability),
    ];
    const board = await createFixture(rows, { spec: createDefaultWorkboardSessionsBoardSpec() });
    const read = await board.read();
    expect(read.sessions).toMatchObject([
      { columnId: "in-review" },
      { columnId: "merged" },
      { columnId: "done", reason: "fallback" },
      { columnId: "done", reason: "facts-unavailable" },
    ]);
    const suffix = rateLimited ? " (GitHub rate limited)" : "";
    expect(read.warning).toBe(
      `Pull-request facts for 3 sessions are stale${suffix}. Pull-request facts for 1 session are not loaded yet${suffix}.`,
    );
    board.state.sessions = [
      { ...rows[0]!, run: "active" },
      { ...rows[1]!, observerDigest: observed("waiting-on-user") },
      ...rows.slice(2),
    ];
    board.state.revision = "new-run-and-health";
    board.emit(rows[0]!.key);
    board.emit(rows[1]!.key);
    expect((await board.read()).sessions.slice(0, 2)).toMatchObject([
      { run: "active", columnId: "working", pullRequests: rows[0]!.pullRequests },
      {
        observerDigest: { health: "waiting-on-user" },
        columnId: "needs-input",
        pullRequests: rows[1]!.pullRequests,
      },
    ]);
  },
);

it("announces sessions added after the first read", async () => {
  const board = await createFixture();
  expect((await board.read()).sessions).toEqual([]);
  const changed = vi.spyOn(board.store, "announceChangeEpoch");
  board.publish("new-session", [facts("new", { pullRequestsUnavailable: true })]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(changed).toHaveBeenCalledOnce();
  expect((await board.read()).sessions).toMatchObject([
    { key: facts("new").key, reason: "facts-unavailable" },
  ]);
});

it("shares projections and reuses 80 unchanged rows after one session changes", async () => {
  const board = await createFixture(
    Array.from({ length: 81 }, (_, index) => Object.freeze(facts(String(index)))),
  );
  const placements = vi.spyOn(board.store, "listSessionPlacements");
  const boards = vi.spyOn(board.store, "getSessionsBoard");
  const changes = vi.fn();
  board.store.onChange = changes;
  const readers = await Promise.all(
    Array.from({ length: 25 }, () => board.read(undefined, { assertCurrent() {} })),
  );
  const first = readers[0]!;
  expect(readers.every((read) => read === first)).toBe(true);
  expect(first.sessions).toHaveLength(81);
  expect(boards).toHaveBeenCalledOnce();
  expect(placements).toHaveBeenCalledOnce();
  board.emit(facts("0").key, "category");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(changes).not.toHaveBeenCalled();
  expect(await board.read()).toBe(first);
  vi.setSystemTime(NOW + 10 * 60_000);
  expect(await board.read()).toBe(first);
  board.publish("one-row-changed", [
    Object.freeze({ ...board.state.sessions[0]!, run: "active" as const }),
    ...board.state.sessions.slice(1),
  ]);
  await vi.advanceTimersByTimeAsync(5_000);
  const next = await board.read();
  expect(next.revision!.revision).toBeGreaterThan(first.revision!.revision);
  expect(changes).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionsRevision: next.revision!.revision }),
  );
  expect(next.sessions[0]).toMatchObject({ run: "active", columnId: "focus" });
  expect(next.sessions[0]).not.toBe(first.sessions[0]);
  expect(next.sessions.slice(1).every((row, index) => row === first.sessions[index + 1])).toBe(
    true,
  );
  expect(placements).toHaveBeenCalledOnce();
  expect(boards).toHaveBeenCalledOnce();
  expect(await board.read()).toBe(next);
  const pinned = await board.move(facts("1").key, "focus");
  expect(pinned.sessions[1]).toMatchObject({ columnId: "focus", source: "operator" });
  expect(pinned.sessions[1]).not.toBe(next.sessions[1]);
  expect(
    pinned.sessions.filter((_, index) => index !== 1).every((row) => next.sessions.includes(row)),
  ).toBe(true);
  board.state.scope = "new-authorization";
  const rebuilt = await board.read();
  expect(rebuilt.sessions).toEqual(pinned.sessions);
  expect(rebuilt.sessions[0]).not.toBe(pinned.sessions[0]);
  expect(rebuilt.revision!.scope).not.toBe(pinned.revision!.scope);
});

it("keeps each visibility projection within its caller's sessions and people", async () => {
  const board = await createFixture(["shared", "private"]);
  const people: NonNullable<SelectedFacts["people"]> = [
    { identity: { type: "profile", id: "one" }, label: "One", sessionCount: 2 },
  ];
  const visible = { scope: "viewer", sessions: [board.state.sessions[0]!], people: [] };
  board.selectOnce({ scope: "owner", people });
  board.selectOnce(visible);
  const [owner, viewer] = await Promise.all([
    board.read({ includePeople: true }, { assertCurrent() {} }),
    board.read({ includePeople: true }, { assertCurrent() {} }),
  ]);
  expect(owner.sessions.map(({ label }) => label)).toEqual(["shared", "private"]);
  expect(owner.people).toEqual(people);
  expect(viewer.sessions.map(({ label }) => label)).toEqual(["shared"]);
  expect(viewer.people).toEqual([]);
  expect(viewer.revision!.scope).not.toBe(owner.revision!.scope);
  board.selectOnce({ ...visible, revision: "people-changed", people });
  const otherPeople = await board.read({ includePeople: true });
  expect(otherPeople.sessions).toEqual(viewer.sessions);
  expect(otherPeople.people).toEqual(people);
  expect(otherPeople.revision!.scope).not.toBe(viewer.revision!.scope);
});

it.each(["session", "people"] as const)(
  "expires cached %s at the exact activity deadline",
  async (kind) => {
    const board = await createFixture(["one"], {
      spec: { scope: { maxAgeHours: 1 } },
    });
    const deadline = NOW + (kind === "people" ? 1_000 : 3_600_000);
    const person = { identity: { type: "profile" as const, id: "one" }, label: "One" };
    if (kind === "people") {
      board.state.sessions = [];
      board.state.people = [{ ...person, sessionCount: 1 }];
      board.state.activityExpiresAt = deadline;
    }
    const view = { includePeople: true };
    const first = await board.read(view);
    vi.setSystemTime(deadline);
    expect(await board.read(view)).toBe(first);
    vi.setSystemTime(deadline + 1);
    if (kind === "people") {
      board.state.people = [];
      board.state.activityExpiresAt = undefined;
      board.state.revision = "people-expired";
    }
    const expired = await board.read(view);
    expect(expired.sessions).toEqual([]);
    if (kind === "people") {
      expect(first.people).toEqual([{ ...person, sessionCount: 1 }]);
      expect(expired.people).toEqual([]);
    }
    expect(expired.revision!.scope).not.toBe(first.revision!.scope);
  },
);

it("checks authority after the caller's facts selection even with a warm projection", async () => {
  const board = await createFixture(["one"]);
  const first = await board.read();
  let active = true;
  board.selectFacts.mockImplementationOnce(async () => {
    active = false;
    return { ...board.state };
  });
  const caller = authority(() => active);
  await expect(board.read(undefined, caller)).rejects.toThrow("Caller authority expired");
  expect(await board.read()).toBe(first);
});

it.each(["owner", "joiner"] as const)(
  "rejects an expired %s without retiring the other caller's authority",
  async (expired) => {
    const board = await createFixture(["one"]);
    const entered = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = true;
    let joinerSelected = false;
    const caller = (name: "owner" | "joiner") => ({
      assertCurrent() {
        if (!active && name === expired) {
          throw new Error("Caller authority expired");
        }
        if (name === "joiner" && joinerSelected) {
          joined.resolve();
        }
      },
    });
    using placements = vi.spyOn(board.store, "listSessionPlacements");
    placements.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return [];
    });
    const owner = board.read(undefined, caller("owner"));
    await entered.promise;
    board.selectFacts.mockImplementationOnce(async () => {
      joinerSelected = true;
      return { ...board.state };
    });
    const joiner = board.read(undefined, caller("joiner"));
    const rejected = expect(expired === "owner" ? owner : joiner).rejects.toThrow(
      "Caller authority expired",
    );
    await joined.promise;
    active = false;
    release.resolve();
    await rejected;
    const survivor = await (expired === "owner" ? joiner : owner);
    expect(survivor.sessions).toMatchObject([{ key: facts("one").key }]);
    expect((await board.read()).sessions).toEqual(survivor.sessions);
  },
);

it("keeps pins across fact changes and returns to rules when their column is deleted", async () => {
  const board = await createFixture([facts("one", { run: "active" })]);
  const pinned = { columnId: "other", source: "operator" };
  await board.move(facts("one").key, "other");
  expect((await board.read()).sessions[0]).toMatchObject(pinned);
  board.publish("health-changed", [facts("one", { observerDigest: observed("stuck") })]);
  expect((await board.read()).sessions[0]).toMatchObject(pinned);
  await board.update({
    columns: [FOCUS_COLUMN, { ...OTHER_COLUMN, id: "fallback" }],
  });
  expect((await board.read()).sessions[0]).toMatchObject({ columnId: "fallback", source: "state" });
  expect((await board.pins()).every((pin) => pin.source === "operator")).toBe(true);
});

it("shows failure reasons, keeps stale facts, and falls back for unread sessions", async () => {
  const marker = "old-policy-text";
  const known = facts("known", {
    run: "active",
    label: marker,
    derivedTitle: marker,
    lastMessagePreview: marker,
    observerDigest: { health: "on-track", headline: marker, assessment: marker, revision: 1 },
    pullRequests: [{ number: 12, state: "open", title: marker }],
  });
  const board = await createFixture([known]);
  await board.read();
  board.publish(
    "unavailable",
    [facts("known"), facts("new")].map((row) =>
      Object.assign(row, { unavailable: "Error: facts backend offline" }),
    ),
  );
  const read = await board.read();
  expect(read.warning).toContain(
    "Session facts are unavailable for 2 sessions: Error: facts backend offline. Showing the last known placement.",
  );
  expect(read.sessions).toMatchObject([
    { key: facts("known").key, run: "active", columnId: "focus" },
    { key: facts("new").key, columnId: "other", reason: "facts-unavailable" },
  ]);
  expect(read.sessions[0]).toMatchObject(known);
  await board.read();
  expect(board.logger.warn).toHaveBeenCalledOnce();
  board.publish("recovered", [facts("known"), facts("new")], []);
  const recovered = await board.read();
  expect(recovered.warning).toBeUndefined();
  expect(recovered.revision!.revision).toBe(read.revision!.revision);
  expect(recovered.revision!.scope).not.toBe(read.revision!.scope);
  expect(await board.read()).toBe(recovered);
  board.state.missingSessionKeys = [facts("known").key, facts("new").key];
  board.publish("missing-current-facts", [], [facts("known").key]);
  expect((await board.read()).sessions).toEqual([]);
  board.state.missingSessionKeys = undefined;
  board.publish("unavailable-after-missing-facts", [
    { ...facts("known"), unavailable: "second outage" },
    { ...facts("new"), unavailable: "second outage" },
  ]);
  const unavailable = await board.read();
  expect(unavailable.warning).toContain("second outage");
  expect(unavailable.sessions).toMatchObject([
    { key: facts("known").key, columnId: "other", reason: "facts-unavailable" },
    { key: facts("new").key, columnId: "other", reason: "facts-unavailable" },
  ]);
  expect(board.logger.warn).toHaveBeenCalledTimes(2);
});

it("completes during continuous source invalidation without caching a stale revision", async () => {
  const board = await createFixture(["one"]);
  await board.read();
  const admittedRevision = board.store.sessionsRevision;
  let sourceReads = 0;
  board.selectFacts.mockImplementation(async () => {
    if (++sourceReads > 2) {
      throw new Error("Sessions board kept retrying invalidated facts");
    }
    board.emit(facts("one").key);
    return { ...board.state };
  });
  const duringChurn = await board.read();
  expect(sourceReads).toBe(1);
  expect(duringChurn.revision!.revision).toBe(admittedRevision.revision);
  expect(duringChurn.revision!.revision).toBeLessThan(board.store.sessionsRevision.revision);
  board.selectFacts.mockImplementation(async () => ({ ...board.state }));
  const current = await board.read();
  expect(current.revision!.revision).toBe(board.store.sessionsRevision.revision);
  expect(current.revision!.scope).not.toBe(duringChurn.revision!.scope);
  expect(await board.read()).toBe(current);
  board.publish("active", [facts("one", { run: "active" })]);
  expect((await board.read()).sessions[0]).toMatchObject({ columnId: "focus" });
});

it("excludes the Board agent from reads and moves", async () => {
  const own = facts("board-agent");
  const board = await createFixture([own, "one"], {
    spec: { agentSessionKey: own.key },
  });
  expect((await board.read()).sessions.map((session) => session.key)).toEqual([facts("one").key]);
  await expect(board.move(own.key, "other")).rejects.toThrow("not available in this board's scope");
  expect(await board.pins()).toEqual([]);
});

it("forwards people views without changing the board or pins", async () => {
  const board = await createFixture(["one", "two"]);
  await board.read();
  const initialBoard = await board.stored();
  const people: NonNullable<SelectedFacts["people"]> = [
    { identity: { type: "profile", id: "profile-one" }, label: "Alex", sessionCount: 1 },
  ];
  for (const view of [
    { involvingMe: true, includePeople: true },
    { involvingProfileId: "profile-one", includePeople: true },
    { involvingMe: false, includePeople: false },
  ]) {
    board.selectFacts.mockClear();
    board.selectOnce({
      sessions: [board.state.sessions[0]!],
      people: view.includePeople ? people : undefined,
    });
    const read = await board.read(view);
    expect(board.selectFacts).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(view));
    expect(read.sessions.map(({ key }) => key)).toEqual([facts("one").key]);
    expect(read.people).toBe(view.includePeople ? people : undefined);
  }
  expect(await board.stored()).toEqual(initialBoard);
  expect(await board.pins()).toEqual([]);
});
