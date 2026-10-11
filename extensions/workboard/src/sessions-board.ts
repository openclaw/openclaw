import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  WorkboardSessionFacts,
  WorkboardSessionsBoard,
  WorkboardSessionsBoardRead,
  WorkboardSessionsBoardView,
} from "@openclaw/workboard-contract";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import { sessionMatchesColumn, sessionsBoardFallback } from "./sessions-board-rules.js";
import type { WorkboardBoardStore } from "./store-boards.js";
import { freezeCardList } from "./store-read.js";

type Gateway = Pick<
  OpenClawPluginApi["runtime"]["gateway"],
  "readSessionFacts" | "subscribeSessionChanges" | "withSessionFacts"
>;
type SessionsBoardServiceParams = {
  store: WorkboardBoardStore;
  gateway: Gateway;
  now?: () => number;
};
type CallerAuthority = { assertCurrent: () => void };
type Operations = {
  read: (
    boardId: string,
    view?: WorkboardSessionsBoardView,
    caller?: CallerAuthority,
  ) => Promise<WorkboardSessionsBoardRead>;
  update: (
    boardId: string,
    patch: unknown,
    caller?: CallerAuthority,
  ) => Promise<WorkboardSessionsBoard>;
  move: (
    boardId: string,
    sessionKey: string,
    columnId: string,
    caller?: CallerAuthority,
  ) => Promise<WorkboardSessionsBoardRead>;
};
export type WorkboardSessionsBoardService = OpenClawPluginService &
  Operations & { stop: () => Promise<void> };
type Owner = Operations & { cancel: () => void; stop: () => Promise<void> };
type SourceSnapshot = Parameters<Parameters<Gateway["withSessionFacts"]>[1]>[0];
type SourceRow = SourceSnapshot["sessions"][number];
type Placements = Awaited<ReturnType<WorkboardBoardStore["listSessionPlacements"]>>;
type CachedFacts = {
  source: SourceRow;
  observation: number;
  facts: WorkboardSessionFacts;
  stale?: boolean;
  pin?: Placements[number];
  row?: WorkboardSessionsBoardRead["sessions"][number];
};
type PreparedProjection = {
  read: Promise<{ snapshot: WorkboardSessionsBoardRead; complete: boolean }>;
  revision: WorkboardBoardStore["sessionsRevision"];
  sourceRevision: string;
  observation: number;
  board: WorkboardSessionsBoard;
  expires: number;
  facts?: Map<string, CachedFacts>;
  placements?: Placements;
};

function activeState() {
  return resolveGlobalSingleton<{ owner?: Owner }>(
    Symbol.for("openclaw.workboard.sessionsBoardService"),
    () => ({}),
    (state) => {
      state.owner?.cancel();
      state.owner = undefined;
    },
  );
}

function sessionSelection(board: WorkboardSessionsBoard, view?: WorkboardSessionsBoardView) {
  return {
    configuredAgentsOnly: true,
    includeGlobal: false,
    includeUnknown: false,
    excludeDock: true,
    ...(board.sessions.scope?.includeAutomation ? {} : { excludeCron: true, excludeSystem: true }),
    archived: board.sessions.scope?.includeArchived ? ("all" as const) : false,
    sortBy: "activity" as const,
    activeMinutes: Math.max(1, Math.ceil((board.sessions.scope?.maxAgeHours ?? 72) * 60)),
    ...(board.sessions.scope?.agentIds?.length === 1
      ? { agentId: board.sessions.scope.agentIds[0] }
      : {}),
    ...view,
  };
}

function inScope(facts: WorkboardSessionFacts, board: WorkboardSessionsBoard, now: number) {
  const scope = board.sessions.scope;
  // The board's own agent conversation edits the board; it is not work to place on it.
  return (
    facts.key !== board.sessions.agentSessionKey &&
    (!scope?.agentIds?.length || scope.agentIds.includes(facts.agentId)) &&
    (scope?.includeArchived === true || !facts.archived) &&
    facts.lastActivityAt >= now - (scope?.maxAgeHours ?? 72) * 3_600_000
  );
}

