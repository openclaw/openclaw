import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  WorkboardSessionFacts,
  WorkboardSessionsBoardSpec,
  WorkboardSessionsColumn,
} from "@openclaw/workboard-contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkboardSessionsBoardService } from "./sessions-board.js";
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
const BOARD_ID = "sessions";
const NOW = 10_000_000;
const FOCUS_COLUMN: WorkboardSessionsColumn = {
  id: "focus",
  label: "Focus",
  description: "Active sessions.",
  match: { run: ["active"] },
};
const OTHER_COLUMN: WorkboardSessionsColumn = {
  id: "other",
  label: "Other",
  description: "Remaining sessions.",
  fallback: true,
};
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
async function withService(
  options: Parameters<typeof createFixture>[0],
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
) {
  const fixture = await createFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.service.stop();
    await fixture.store.close();
  }
}
async function createFixture(options: {
  facts: WorkboardSessionFacts[];
  spec?: Partial<WorkboardSessionsBoardSpec>;
}) {
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
  const state = { facts: options.facts, roster: options.facts };
  const request = vi
    .fn()
    .mockImplementation(async () => ({ sessions: state.roster, hasMore: false }));
  const readSessionFacts = vi
    .fn<ServiceParams["gateway"]["readSessionFacts"]>()
    .mockImplementation(async ({ sessionKeys }) => ({
      sessions: state.facts.filter((session) => sessionKeys.includes(session.key)),
    }));
  let listener: Parameters<ServiceParams["gateway"]["subscribeSessionChanges"]>[0] | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const gateway = {
    request,
    readSessionFacts,
    subscribeSessionChanges: (callback: NonNullable<typeof listener>) => {
      listener = callback;
      return unsubscribe;
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = createWorkboardSessionsBoardService({ store, gateway });
  const context = { config: {}, stateDir: "unused", logger };
  const repair = vi.spyOn(store, "repairSessionPlacements");
  await service.start(context);
  return {
    store,
    stores,
    state,
    request,
    readSessionFacts,
    logger,
    service,
    unsubscribe,
    repair,
    context,
    emit: (key: string) => listener?.({ agentId: "main", sessionKey: key }),
  };
}

describe("Sessions board rules and live facts", () => {
  it("rejects a move when caller authority ends during the facts read", async () => {
    await withService({ facts: [facts("one")] }, async ({ service, store, readSessionFacts }) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let active = true;
      readSessionFacts.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { sessions: [facts("one")] };
      });
      const pending = service.move(BOARD_ID, facts("one").key, "other", {
        assertCurrent() {
          if (!active) {
            throw new Error("Caller authority is no longer active.");
          }
        },
      });
      const rejected = expect(pending).rejects.toThrow("Caller authority is no longer active.");
      await entered.promise;
      active = false;
      release.resolve();
      await rejected;
      expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
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
      },
      async ({ service, request, store }) => {
        const result = await service.read(BOARD_ID);
        expect(
          result.sessions.map(({ label, columnId, source }) => ({ label, columnId, source })),
        ).toEqual([
          { label: "all", columnId: "review", source: "state" },
          { label: "no-digest", columnId: "active", source: "state" },
          { label: "active-no-pr", columnId: "active", source: "state" },
          { label: "archived", columnId: "active", source: "state" },
          { label: "idle-pr", columnId: "other", source: "state" },
          { label: "none", columnId: "no-pr", source: "state" },
          { label: "unknown", columnId: "other", source: "state" },
        ]);
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
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

  it("shares cached facts across boards, invalidates only changed keys, and coalesces notifications", async () => {
    await withService(
      { facts: [facts("one"), facts("two")] },
      async ({ service, store, state, emit, readSessionFacts, unsubscribe }) => {
        const changed = vi.spyOn(store, "announceChangeEpoch");
        expect(readSessionFacts).not.toHaveBeenCalled();
        emit(facts("one").key);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(changed).not.toHaveBeenCalled();
        await service.read(BOARD_ID);
        await store.upsertBoard({ id: "second", kind: "sessions" });
        await service.read("second");
        expect(readSessionFacts).toHaveBeenCalledOnce();
        changed.mockClear();
        state.facts = [facts("one", { run: "active" }), facts("two")];
        emit(facts("one").key);
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({ columnId: "focus" });
        state.facts = [
          facts("one", { run: "active", label: "Updated during burst" }),
          facts("two"),
        ];
        for (let event = 1; event < 100; event += 1) {
          await vi.advanceTimersByTimeAsync(40);
          emit(event === 99 ? "agent:main:not-cached" : facts("one").key);
        }
        await vi.advanceTimersByTimeAsync(1_039);
        expect(changed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(changed).toHaveBeenCalledOnce();
        const read = await service.read(BOARD_ID);
        expect(readSessionFacts.mock.calls.map(([input]) => input.sessionKeys)).toEqual([
          [facts("one").key, facts("two").key],
          [facts("one").key],
          [facts("one").key],
        ]);
        expect(read.sessions[0]).toMatchObject({
          columnId: "focus",
          label: "Updated during burst",
        });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(changed).toHaveBeenCalledOnce();
        emit(facts("two").key);
        await service.stop();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(changed).toHaveBeenCalledOnce();
      },
    );
  });

  it("announces new sessions on an empty board and retries unavailable PR facts after one minute", async () => {
    await withService({ facts: [] }, async ({ service, store, state, emit, readSessionFacts }) => {
      expect((await service.read(BOARD_ID)).sessions).toEqual([]);
      const changed = vi.spyOn(store, "announceChangeEpoch");
      state.roster = state.facts = [facts("new", { pullRequestsUnavailable: true })];
      emit(facts("new").key);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changed).toHaveBeenCalledOnce();
      expect((await service.read(BOARD_ID)).warning).toContain(
        "pull-request information is unavailable",
      );
      const readAt = Date.now();
      state.facts = [facts("new", { pullRequests: [{ number: 1, state: "open" }] })];
      expect((await service.read(BOARD_ID)).warning).toContain(
        "pull-request information is unavailable",
      );
      vi.setSystemTime(readAt + 59_999);
      await service.read(BOARD_ID);
      expect(readSessionFacts).toHaveBeenCalledOnce();
      vi.setSystemTime(readAt + 60_000);
      expect((await service.read(BOARD_ID)).warning).toBeUndefined();
      expect(readSessionFacts).toHaveBeenCalledTimes(2);
    });
  });

  it("refetches stale facts on demand in batches of 40", async () => {
    await withService(
      { facts: Array.from({ length: 81 }, (_, index) => facts(String(index))) },
      async ({ service, readSessionFacts }) => {
        await service.read(BOARD_ID);
        expect(readSessionFacts.mock.calls.map(([input]) => input.sessionKeys.length)).toEqual([
          40, 40, 1,
        ]);
        vi.setSystemTime(NOW + 10 * 60_000 - 1);
        await service.read(BOARD_ID);
        expect(readSessionFacts).toHaveBeenCalledTimes(3);
        vi.setSystemTime(NOW + 10 * 60_000);
        await service.read(BOARD_ID);
        expect(readSessionFacts.mock.calls.map(([input]) => input.sessionKeys.length)).toEqual([
          40, 40, 1, 40, 40, 1,
        ]);
      },
    );
  });

  it("keeps pins across fact changes and returns to rules when their column is deleted", async () => {
    await withService(
      { facts: [facts("one", { run: "active" })] },
      async ({ service, store, state, emit }) => {
        await service.move(BOARD_ID, facts("one").key, "other");
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({
          columnId: "other",
          source: "operator",
        });
        state.facts = [
          facts("one", { observerDigest: { health: "stuck", headline: "Stuck", revision: 1 } }),
        ];
        emit(facts("one").key);
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({
          columnId: "other",
          source: "operator",
        });
        await service.update(BOARD_ID, {
          columns: [FOCUS_COLUMN, { ...OTHER_COLUMN, id: "fallback" }],
        });
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({
          columnId: "fallback",
          source: "state",
        });
        expect(
          (await store.listSessionPlacements(BOARD_ID)).every((pin) => pin.source === "operator"),
        ).toBe(true);
      },
    );
  });

  it("shows failure reasons, keeps stale facts, and falls back for unread sessions", async () => {
    await withService(
      { facts: [facts("known", { run: "active" })] },
      async ({ service, state, emit, readSessionFacts, logger }) => {
        await service.read(BOARD_ID);
        state.roster = [...state.roster, facts("new")];
        emit(facts("known").key);
        readSessionFacts.mockRejectedValue(new Error("facts backend offline"));
        const read = await service.read(BOARD_ID);
        expect(read.warning).toContain(
          "Session facts are unavailable for 2 sessions: Error: facts backend offline. Showing the last known placement.",
        );
        expect(read.sessions).toMatchObject([
          { key: facts("known").key, run: "active", columnId: "focus" },
          { key: facts("new").key, columnId: "other", reason: "facts-unavailable" },
        ]);
        await service.read(BOARD_ID);
        expect(logger.warn).toHaveBeenCalledOnce();
        readSessionFacts.mockResolvedValue({ sessions: state.roster });
        expect((await service.read(BOARD_ID)).warning).toBeUndefined();
        emit(facts("known").key);
        readSessionFacts.mockRejectedValue(new Error("second outage"));
        expect((await service.read(BOARD_ID)).warning).toContain("second outage");
        expect(logger.warn).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("does not let an in-flight read overwrite a newer invalidation", async () => {
    await withService({ facts: [facts("one")] }, async ({ service, emit, readSessionFacts }) => {
      await service.read(BOARD_ID);
      emit(facts("one").key);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      readSessionFacts.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { sessions: [facts("one")] };
      });
      const pending = service.read(BOARD_ID);
      await entered.promise;
      emit(facts("one").key);
      release.resolve();
      await pending;
      readSessionFacts.mockResolvedValue({ sessions: [facts("one", { run: "active" })] });
      expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({ columnId: "focus" });
      expect(readSessionFacts).toHaveBeenCalledTimes(3);
    });
  });

  it("intersects each caller roster with current identities and excludes the Board agent", async () => {
    const own = facts("board-agent");
    await withService(
      { facts: [own, facts("one"), facts("hidden")], spec: { agentSessionKey: own.key } },
      async ({ service, state }) => {
        expect((await service.read(BOARD_ID)).sessions.map((session) => session.key)).toEqual([
          facts("one").key,
          facts("hidden").key,
        ]);
        state.roster = [facts("one", { sessionId: "replacement" })];
        expect((await service.read(BOARD_ID)).sessions).toEqual([]);
        state.facts = state.roster;
        expect((await service.read(BOARD_ID)).sessions).toMatchObject([
          { sessionId: "replacement" },
        ]);
        state.roster = [own];
        await expect(service.move(BOARD_ID, own.key, "other")).rejects.toThrow(
          "not available in this board's scope",
        );
      },
    );
  });

  it("forwards people views without changing the board or pins", async () => {
    await withService(
      { facts: [facts("one"), facts("two")] },
      async ({ service, store, request }) => {
        await service.read(BOARD_ID);
        const board = await store.getSessionsBoard(BOARD_ID);
        const people = [
          { identity: { type: "profile", id: "profile-one" }, label: "Alex", sessionCount: 1 },
        ];
        for (const view of [
          { involvingMe: true, includePeople: true },
          { involvingProfileId: "profile-one", includePeople: true },
          { involvingMe: false, includePeople: false },
        ]) {
          request.mockClear();
          request.mockResolvedValueOnce({ sessions: [facts("one")], people, hasMore: false });
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
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
      },
    );
  });

  it("repairs placements once at startup and stays idle until read", async () => {
    await withService(
      { facts: [] },
      async ({ service, repair, readSessionFacts, context, logger }) => {
        expect(repair).toHaveBeenCalledOnce();
        await service.read(BOARD_ID);
        await service.read(BOARD_ID);
        expect(repair).toHaveBeenCalledOnce();
        expect(readSessionFacts).not.toHaveBeenCalled();
        await service.stop();
        repair.mockResolvedValueOnce(3);
        await service.start(context);
        expect(logger.info).toHaveBeenCalledExactlyOnceWith(
          "Sessions board removed 3 non-operator placements.",
        );
      },
    );
  });
});
