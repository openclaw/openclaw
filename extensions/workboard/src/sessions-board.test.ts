import type {
  WorkboardSessionFacts,
  WorkboardSessionsBoardSpec,
  WorkboardSessionsColumn,
} from "@openclaw/workboard-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkboardSessionsBoardService } from "./sessions-board.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

type ServiceParams = Parameters<typeof createWorkboardSessionsBoardService>[0];
type Completion = NonNullable<ServiceParams["complete"]>;
const BOARD_ID = "sessions";
const NOW = 10_000_000;
const FOCUS_COLUMN: WorkboardSessionsColumn = {
  id: "focus",
  label: "Focus",
  description: "Sessions requiring attention.",
};
const OTHER_COLUMN: WorkboardSessionsColumn = {
  id: "other",
  label: "Other",
  description: "Remaining sessions.",
  fallback: true,
};
const MODEL_COLUMNS = [FOCUS_COLUMN, OTHER_COLUMN];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function facts(id: string, overrides: Partial<WorkboardSessionFacts> = {}): WorkboardSessionFacts {
  return {
    key: `agent:main:${id}`,
    sessionId: `session-${id}`,
    agentId: "main",
    label: id,
    run: "idle",
    pullRequests: [],
    archived: false,
    lastActivityAt: NOW,
    ...overrides,
  };
}

function placements(sessions: readonly WorkboardSessionFacts[], columnId = "focus") {
  return JSON.stringify({
    placements: sessions.map((session) => ({
      sessionKey: session.key,
      columnId,
      reason: "Needs attention",
    })),
  });
}

async function withService(
  options: {
    facts: WorkboardSessionFacts[];
    spec?: Partial<WorkboardSessionsBoardSpec>;
    complete?: Completion;
  },
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const fixture = await createFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.service.stop();
  }
}

async function createFixture(options: {
  facts: WorkboardSessionFacts[];
  spec?: Partial<WorkboardSessionsBoardSpec>;
  complete?: Completion;
}) {
  const { store, stores } = createWorkboardSqliteTestHarness();
  await store.upsertBoard({ id: BOARD_ID, kind: "sessions" });
  await store.updateSessionsBoard(BOARD_ID, { columns: MODEL_COLUMNS, ...options.spec });
  const state = {
    facts: options.facts,
    roster: options.facts.map(({ key, sessionId }) => ({ key, sessionId })),
  };
  const request = vi.fn().mockImplementation(async () => ({
    sessions: state.roster,
    hasMore: false,
  }));
  const readSessionFacts = vi
    .fn<ServiceParams["gateway"]["readSessionFacts"]>()
    .mockImplementation(async ({ sessionKeys }) => ({
      sessions: state.facts.filter((session) => sessionKeys.includes(session.key)),
    }));
  const complete = vi.fn<Completion>(
    options.complete ?? (async ({ sessions }) => placements(sessions)),
  );
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = createWorkboardSessionsBoardService({
    store,
    gateway: { request, readSessionFacts, isAvailable: async () => true },
    getConfig: () => ({ agents: { entries: { main: {} } } }),
    complete,
  });
  await service.start({ config: {}, stateDir: "unused", logger });
  return { store, stores, state, request, readSessionFacts, complete, logger, service };
}

