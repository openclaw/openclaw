import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDefaultWorkboardSessionsBoardSpec,
  type WorkboardSessionFacts,
  type WorkboardSessionsBoardSpec,
} from "@openclaw/workboard-contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
afterEach(() => vi.useRealTimers());
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
  const state: SelectedFacts = {
    scope: "shared-scope",
    revision: "initial",
    redactionRevision: "initial-policy",
    sessions: options.facts,
  };
  const selectSessionFacts = vi
    .fn<(selection: FactsSelection) => Promise<SelectedFacts>>()
    .mockImplementation(async () => ({ ...state }));
  const readSessionFacts = vi
    .fn<ServiceParams["gateway"]["readSessionFacts"]>()
    .mockImplementation(async ({ sessionKeys }) => ({
      sessions: state.sessions.filter((session) => sessionKeys.includes(session.key)),
    }));
  let listener: Parameters<ServiceParams["gateway"]["subscribeSessionChanges"]>[0] | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const gateway = {
    readSessionFacts,
    withSessionFacts: async <T>(
      select: FactsSelection,
      run: (snapshot: SelectedFacts) => Promise<T>,
    ): Promise<T> => run(await selectSessionFacts(select)),
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
    selectSessionFacts,
    readSessionFacts,
    logger,
    service,
    unsubscribe,
    repair,
    context,
    emit: (key: string, factsInvalidated?: string) =>
      listener?.({ agentId: "main", sessionKey: key, factsInvalidated }),
  };
}