function createOwner(
  params: SessionsBoardServiceParams,
  context: ParametersOfStart,
  isCurrent: () => boolean,
): Owner {
  const lastKnown = new Map<string, CachedFacts>();
  const projections = new Map<string, PreparedProjection>();
  const boards = new Map<string, Promise<WorkboardSessionsBoard>>();
  let revision = params.store.sessionsRevision;
  let observation = 0;
  const now = params.now ?? Date.now;
  let stopped = false;
  let hasRead = false;
  let factsFailureLogged = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const assertCurrent = () => {
    if (stopped || !isCurrent()) {
      throw new Error("Sessions board service is no longer active.");
    }
  };
  const interactiveAuthority = (caller?: CallerAuthority) => () => {
    assertCurrent();
    caller?.assertCurrent();
  };
  const unsubscribe = params.gateway.subscribeSessionChanges(({ factsInvalidated }) => {
    if (stopped || !hasRead || factsInvalidated === "category") {
      return;
    }
    if (revision !== params.store.sessionsRevision) {
      boards.clear();
    }
    params.store.invalidateSessionBoards();
    revision = params.store.sessionsRevision;
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped && isCurrent()) {
        params.store.announceChangeEpoch();
      }
    }, 5_000);
    timer.unref?.();
  });
  const project = (
    board: WorkboardSessionsBoard,
    source: SourceSnapshot,
    placements: Map<string, Placements[number]>,
    admittedRevision: typeof revision,
    admittedObservation: number,
    preparedFacts?: Map<string, CachedFacts>,
  ) => {
    if (params.store.sessionsRevision === admittedRevision) {
      for (const key of source.missingSessionKeys ?? []) {
        if ((lastKnown.get(key)?.observation ?? 0) <= admittedObservation) {
          lastKnown.delete(key);
        }
      }
    }
    const unavailable = new Set<string>();
    const reasons = new Set<string>();
    const resolved = new Map<string, CachedFacts>();
    for (const row of source.sessions) {
      if (
        row.key === board.sessions.agentSessionKey ||
        (row.isMain && !board.sessions.scope?.includeHome)
      ) {
        continue;
      }
      const previous = preparedFacts?.get(row.key);
      if (
        previous?.source === row &&
        !row.unavailable &&
        isDeepStrictEqual(previous.pin, placements.get(row.key))
      ) {
        resolved.set(row.key, previous);
        continue;
      }
      const { isMain: _isMain, unavailable: failure, pullRequestsStale: _stale, ...facts } = row;
      const current: CachedFacts = {
        source: row,
        observation: admittedObservation,
        facts,
      };
      if (failure) {
        unavailable.add(row.key);
        reasons.add(failure);
        const previousFacts = lastKnown.get(row.key);
        const known = previousFacts?.facts.sessionId === row.sessionId ? previousFacts : undefined;
        current.facts = known ? known.facts : facts;
        current.stale = known?.stale;
      } else {
        current.stale = row.pullRequestsStale;
      }
      resolved.set(row.key, current);
      // A late read cannot replace the current generation's fallback facts.
      if (
        !failure &&
        params.store.sessionsRevision === admittedRevision &&
        (lastKnown.get(row.key)?.observation ?? 0) <= admittedObservation
      ) {
        lastKnown.set(row.key, current);
      }
    }
    const fallback = sessionsBoardFallback(board);
    const sessions: WorkboardSessionsBoardRead["sessions"] = [];
    const prWarnings = new Map<string, number>();
    for (const [key, cached] of resolved) {
      const { facts, source: row } = cached;
      if (!inScope(facts, board, now())) {
        continue;
      }
      if (facts.pullRequestsUnavailable || facts.pullRequestsRateLimited) {
        const availability = cached.stale ? "stale" : "not loaded yet";
        const reason = `${availability}${facts.pullRequestsRateLimited ? " (GitHub rate limited)" : ""}`;
        prWarnings.set(reason, (prWarnings.get(reason) ?? 0) + 1);
      }
      if (cached.row) {
        sessions.push(cached.row);
        continue;
      }
      const known = !row.unavailable || lastKnown.get(key)?.facts.sessionId === row.sessionId;
      const pin = placements.get(row.key);
      const pinned =
        pin?.source === "operator" &&
        board.sessions.columns.some((column) => column.id === pin.columnId);
      // Keep availability visible to callers while rules use the last confirmed PR list.
      const ruleFacts =
        facts.pullRequestsUnavailable || facts.pullRequestsRateLimited
          ? { ...facts, pullRequestsUnavailable: !cached.stale }
          : facts;
      const match = known
        ? board.sessions.columns.find((column) => sessionMatchesColumn(ruleFacts, column))
        : undefined;
      const placed = Object.freeze({
        ...facts,
        columnId: pinned ? pin.columnId : (match ?? fallback).id,
        source: pinned ? ("operator" as const) : ("state" as const),
        reason: pinned
          ? pin.reason
          : !known || (!match && ruleFacts.pullRequestsUnavailable)
            ? "facts-unavailable"
            : match
              ? "Matched column rules"
              : "fallback",
      });
      sessions.push(placed);
      resolved.set(key, { ...cached, pin, row: placed });
    }
    const warnings: string[] = [];
    if (unavailable.size) {
      const warning = `Session facts are unavailable for ${unavailable.size} sessions: ${[...reasons].join("; ")}. Showing the last known placement.`;
      warnings.push(warning);
      if (!factsFailureLogged) {
        context.logger.warn(warning);
      }
      factsFailureLogged = true;
    } else {
      factsFailureLogged = false;
    }
    for (const [reason, count] of prWarnings) {
      warnings.push(
        `Pull-request facts for ${count} ${count === 1 ? "session" : "sessions"} are ${reason}.`,
      );
    }
    Object.freeze(sessions);
    return {
      complete: unavailable.size === 0 && !source.missingSessionKeys?.length,
      facts: resolved,
      snapshot: {
        board,
        columns: board.sessions.columns,
        sessions,
        ...(source.people !== undefined ? { people: source.people } : {}),
        ...(warnings.length ? { warning: warnings.join(" ") } : {}),
      },
    };
  };
  const read = async (
    id: string,
    view?: WorkboardSessionsBoardView,
    caller?: CallerAuthority,
  ): Promise<WorkboardSessionsBoardRead> => {
    const assertReadCurrent = interactiveAuthority(caller);
    assertReadCurrent();
    hasRead = true;
    const admittedObservation = ++observation;
    if (revision !== params.store.sessionsRevision) {
      boards.clear();
      revision = params.store.sessionsRevision;
    }
    const admittedRevision = revision;
    let boardRead = boards.get(id);
    if (!boardRead) {
      boardRead = params.store.getSessionsBoard(id).then((board) => {
        freezeCardList(board);
        return board;
      });
      if (boards.size >= 64) {
        boards.delete(boards.keys().next().value!);
      }
      boards.set(id, boardRead);
      void boardRead.catch(() => {
        if (boards.get(id) === boardRead) {
          boards.delete(id);
        }
      });
    }
    const board = await boardRead;
    assertReadCurrent();
    return params.gateway.withSessionFacts(sessionSelection(board, view), async (source) => {
      assertReadCurrent();
      const key = JSON.stringify([id, view, source.scope ?? source.revision]);
      const current = projections.get(key);
      const cacheable =
        params.store.sessionsRevision === admittedRevision &&
        (!current || current.observation <= admittedObservation);
      const admittedAt = now();
      const previous = cacheable ? current : undefined;
      let projection = previous;
      if (
        projection &&
        (projection.revision !== admittedRevision ||
          projection.sourceRevision !== source.revision ||
          projection.expires < admittedAt)
      ) {
        projection = undefined;
      }
      const joined = Boolean(projection);
      if (!projection) {
        const prepared: PreparedProjection = {
          revision: admittedRevision,
          sourceRevision: source.revision,
          observation: admittedObservation,
          board,
          expires: source.activityExpiresAt ?? Infinity,
          read: Promise.resolve().then(async () => {
            const placements =
              (previous?.board === board ? previous.placements : undefined) ??
              (await params.store.listSessionPlacements(id));
            assertReadCurrent();
            prepared.placements = placements;
            const {
              snapshot: result,
              complete,
              facts,
            } = project(
              board,
              source,
              new Map(placements.map((pin) => [pin.sessionKey, pin])),
              admittedRevision,
              admittedObservation,
              isDeepStrictEqual(previous?.board.sessions.columns, board.sessions.columns)
                ? previous?.facts
                : undefined,
            );
            const maxAge = (board.sessions.scope?.maxAgeHours ?? 72) * 3_600_000;
            prepared.expires = result.sessions.reduce(
              (deadline, row) => Math.min(deadline, row.lastActivityAt + maxAge),
              prepared.expires,
            );
            prepared.facts = complete ? facts : undefined;
            const snapshot = Object.freeze({
              ...result,
              revision: Object.freeze({ ...admittedRevision, boardId: id, scope: randomUUID() }),
            });
            return { snapshot, complete };
          }),
        };
        if (cacheable) {
          if (projections.size >= 64) {
            projections.delete(projections.keys().next().value!);
          }
          projections.set(key, prepared);
        }
        projection = prepared;
      }
      try {
        const { snapshot, complete } = await projection.read;
        assertReadCurrent();
        const expired = projection.expires < admittedAt;
        if (
          (!complete || expired || params.store.sessionsRevision !== admittedRevision) &&
          projections.get(key) === projection
        ) {
          projections.delete(key);
        }
        if (joined && expired) {
          return await read(id, view, caller);
        }
        return snapshot;
      } catch (error) {
        if (projections.get(key) === projection) {
          projections.delete(key);
        }
        assertReadCurrent();
        if (joined) {
          return await read(id, view, caller);
        }
        throw error;
      }
    });
  };
  const cancel = () => {
    stopped = true;
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
    }
    timer = undefined;
    lastKnown.clear();
    projections.clear();
    boards.clear();
  };
  return {
    read,
    cancel,
    async stop() {
      cancel();
    },
    async update(id, patch, caller) {
      const assertWriteCurrent = interactiveAuthority(caller);
      assertWriteCurrent();
      return await params.store.updateSessionsBoard(id, patch, assertWriteCurrent);
    },
    async move(id, sessionKey, columnId, caller) {
      const assertWriteCurrent = interactiveAuthority(caller);
      assertWriteCurrent();
      const snapshot = await read(id, undefined, caller);
      const board = snapshot.board;
      if (!board.sessions.columns.some((column) => column.id === columnId)) {
        throw new Error("Unknown Sessions board column.");
      }
      const visible = snapshot.sessions.find((row) => row.key === sessionKey);
      if (!visible) {
        throw new Error("Session is not available in this board's scope.");
      }
      const result = await params.gateway.readSessionFacts({ sessionKeys: [sessionKey] });
      const facts = result.sessions.find(
        (entry) =>
          entry.key === sessionKey &&
          entry.sessionId === visible.sessionId &&
          inScope(entry, board, now()),
      );
      if (!facts) {
        throw new Error("Session is not available in this board's scope.");
      }
      const previous = (await params.store.listSessionPlacements(id)).find(
        (entry) => entry.sessionKey === sessionKey,
      );
      if (
        !(await params.store.writeSessionPlacement(
          id,
          {
            sessionKey,
            columnId,
            source: "operator",
            reason: "Moved by operator",
            factsHash: "",
            updatedAt: now(),
            expectedUpdatedAt: previous?.updatedAt,
          },
          { expectedSpec: board.sessions, assertCurrent: assertWriteCurrent },
        ))
      ) {
        throw new Error("Sessions board changed. Refresh and retry the move.");
      }
      return await read(id, undefined, caller);
    },
  };
}