describe("Sessions board classification service", () => {
  it.each(["update", "move"] as const)(
    "rejects %s when caller authority ends while persistence is pending",
    async (action) => {
      await withService({ facts: [facts("one")] }, async ({ service, store, stores }) => {
        await service.sweep();
        const board = await store.getSessionsBoard(BOARD_ID);
        const previous = await store.listSessionPlacements(BOARD_ID);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let active = true;
        const caller = {
          assertCurrent() {
            if (!active) {
              throw new Error("Caller authority is no longer active.");
            }
          },
        };
        const pause = async () => {
          entered.resolve();
          await release.promise;
        };
        const update = stores.sessionsBoard.update.bind(stores.sessionsBoard);
        const write = stores.sessionsBoard.writePlacements.bind(stores.sessionsBoard);
        using updateSpy = vi.spyOn(stores.sessionsBoard, "update");
        updateSpy.mockImplementation(async (...args) => {
          await pause();
          return update(...args);
        });
        using writeSpy = vi.spyOn(stores.sessionsBoard, "writePlacements");
        writeSpy.mockImplementation(async (...args) => {
          await pause();
          return write(...args);
        });
        const pending =
          action === "update"
            ? service.update(BOARD_ID, { instructions: "Revoked edit" }, caller)
            : service.move(BOARD_ID, facts("one").key, "other", caller);
        const rejected = expect(pending).rejects.toThrow("Caller authority is no longer active.");
        try {
          await entered.promise;
          active = false;
        } finally {
          release.resolve();
        }
        await rejected;
        expect(await store.getSessionsBoard(BOARD_ID)).toEqual(board);
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual(previous);
      });
    },
  );

  it("rejects a revoked refresh before scheduling classification", async () => {
    await withService({ facts: [facts("one")] }, async ({ service, readSessionFacts }) => {
      await expect(
        service.refresh(BOARD_ID, {
          assertCurrent() {
            throw new Error("Caller authority is no longer active.");
          },
        }),
      ).rejects.toThrow("Caller authority is no longer active.");
      await service.stop();
      expect(readSessionFacts).not.toHaveBeenCalled();
    });
  });

  it("takes the first full rule match and distinguishes unknown PR state from confirmed none", async () => {
    const digest = { health: "on-track", headline: "Making progress", revision: 1 } as const;
    await withService(
      {
        spec: {
          scope: { includeArchived: true },
          columns: [
            {
              id: "review",
              label: "Review",
              description: "Active reviewed work.",
              match: {
                health: ["on-track"],
                run: ["active"],
                pullRequest: ["open"],
                archived: false,
              },
            },
            {
              id: "active",
              label: "Active",
              description: "All active work.",
              match: { run: ["active"] },
            },
            {
              id: "no-pr",
              label: "No PR",
              description: "Confirmed no pull request.",
              match: { pullRequest: ["none"] },
            },
            OTHER_COLUMN,
          ],
        },
        facts: [
          facts("all", {
            run: "active",
            observerDigest: digest,
            pullRequests: [{ number: 1, state: "open" }],
          }),
          facts("no-digest", { run: "active", pullRequests: [{ number: 2, state: "open" }] }),
          facts("active-no-pr", { run: "active", observerDigest: digest }),
          facts("archived", {
            run: "active",
            observerDigest: digest,
            archived: true,
            pullRequests: [{ number: 3, state: "open" }],
          }),
          facts("idle-pr", {
            observerDigest: digest,
            pullRequests: [{ number: 4, state: "open" }],
          }),
          facts("none"),
          facts("unknown", { pullRequestsUnavailable: true }),
        ],
        complete: async () => '{"placements":[]}',
      },
      async ({ service, complete, request }) => {
        await service.sweep();
        const result = await service.read(BOARD_ID);
        expect(
          result.sessions.map(({ label, columnId, source }) => ({ label, columnId, source })),
        ).toEqual([
          { label: "all", columnId: "review", source: "state" },
          { label: "no-digest", columnId: "active", source: "state" },
          { label: "active-no-pr", columnId: "active", source: "state" },
          { label: "archived", columnId: "active", source: "state" },
          { label: "idle-pr", columnId: "other", source: "model" },
          { label: "none", columnId: "no-pr", source: "state" },
          { label: "unknown", columnId: "other", source: "model" },
        ]);
        expect(complete.mock.calls[0]?.[0].sessions.map((session) => session.label)).toEqual([
          "idle-pr",
          "unknown",
        ]);
        expect(result.warning).toContain("pull-request information is unavailable");
        expect(request).toHaveBeenCalledWith(
          "sessions.list",
          expect.objectContaining({
            configuredAgentsOnly: true,
            includeGlobal: false,
            includeUnknown: false,
          }),
          { scopes: ["operator.read"] },
        );
      },
    );
  });

  it("keeps unviewed boards quiet during background sweeps and ignores activity ticks", async () => {
    await withService(
      {
        facts: [
          facts("one", { observerDigest: { health: "stuck", headline: "Stuck", revision: 1 } }),
        ],
      },
      async ({ service, state, request, readSessionFacts, complete, store }) => {
        await service.sweep({ viewedWithinMs: 60_000 });
        expect(request).not.toHaveBeenCalled();
        expect(readSessionFacts).not.toHaveBeenCalled();
        await service.read(BOARD_ID);
        await service.sweep({ viewedWithinMs: 60_000 });
        expect(readSessionFacts).toHaveBeenCalled();
        const classified = await store.listSessionPlacements(BOARD_ID);
        expect(classified).toHaveLength(1);
        state.facts = [facts("one", { ...state.facts[0], lastActivityAt: NOW + 5_000 })];
        vi.setSystemTime(NOW + 30_000);
        await service.sweep({ viewedWithinMs: 60_000 });
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual(classified);
        expect(complete).toHaveBeenCalledOnce();
        vi.setSystemTime(NOW + 120_000);
        readSessionFacts.mockClear();
        await service.sweep({ viewedWithinMs: 60_000 });
        expect(readSessionFacts).not.toHaveBeenCalled();
      },
    );
  });

  it("fits model output into eight-session batches spaced at least 30 seconds apart", async () => {
    const callTimes: number[] = [];
    await withService(
      {
        facts: Array.from({ length: 41 }, (_, index) => facts(String(index))),
        complete: async ({ sessions }) => {
          callTimes.push(Date.now());
          return placements(sessions);
        },
      },
      async ({ service, complete, store, readSessionFacts }) => {
        await service.sweep();
        expect(complete.mock.calls.map(([input]) => input.sessions.length)).toEqual([8]);
        expect(readSessionFacts.mock.calls.map(([input]) => input.sessionKeys.length)).toEqual([
          40, 1,
        ]);
        expect(
          (await store.listSessionPlacements(BOARD_ID)).filter((entry) => entry.source === "model"),
        ).toHaveLength(8);
        for (let expectedCalls = 2; expectedCalls <= 6; expectedCalls += 1) {
          await vi.advanceTimersByTimeAsync(29_999);
          await service.sweep();
          expect(complete).toHaveBeenCalledTimes(expectedCalls - 1);
          await vi.advanceTimersByTimeAsync(1);
          await service.sweep();
          expect(complete).toHaveBeenCalledTimes(expectedCalls);
        }
        expect(complete.mock.calls.map(([input]) => input.sessions.length)).toEqual([
          8, 8, 8, 8, 8, 1,
        ]);
        expect(callTimes).toEqual(Array.from({ length: 6 }, (_, index) => NOW + index * 30_000));
        expect((await service.read(BOARD_ID)).sessions).toHaveLength(41);
        const classified = await store.listSessionPlacements(BOARD_ID);
        expect(classified).toHaveLength(41);
        expect(classified.every((entry) => entry.source === "model")).toBe(true);
        await vi.advanceTimersByTimeAsync(30_000);
        await service.sweep();
        expect(complete).toHaveBeenCalledTimes(6);
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual(classified);
      },
    );
  });

  it("classifies queued sessions even when earlier sessions keep changing", async () => {
    await withService(
      { facts: Array.from({ length: 9 }, (_, index) => facts(String(index))) },
      async ({ service, state, complete }) => {
        await service.sweep();
        expect(complete.mock.calls[0]?.[0].sessions.map((session) => session.key)).toEqual(
          Array.from({ length: 8 }, (_, index) => facts(String(index)).key),
        );
        const changedFacts = structuredClone(state.facts);
        for (const session of changedFacts.slice(0, 8)) {
          session.lastMessagePreview = "New activity";
        }
        state.facts = changedFacts;
        await vi.advanceTimersByTimeAsync(29_999);
        await service.sweep();
        expect(complete).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        await service.sweep();
        expect(complete).toHaveBeenCalledTimes(2);
        expect(complete.mock.calls[1]?.[0].sessions.map((session) => session.key)).toContain(
          facts("8").key,
        );
        expect(
          (await service.read(BOARD_ID)).sessions.find((session) => session.key === facts("8").key),
        ).toMatchObject({ source: "model" });
      },
    );
  });

  it("keeps the board's own agent conversation off the board", async () => {
    const own = facts("board-agent");
    await withService(
      { facts: [own, facts("one")], spec: { agentSessionKey: own.key } },
      async ({ service, store, complete }) => {
        await service.sweep();
        expect(
          (await store.listSessionPlacements(BOARD_ID)).map((entry) => entry.sessionKey),
        ).toEqual([facts("one").key]);
        expect(complete).toHaveBeenCalledOnce();
        expect((await service.read(BOARD_ID)).sessions.map((session) => session.key)).toEqual([
          facts("one").key,
        ]);
        await expect(service.move(BOARD_ID, own.key, "other")).rejects.toThrow(
          "not available in this board's scope",
        );
      },
    );
  });

  it("accepts utility-model JSON wrapped in a markdown code fence", async () => {
    await withService(
      {
        facts: [facts("one")],
        complete: async ({ sessions }) => "```json\n" + placements(sessions) + "\n```",
      },
      async ({ service, store, logger }) => {
        await service.sweep();
        expect((await store.listSessionPlacements(BOARD_ID))[0]).toMatchObject({
          columnId: "focus",
          source: "model",
        });
        expect(logger.warn).not.toHaveBeenCalled();
      },
    );
  });

  it("uses fallback for unknown or missing model column IDs and omitted sessions", async () => {
    const sessions = [
      facts("valid"),
      facts("unknown"),
      facts("missing-column"),
      facts("omitted"),
    ] as const;
    await withService(
      {
        facts: [...sessions],
        complete: async () =>
          JSON.stringify({
            placements: [
              { sessionKey: sessions[0].key, columnId: "focus", reason: "Attention" },
              { sessionKey: sessions[1].key, columnId: "invented", reason: "Invalid" },
              { sessionKey: sessions[2].key, reason: "Missing" },
              { sessionKey: "agent:main:outside", columnId: "focus", reason: "Not in batch" },
            ],
          }),
      },
      async ({ service, store }) => {
        await service.sweep();
        const result = await service.read(BOARD_ID);
        expect(
          result.sessions.map(({ columnId, source, reason }) => ({ columnId, source, reason })),
        ).toEqual([
          { columnId: "focus", source: "model", reason: "Attention" },
          ...Array.from({ length: 3 }, () => ({
            columnId: "other",
            source: "model",
            reason: "unresolved",
          })),
        ]);
        expect(await store.listSessionPlacements(BOARD_ID)).toHaveLength(4);
      },
    );
  });

  it("retains previous placements on model failure and logs once until recovery", async () => {
    await withService(
      { facts: [facts("one")] },
      async ({ service, state, store, complete, logger }) => {
        await service.sweep();
        const previous = await store.listSessionPlacements(BOARD_ID);
        state.facts = [facts("one", { lastMessagePreview: "New question?" })];
        complete.mockRejectedValue(new Error("provider unavailable"));
        vi.setSystemTime(NOW + 30_000);
        await service.sweep();
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual(previous);
        expect((await service.read(BOARD_ID)).warning).toContain(
          "Previous placements are retained",
        );
        vi.setSystemTime(NOW + 60_000);
        await service.sweep();
        expect(logger.warn).toHaveBeenCalledOnce();
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual(previous);

        complete.mockImplementation(async ({ sessions }) => placements(sessions, "other"));
        vi.setSystemTime(NOW + 90_000);
        await service.sweep();
        expect((await service.read(BOARD_ID)).warning).toBeUndefined();
        expect((await store.listSessionPlacements(BOARD_ID))[0]).toMatchObject({
          columnId: "other",
          source: "model",
        });
        state.facts = [facts("one", { lastMessagePreview: "Another question?" })];
        complete.mockRejectedValue(new Error("provider unavailable again"));
        vi.setSystemTime(NOW + 120_000);
        await service.sweep();
        expect(logger.warn).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("skips stable facts, preserves operator pins, and retires pins when facts change", async () => {
    await withService({ facts: [facts("one")] }, async ({ service, state, store, complete }) => {
      await service.sweep();
      const classified = await store.listSessionPlacements(BOARD_ID);
      await service.sweep();
      expect(await store.listSessionPlacements(BOARD_ID)).toEqual(classified);
      expect(complete).toHaveBeenCalledOnce();
      await service.move(BOARD_ID, facts("one").key, "other");
      const pinned = await store.listSessionPlacements(BOARD_ID);
      expect(pinned[0]).toMatchObject({ columnId: "other", source: "operator" });
      await service.sweep();
      expect(await store.listSessionPlacements(BOARD_ID)).toEqual(pinned);
      expect(complete).toHaveBeenCalledOnce();

      state.facts = [
        facts("one", {
          observerDigest: { health: "waiting-on-user", headline: "Needs approval", revision: 2 },
        }),
      ];
      complete.mockRejectedValueOnce(new Error("utility temporarily unavailable"));
      vi.setSystemTime(NOW + 30_000);
      await service.sweep();
      expect((await store.listSessionPlacements(BOARD_ID))[0]).toMatchObject({
        columnId: "other",
        source: "state",
        reason: "unresolved",
      });
      vi.setSystemTime(NOW + 60_000);
      await service.sweep();
      expect((await store.listSessionPlacements(BOARD_ID))[0]).toMatchObject({
        columnId: "focus",
        source: "model",
      });
      expect(complete).toHaveBeenCalledTimes(3);
    });
  });

  it("reclassifies changed specs and lets instructions override deterministic rules", async () => {
    const columns: WorkboardSessionsColumn[] = [
      { id: "focus", label: "Focus", description: "Active work.", match: { run: ["active"] } },
      OTHER_COLUMN,
    ];
    await withService(
      {
        facts: [facts("one", { run: "active" })],
        spec: { columns },
        complete: async ({ sessions }) => placements(sessions, "other"),
      },
      async ({ service, store, complete }) => {
        await service.sweep();
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({
          columnId: "focus",
          source: "state",
        });
        expect(complete).not.toHaveBeenCalled();
        await service.update(BOARD_ID, { instructions: "Place active sessions in Other." });
        await service.sweep();
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({
          columnId: "other",
          source: "model",
        });
        expect(complete).toHaveBeenCalledOnce();
        vi.setSystemTime(NOW + 30_000);
        const changedColumns = structuredClone(columns);
        for (const column of changedColumns) {
          column.description += " Updated.";
        }
        await store.updateSessionsBoard(BOARD_ID, {
          columns: changedColumns,
        });
        await service.sweep();
        expect(complete).toHaveBeenCalledTimes(2);
        await service.sweep();
        expect(complete).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("returns cached placements while the model is still pending", async () => {
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<string>();
    await withService(
      {
        facts: [facts("one")],
        complete: async () => {
          entered.resolve();
          return await answer.promise;
        },
      },
      async ({ service }) => {
        const pending = service.sweep();
        try {
          await entered.promise;
          const cached = await service.read(BOARD_ID);
          expect(cached.sessions[0]).toMatchObject({ columnId: "other", reason: "unresolved" });
        } finally {
          answer.resolve(placements([facts("one")]));
          await pending;
        }
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({
          columnId: "focus",
          source: "model",
        });
      },
    );
  });

  it("filters cached facts against the caller's current roster and reused session identities", async () => {
    await withService(
      {
        facts: [facts("one", { run: "active" }), facts("hidden", { run: "active" })],
        spec: { columns: [{ ...FOCUS_COLUMN, match: { run: ["active"] } }, OTHER_COLUMN] },
      },
      async ({ service, state }) => {
        await service.sweep();
        await service.move(BOARD_ID, facts("one").key, "other");
        state.roster = state.roster.filter(({ key }) => key === facts("one").key);
        expect((await service.read(BOARD_ID)).sessions.map((session) => session.label)).toEqual([
          "one",
        ]);
        state.roster = [{ key: facts("one").key, sessionId: "replacement" }];
        expect((await service.read(BOARD_ID)).sessions).toEqual([]);
        state.facts = [facts("one", { run: "active", sessionId: "replacement" })];
        await service.sweep();
        expect((await service.read(BOARD_ID)).sessions).toMatchObject([
          { sessionId: "replacement", columnId: "focus", source: "state" },
        ]);
      },
    );
  });

  it("forwards people views only for reads and intersects the filtered roster with classified sessions", async () => {
    await withService(
      { facts: [facts("one"), facts("two")] },
      async ({ service, store, request }) => {
        await service.sweep();
        const board = await store.getSessionsBoard(BOARD_ID);
        const classified = await store.listSessionPlacements(BOARD_ID);
        const people = [
          { identity: { type: "profile", id: "profile-one" }, label: "Alex", sessionCount: 1 },
        ];
        for (const view of [
          { involvingMe: true, includePeople: true },
          { involvingProfileId: "profile-one", includePeople: true },
          { involvingMe: false, includePeople: false },
        ]) {
          request.mockClear();
          request.mockResolvedValueOnce({
            sessions: [facts("one"), facts("unclassified")],
            people,
            hasMore: false,
          });
          const read = await service.read(BOARD_ID, view);
          expect(request).toHaveBeenCalledExactlyOnceWith(
            "sessions.list",
            expect.objectContaining(view),
            { scopes: ["operator.read"] },
          );
          expect(read.sessions.map(({ key }) => key)).toEqual([facts("one").key]);
          expect(read.people).toBe(view.includePeople ? people : undefined);
        }
        expect(await store.getSessionsBoard(BOARD_ID)).toEqual(board);
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual(classified);

        request.mockClear();
        await service.sweep();
        await service.move(BOARD_ID, facts("two").key, "other");
        expect(request).toHaveBeenCalled();
        for (const [, input] of request.mock.calls) {
          expect(input).not.toHaveProperty("involvingMe");
          expect(input).not.toHaveProperty("involvingProfileId");
          expect(input).not.toHaveProperty("includePeople");
        }
        expect((await service.read(BOARD_ID)).sessions).toMatchObject([
          { key: facts("one").key, columnId: "focus" },
          { key: facts("two").key, columnId: "other", source: "operator" },
        ]);
      },
    );
  });

  it("fences pending model writes and drains the operation when the service stops", async () => {
    const entered = Promise.withResolvers<Parameters<Completion>[0]>();
    const answer = Promise.withResolvers<string>();
    await withService(
      {
        facts: [facts("one")],
        complete: async (input) => {
          entered.resolve(input);
          return await answer.promise;
        },
      },
      async ({ service, store }) => {
        const pending = service.sweep();
        const input = await entered.promise;
        const previous = await store.listSessionPlacements(BOARD_ID);
        const stopped = service.stop();
        try {
          expect(input.signal.aborted).toBe(true);
        } finally {
          answer.resolve(placements(input.sessions));
          await Promise.all([pending, stopped]);
        }
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual(previous);
        expect(() => service.read(BOARD_ID)).toThrow("service is unavailable");
      },
    );
  });
});