describe("Sessions board rules and live facts", () => {
  it("always excludes dock conversations and filters automation unless the scope opts in", async () => {
    await withService({ facts: [] }, async ({ service, selectSessionFacts, store }) => {
      await service.read(BOARD_ID);
      expect(selectSessionFacts.mock.calls[0]?.[0]).toMatchObject({
        excludeCron: true,
        excludeSystem: true,
        excludeDock: true,
      });
      expect(selectSessionFacts.mock.calls[0]?.[0]).not.toHaveProperty("excludeSubagents");
      await expect(service.move(BOARD_ID, "agent:main:cron:job:trigger", "other")).rejects.toThrow(
        "not available in this board's scope",
      );
      expect(selectSessionFacts.mock.lastCall?.[0]).toMatchObject({
        excludeCron: true,
        excludeSystem: true,
      });
      expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
      await service.update(BOARD_ID, { scope: { includeAutomation: true } });
      await service.read(BOARD_ID);
      expect(selectSessionFacts.mock.lastCall?.[0]).toHaveProperty("excludeDock", true);
      expect(selectSessionFacts.mock.lastCall?.[0]).not.toHaveProperty("excludeCron");
      expect(selectSessionFacts.mock.lastCall?.[0]).not.toHaveProperty("excludeSystem");
      expect(selectSessionFacts.mock.lastCall?.[0]).not.toHaveProperty("excludeSubagents");
    });
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
      await withService(
        { facts: [home, otherHome, work] },
        async ({ service, readSessionFacts, store }) => {
          expect((await service.read(BOARD_ID)).sessions.map(({ key }) => key)).toEqual([work.key]);
          expect(readSessionFacts).not.toHaveBeenCalled();
          await expect(service.move(BOARD_ID, home.key, "other")).rejects.toThrow(
            "not available in this board's scope",
          );
          expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
          await service.update(BOARD_ID, { scope: { includeHome: true } });
          expect((await service.read(BOARD_ID)).sessions.map(({ key }) => key)).toEqual([
            home.key,
            otherHome.key,
            work.key,
          ]);
          await service.move(BOARD_ID, home.key, "focus");
          await service.update(BOARD_ID, { scope: { includeHome: false } });
          expect((await service.read(BOARD_ID)).sessions.map(({ key }) => key)).toEqual([work.key]);
        },
      );
    },
  );

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

  const digest = { health: "on-track", headline: "Making progress", revision: 1 } as const;
  it.each([
    {
      name: "custom rules with conjunctions, alternatives, and unknown PR state",
      spec: {
        scope: { includeArchived: true },
        columns: [
          {
            id: "review",
            label: "Review",
            description: "Active reviewed work.",
            match: [
              {
                health: ["on-track"],
                run: ["active"],
                pullRequest: ["open"],
                archived: false,
              },
              { run: ["failed"], archived: false },
            ],
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
        facts("failed", { run: "failed" }),
      ],
      placements: [
        ["all", "review"],
        ["no-digest", "active"],
        ["active-no-pr", "active"],
        ["archived", "active"],
        ["idle-pr", "other"],
        ["none", "no-pr"],
        ["unknown", "other"],
        ["failed", "review"],
      ],
      columns: ["review", "active", "no-pr", "other"],
      warning: "Pull-request facts for 1 session are not loaded yet.",
    },
    {
      name: "default rule priority for unobserved runs and PRs",
      spec: createDefaultWorkboardSessionsBoardSpec(),
      facts: [
        facts("active", { run: "active" }),
        facts("failed", { run: "failed" }),
        facts("unhealthy-active", {
          run: "active",
          observerDigest: { health: "stuck", headline: "Stuck", revision: 1 },
        }),
        facts("needs-input", {
          run: "active",
          observerDigest: { health: "waiting-on-user", headline: "Approval", revision: 1 },
        }),
        facts("review", { pullRequests: [{ number: 1, state: "open" }] }),
        facts("merged", { pullRequests: [{ number: 2, state: "merged" }] }),
        facts("idle"),
      ],
      placements: [
        ["active", "working"],
        ["failed", "stuck"],
        ["unhealthy-active", "stuck"],
        ["needs-input", "needs-input"],
        ["review", "in-review"],
        ["merged", "merged"],
        ["idle", "done"],
      ],
      columns: DEFAULT_COLUMNS,
      warning: undefined,
    },
  ] satisfies Array<{
    name: string;
    spec: Partial<WorkboardSessionsBoardSpec>;
    facts: WorkboardSessionFacts[];
    placements: string[][];
    columns: string[];
    warning: string | undefined;
  }>)(
    "classifies sessions using $name",
    async ({ spec, facts: rows, placements, columns, warning }) => {
      await withService({ spec, facts: rows }, async ({ service, store, selectSessionFacts }) => {
        const read = await service.read(BOARD_ID);
        expect(read.columns.map((column) => column.id)).toEqual(columns);
        expect(
          read.sessions.map(({ label, columnId, source }) => [label, columnId, source]),
        ).toEqual(placements.map(([label, columnId]) => [label, columnId, "state"]));
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
        if (warning) {
          expect(read.warning).toContain(warning);
          expect(read.sessions.find((session) => session.label === "unknown")?.reason).toBe(
            "facts-unavailable",
          );
        } else {
          expect(read.warning).toBeUndefined();
        }
        expect(selectSessionFacts).toHaveBeenCalledWith(
          expect.objectContaining({
            configuredAgentsOnly: true,
            includeGlobal: false,
            includeUnknown: false,
          }),
        );
      });
    },
  );

  it("repairs only old-default rules at startup, preserves custom boards and ordering, and is idempotent", async () => {
    await withService(
      { facts: [] },
      async ({ service, store, context, logger, repair, readSessionFacts }) => {
        expect(repair).toHaveBeenCalledOnce();
        await service.read(BOARD_ID);
        await service.read(BOARD_ID);
        expect(repair).toHaveBeenCalledOnce();
        expect(readSessionFacts).not.toHaveBeenCalled();
        await service.stop();
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
        await store.updateSessionsBoard(BOARD_ID, oldSpec);
        await store.upsertBoard({ id: "custom", kind: "sessions" });
        const customSpec = structuredClone(oldSpec);
        customSpec.columns = customSpec.columns.map((column) =>
          column.id === "working" ? { ...column, match: { run: ["active"] } } : column,
        );
        const custom = await store.updateSessionsBoard("custom", customSpec);
        await store.upsertBoard({ id: "custom-order", kind: "sessions" });
        const reordered = structuredClone(oldSpec);
        reordered.columns.reverse();
        await store.updateSessionsBoard("custom-order", reordered);
        logger.info.mockClear();
        await service.start(context);
        const repaired = await store.getSessionsBoard(BOARD_ID);
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
        expect(await store.getSessionsBoard("custom")).toEqual(custom);
        expect(
          (await store.getSessionsBoard("custom-order")).sessions.columns.map(
            (column) => column.id,
          ),
        ).toEqual(oldOrder.toReversed());
        expect(logger.info).toHaveBeenCalledExactlyOnceWith(
          "Sessions board updated default rules on 2 boards.",
        );
        await service.stop();
        await service.start(context);
        expect(await store.getSessionsBoard(BOARD_ID)).toEqual(repaired);
        expect(logger.info).toHaveBeenCalledOnce();
        await service.stop();
        repair.mockResolvedValueOnce({ placements: 3, boards: 0 });
        logger.info.mockClear();
        await service.start(context);
        expect(logger.info).toHaveBeenCalledExactlyOnceWith(
          "Sessions board removed 3 non-operator placements.",
        );
      },
    );
  });

  it("coalesces notifications and refreshes board facts after publications", async () => {
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
        expect((await service.read("second")).sessions).toHaveLength(2);
        changed.mockClear();
        state.sessions = [facts("one", { run: "active" }), facts("two")];
        state.revision = "active";
        emit(facts("one").key);
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({ columnId: "focus" });
        state.sessions = [
          facts("one", { run: "active", label: "Updated during burst" }),
          facts("two"),
        ];
        state.revision = "updated";
        for (let event = 1; event < 100; event += 1) {
          await vi.advanceTimersByTimeAsync(40);
          emit(event === 99 ? "agent:main:not-cached" : facts("one").key);
        }
        await vi.advanceTimersByTimeAsync(1_039);
        expect(changed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(changed).toHaveBeenCalledOnce();
        const read = await service.read(BOARD_ID);
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

  it.each([false, true])(
    "classifies confirmed stale PR facts and reports unavailable facts (rate limited: %s)",
    async (rateLimited) => {
      const availability = rateLimited
        ? { pullRequestsRateLimited: true as const }
        : { pullRequestsUnavailable: true };
      const rows = [
        {
          ...facts("review", { pullRequests: [{ number: 1, state: "open" }], ...availability }),
          pullRequestsStale: true as const,
        },
        {
          ...facts("merged", { pullRequests: [{ number: 2, state: "merged" }], ...availability }),
          pullRequestsStale: true as const,
        },
        { ...facts("none", availability), pullRequestsStale: true as const },
        facts("unknown", availability),
      ];
      await withService(
        { facts: rows, spec: createDefaultWorkboardSessionsBoardSpec() },
        async ({ service, state, emit }) => {
          const read = await service.read(BOARD_ID);
          expect(read.sessions.map(({ columnId }) => columnId)).toEqual([
            "in-review",
            "merged",
            "done",
            "done",
          ]);
          expect(read.sessions.slice(2).map(({ reason }) => reason)).toEqual([
            "fallback",
            "facts-unavailable",
          ]);
          const suffix = rateLimited ? " (GitHub rate limited)" : "";
          expect(read.warning).toBe(
            `Pull-request facts for 3 sessions are stale${suffix}. Pull-request facts for 1 session are not loaded yet${suffix}.`,
          );
          state.sessions = [
            { ...rows[0]!, run: "active" },
            {
              ...rows[1]!,
              observerDigest: { health: "waiting-on-user", headline: "Approval", revision: 1 },
            },
            ...rows.slice(2),
          ];
          state.revision = "new-run-and-health";
          emit(rows[0]!.key);
          emit(rows[1]!.key);
          expect((await service.read(BOARD_ID)).sessions.slice(0, 2)).toMatchObject([
            { run: "active", columnId: "working", pullRequests: rows[0]!.pullRequests },
            {
              observerDigest: { health: "waiting-on-user" },
              columnId: "needs-input",
              pullRequests: rows[1]!.pullRequests,
            },
          ]);
        },
      );
    },
  );

  it("announces sessions added after the first read", async () => {
    await withService({ facts: [] }, async ({ service, store, state, emit }) => {
      expect((await service.read(BOARD_ID)).sessions).toEqual([]);
      const changed = vi.spyOn(store, "announceChangeEpoch");
      state.sessions = [facts("new", { pullRequestsUnavailable: true })];
      state.revision = "new-session";
      emit(state.sessions[0]!.key);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changed).toHaveBeenCalledOnce();
      expect((await service.read(BOARD_ID)).sessions).toMatchObject([
        { key: facts("new").key, reason: "facts-unavailable" },
      ]);
    });
  });

  it("shares frozen projections and reuses 80 unchanged rows after one session changes", async () => {
    await withService(
      { facts: Array.from({ length: 81 }, (_, index) => Object.freeze(facts(String(index)))) },
      async ({ service, store, state, emit }) => {
        const placements = vi.spyOn(store, "listSessionPlacements");
        const boards = vi.spyOn(store, "getSessionsBoard");
        const changes = vi.fn();
        store.subscribeChanges(changes);
        const readers = await Promise.all(
          Array.from({ length: 25 }, () =>
            service.read(BOARD_ID, undefined, { assertCurrent() {} }),
          ),
        );
        const first = readers[0]!;
        expect(readers.every((read) => read === first)).toBe(true);
        expect(first.sessions).toHaveLength(81);
        expect(first.sessions.every(Object.isFrozen)).toBe(true);
        expect(boards).toHaveBeenCalledOnce();
        expect(placements).toHaveBeenCalledOnce();
        emit(facts("0").key, "category");
        await vi.advanceTimersByTimeAsync(5_000);
        expect(changes).not.toHaveBeenCalled();
        expect(await service.read(BOARD_ID)).toBe(first);
        vi.setSystemTime(NOW + 10 * 60_000);
        expect(await service.read(BOARD_ID)).toBe(first);
        state.sessions = [
          Object.freeze({ ...state.sessions[0]!, run: "active" as const }),
          ...state.sessions.slice(1),
        ];
        state.revision = "one-row-changed";
        emit(state.sessions[0]!.key);
        await vi.advanceTimersByTimeAsync(5_000);
        const next = await service.read(BOARD_ID);
        expect(next.revision!.revision).toBeGreaterThan(first.revision!.revision);
        expect(changes).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sessionsRevision: next.revision!.revision }),
        );
        expect(next.sessions[0]).toMatchObject({ run: "active", columnId: "focus" });
        expect(next.sessions[0]).not.toBe(first.sessions[0]);
        expect(
          next.sessions.slice(1).every((row, index) => row === first.sessions[index + 1]),
        ).toBe(true);
        expect(placements).toHaveBeenCalledOnce();
        expect(boards).toHaveBeenCalledOnce();
        expect(await service.read(BOARD_ID)).toBe(next);
        const pinned = await service.move(BOARD_ID, facts("1").key, "focus");
        expect(pinned.sessions[1]).toMatchObject({ columnId: "focus", source: "operator" });
        expect(pinned.sessions[1]).not.toBe(next.sessions[1]);
        expect(
          pinned.sessions
            .filter((_, index) => index !== 1)
            .every((row) => next.sessions.includes(row)),
        ).toBe(true);
        state.scope = "new-authorization";
        const rebuilt = await service.read(BOARD_ID);
        expect(rebuilt.sessions).toEqual(pinned.sessions);
        expect(rebuilt.sessions[0]).not.toBe(pinned.sessions[0]);
        expect(rebuilt.revision!.scope).not.toBe(pinned.revision!.scope);
      },
    );
  });

  it("keeps each visibility projection within its caller's sessions and people", async () => {
    await withService(
      { facts: [facts("shared"), facts("private")] },
      async ({ service, state, selectSessionFacts }) => {
        const people: NonNullable<SelectedFacts["people"]> = [
          { identity: { type: "profile", id: "one" }, label: "One", sessionCount: 2 },
        ];
        selectSessionFacts
          .mockResolvedValueOnce({ ...state, scope: "owner", people })
          .mockResolvedValueOnce({
            ...state,
            scope: "viewer",
            sessions: [state.sessions[0]!],
            people: [],
          });
        const [owner, viewer] = await Promise.all([
          service.read(BOARD_ID, { includePeople: true }, { assertCurrent() {} }),
          service.read(BOARD_ID, { includePeople: true }, { assertCurrent() {} }),
        ]);
        expect(owner.sessions.map(({ label }) => label)).toEqual(["shared", "private"]);
        expect(owner.people).toEqual(people);
        expect(viewer.sessions.map(({ label }) => label)).toEqual(["shared"]);
        expect(viewer.people).toEqual([]);
        expect(viewer.revision!.scope).not.toBe(owner.revision!.scope);
        selectSessionFacts.mockResolvedValueOnce({
          ...state,
          scope: "viewer",
          revision: "people-changed",
          sessions: [state.sessions[0]!],
          people,
        });
        const otherPeople = await service.read(BOARD_ID, { includePeople: true });
        expect(otherPeople.sessions).toEqual(viewer.sessions);
        expect(otherPeople.people).toEqual(people);
        expect(otherPeople.revision!.scope).not.toBe(viewer.revision!.scope);
      },
    );
  });

  it.each(["session", "people"] as const)(
    "expires cached %s at the exact activity deadline",
    async (kind) => {
      await withService(
        { facts: [facts("one")], spec: { scope: { maxAgeHours: 1 } } },
        async ({ service, state }) => {
          const deadline = NOW + (kind === "people" ? 1_000 : 3_600_000);
          const person = { identity: { type: "profile" as const, id: "one" }, label: "One" };
          if (kind === "people") {
            state.sessions = [];
            state.people = [{ ...person, sessionCount: 1 }];
            state.activityExpiresAt = deadline;
          }
          const view = { includePeople: true };
          const first = await service.read(BOARD_ID, view);
          vi.setSystemTime(deadline);
          expect(await service.read(BOARD_ID, view)).toBe(first);
          vi.setSystemTime(deadline + 1);
          if (kind === "people") {
            state.people = [];
            state.activityExpiresAt = undefined;
            state.revision = "people-expired";
          }
          const expired = await service.read(BOARD_ID, view);
          expect(expired.sessions).toEqual([]);
          if (kind === "people") {
            expect(first.people).toEqual([{ ...person, sessionCount: 1 }]);
            expect(expired.people).toEqual([]);
          }
          expect(expired.revision!.scope).not.toBe(first.revision!.scope);
        },
      );
    },
  );

  it.each(["source", "placements"] as const)(
    "refreshes expired people for a reader joining pending %s work",
    async (pending) => {
      await withService({ facts: [] }, async ({ service, store, state, selectSessionFacts }) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const people: NonNullable<SelectedFacts["people"]> = [
          { identity: { type: "profile", id: "one" }, label: "One", sessionCount: 1 },
        ];
        const source = { ...state, people, activityExpiresAt: NOW + 100 };
        state.people = [];
        state.revision = "people-expired";
        using placements = vi.spyOn(store, "listSessionPlacements");
        if (pending === "source") {
          selectSessionFacts.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return source;
          });
        } else {
          selectSessionFacts.mockResolvedValueOnce(source);
          placements.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return [];
          });
        }
        const view = { includePeople: true, involvingProfileId: "selected" };
        const first = service.read(BOARD_ID, view);
        await entered.promise;
        vi.setSystemTime(NOW + 101);
        const second = await service.read(BOARD_ID, view);
        release.resolve();
        const before = await first;
        expect(before.people).toEqual(people);
        expect(second.people).toEqual([]);
        expect(second.revision!.scope).not.toBe(before.revision!.scope);
        expect((await service.read(BOARD_ID, view)).people).toEqual([]);
      });
    },
  );

  it("checks authority after the caller's facts selection even with a warm projection", async () => {
    await withService({ facts: [facts("one")] }, async ({ service, state, selectSessionFacts }) => {
      const first = await service.read(BOARD_ID);
      let active = true;
      selectSessionFacts.mockImplementationOnce(async () => {
        active = false;
        return { ...state };
      });
      await expect(
        service.read(BOARD_ID, undefined, {
          assertCurrent() {
            if (!active) {
              throw new Error("Caller authority expired");
            }
          },
        }),
      ).rejects.toThrow("Caller authority expired");
      expect(await service.read(BOARD_ID)).toBe(first);
    });
  });

  it.each(["owner", "joiner"] as const)(
    "rejects an expired %s without retiring the other caller's authority",
    async (expired) => {
      await withService(
        { facts: [facts("one")] },
        async ({ service, store, state, selectSessionFacts }) => {
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
          using placements = vi.spyOn(store, "listSessionPlacements");
          placements.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return [];
          });
          const owner = service.read(BOARD_ID, undefined, caller("owner"));
          await entered.promise;
          selectSessionFacts.mockImplementationOnce(async () => {
            joinerSelected = true;
            return { ...state };
          });
          const joiner = service.read(BOARD_ID, undefined, caller("joiner"));
          const rejected = expect(expired === "owner" ? owner : joiner).rejects.toThrow(
            "Caller authority expired",
          );
          await joined.promise;
          active = false;
          release.resolve();
          await rejected;
          const survivor = await (expired === "owner" ? joiner : owner);
          expect(survivor.sessions).toMatchObject([{ key: facts("one").key }]);
          expect((await service.read(BOARD_ID)).sessions).toEqual(survivor.sessions);
        },
      );
    },
  );

  it("keeps pins across fact changes and returns to rules when their column is deleted", async () => {
    await withService(
      { facts: [facts("one", { run: "active" })] },
      async ({ service, store, state, emit }) => {
        await service.move(BOARD_ID, facts("one").key, "other");
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({
          columnId: "other",
          source: "operator",
        });
        state.sessions = [
          facts("one", { observerDigest: { health: "stuck", headline: "Stuck", revision: 1 } }),
        ];
        state.revision = "health-changed";
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
    const marker = "old-policy-text";
    const known = facts("known", {
      run: "active",
      label: marker,
      derivedTitle: marker,
      lastMessagePreview: marker,
      observerDigest: { health: "on-track", headline: marker, assessment: marker, revision: 1 },
      pullRequests: [{ number: 12, state: "open", title: marker }],
    });
    await withService({ facts: [known] }, async ({ service, state, emit, logger }) => {
      await service.read(BOARD_ID);
      state.sessions = [facts("known"), facts("new")].map((row) =>
        Object.assign(row, { unavailable: "Error: facts backend offline" }),
      );
      state.revision = "unavailable";
      emit(facts("known").key);
      const read = await service.read(BOARD_ID);
      expect(read.warning).toContain(
        "Session facts are unavailable for 2 sessions: Error: facts backend offline. Showing the last known placement.",
      );
      expect(read.sessions).toMatchObject([
        { key: facts("known").key, run: "active", columnId: "focus" },
        { key: facts("new").key, columnId: "other", reason: "facts-unavailable" },
      ]);
      expect(read.sessions[0]).toMatchObject(known);
      await service.read(BOARD_ID);
      expect(logger.warn).toHaveBeenCalledOnce();
      state.redactionRevision = "tightened-policy";
      state.revision = "redaction-changed-with-failure";
      state.sessions = state.sessions.map((row) =>
        Object.assign({}, row, { label: "Safe label", derivedTitle: "Safe title" }),
      );
      const safe = await service.read(BOARD_ID);
      expect(JSON.stringify(safe.sessions)).not.toContain(marker);
      expect(safe.sessions[0]).toMatchObject({
        columnId: "focus",
        run: "active",
        label: "Safe label",
        derivedTitle: "Safe title",
        observerDigest: { health: "on-track", revision: 1 },
        pullRequests: [{ number: 12, state: "open" }],
      });
      expect(safe.sessions[0]?.lastMessagePreview).toBeUndefined();
      state.sessions = [facts("known"), facts("new")];
      state.revision = "recovered";
      const recovered = await service.read(BOARD_ID);
      expect(recovered.warning).toBeUndefined();
      expect(recovered.revision!.revision).toBe(read.revision!.revision);
      expect(recovered.revision!.scope).not.toBe(read.revision!.scope);
      expect(await service.read(BOARD_ID)).toBe(recovered);
      state.sessions = [];
      state.missingSessionKeys = [facts("known").key, facts("new").key];
      state.revision = "missing-current-facts";
      emit(facts("known").key);
      expect((await service.read(BOARD_ID)).sessions).toEqual([]);
      state.missingSessionKeys = undefined;
      state.sessions = [
        { ...facts("known"), unavailable: "second outage" },
        { ...facts("new"), unavailable: "second outage" },
      ];
      state.revision = "unavailable-after-missing-facts";
      emit(facts("known").key);
      const unavailable = await service.read(BOARD_ID);
      expect(unavailable.warning).toContain("second outage");
      expect(unavailable.sessions).toMatchObject([
        { key: facts("known").key, columnId: "other", reason: "facts-unavailable" },
        { key: facts("new").key, columnId: "other", reason: "facts-unavailable" },
      ]);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });
  });

  it("does not let an in-flight read overwrite facts after source invalidation", async () => {
    await withService(
      { facts: [facts("one")] },
      async ({ service, store, state, emit, selectSessionFacts }) => {
        await service.read(BOARD_ID);
        emit(facts("one").key);
        const admittedRevision = store.sessionsRevision;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const source = { ...state };
        selectSessionFacts.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return source;
        });
        const pending = service.read(BOARD_ID);
        await entered.promise;
        state.sessions = [facts("one", { run: "active" })];
        state.revision = "active";
        emit(facts("one").key);
        const current = await service.read(BOARD_ID);
        release.resolve();
        const previous = await pending;
        expect(previous.revision!.revision).toBe(admittedRevision.revision);
        expect(current.sessions[0]).toMatchObject({ columnId: "focus" });
        expect(current.revision!.revision).toBeGreaterThanOrEqual(previous.revision!.revision);
        expect(await service.read(BOARD_ID)).toBe(current);
        state.sessions = [{ ...facts("one"), unavailable: "facts backend offline" }];
        state.revision = "unavailable";
        emit(facts("one").key);
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({ columnId: "focus" });
      },
    );
  });

  it("completes during continuous source invalidation without caching a stale revision", async () => {
    await withService(
      { facts: [facts("one")] },
      async ({ service, store, state, selectSessionFacts, emit }) => {
        const admittedRevision = store.sessionsRevision;
        let sourceReads = 0;
        selectSessionFacts.mockImplementation(async () => {
          if (++sourceReads > 2) {
            throw new Error("Sessions board kept retrying invalidated facts");
          }
          emit(facts("one").key);
          return { ...state };
        });
        const duringChurn = await service.read(BOARD_ID);
        expect(sourceReads).toBe(1);
        expect(duringChurn.revision!.revision).toBe(admittedRevision.revision);
        expect(duringChurn.revision!.revision).toBeLessThan(store.sessionsRevision.revision);
        selectSessionFacts.mockImplementation(async () => ({ ...state }));
        const current = await service.read(BOARD_ID);
        expect(current.revision!.revision).toBe(store.sessionsRevision.revision);
        expect(current.revision!.scope).not.toBe(duringChurn.revision!.scope);
        expect(await service.read(BOARD_ID)).toBe(current);
        state.sessions = [facts("one", { run: "active" })];
        state.revision = "active";
        emit(facts("one").key);
        expect((await service.read(BOARD_ID)).sessions[0]).toMatchObject({ columnId: "focus" });
      },
    );
  });

  it("excludes the Board agent from reads and moves", async () => {
    const own = facts("board-agent");
    await withService(
      { facts: [own, facts("one")], spec: { agentSessionKey: own.key } },
      async ({ service, store }) => {
        expect((await service.read(BOARD_ID)).sessions.map((session) => session.key)).toEqual([
          facts("one").key,
        ]);
        await expect(service.move(BOARD_ID, own.key, "other")).rejects.toThrow(
          "not available in this board's scope",
        );
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
      },
    );
  });

  it("forwards people views without changing the board or pins", async () => {
    await withService(
      { facts: [facts("one"), facts("two")] },
      async ({ service, store, state, selectSessionFacts }) => {
        await service.read(BOARD_ID);
        const board = await store.getSessionsBoard(BOARD_ID);
        const people: NonNullable<SelectedFacts["people"]> = [
          { identity: { type: "profile", id: "profile-one" }, label: "Alex", sessionCount: 1 },
        ];
        for (const view of [
          { involvingMe: true, includePeople: true },
          { involvingProfileId: "profile-one", includePeople: true },
          { involvingMe: false, includePeople: false },
        ]) {
          selectSessionFacts.mockClear();
          selectSessionFacts.mockResolvedValueOnce({
            ...state,
            sessions: [state.sessions[0]!],
            people: view.includePeople ? people : undefined,
          });
          const read = await service.read(BOARD_ID, view);
          expect(selectSessionFacts).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(view));
          expect(read.sessions.map(({ key }) => key)).toEqual([facts("one").key]);
          expect(read.people).toBe(view.includePeople ? people : undefined);
        }
        expect(await store.getSessionsBoard(BOARD_ID)).toEqual(board);
        expect(await store.listSessionPlacements(BOARD_ID)).toEqual([]);
      },
    );
  });
});