type ParametersOfStart = Parameters<OpenClawPluginService["start"]>[0];

/** Prepared tool registries delegate to the one running plugin service. */
export function createWorkboardSessionsBoardService(
  params: SessionsBoardServiceParams,
): WorkboardSessionsBoardService {
  let owned: Owner | undefined;
  const current = () => {
    const owner = activeState().owner;
    if (!owner) {
      throw new Error("Sessions board service is unavailable.");
    }
    return owner;
  };
  return {
    id: "workboard-sessions-board",
    async start(context) {
      const state = activeState();
      await state.owner?.stop();
      state.owner = undefined;
      const repaired = await params.store.repairSessionPlacements();
      if (repaired.placements) {
        context.logger.info(
          `Sessions board removed ${repaired.placements} non-operator placements.`,
        );
      }
      if (repaired.boards) {
        context.logger.info(`Sessions board updated default rules on ${repaired.boards} boards.`);
      }
      const owner = createOwner(params, context, () => activeState().owner === owner);
      owned = state.owner = owner;
    },
    async stop() {
      if (!owned) {
        return;
      }
      const owner = owned;
      owned = undefined;
      if (activeState().owner === owner) {
        activeState().owner = undefined;
      }
      await owner.stop();
    },
    read: (id, view, caller) => current().read(id, view, caller),
    update: (id, patch, caller) => current().update(id, patch, caller),
    move: (id, key, column, caller) => current().move(id, key, column, caller),
  };
}
