import { randomUUID } from "node:crypto";
import type {
  WorkboardSessionFacts,
  WorkboardSessionsBoard,
  WorkboardSessionsBoardRead,
  WorkboardSessionsBoardView,
} from "@openclaw/workboard-contract";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import {
  isIncognitoSessionKey,
  resolveAgentIdFromSessionKey,
} from "openclaw/plugin-sdk/session-key-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import { sessionMatchesColumn, sessionsBoardFallback } from "./sessions-board-rules.js";
import type { WorkboardBoardStore } from "./store-boards.js";
import { freezeCardList } from "./store-read.js";

type Gateway = Pick<
  OpenClawPluginApi["runtime"]["gateway"],
  "request" | "readSessionFacts" | "subscribeSessionChanges"
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
const FACTS_BATCH_SIZE = 40;

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

/** Uses the existing Gateway session-list owner in the invoking caller's scope. */
async function listSessions(
  gateway: Gateway,
  board: WorkboardSessionsBoard,
  view?: WorkboardSessionsBoardView,
) {
  const sessions = new Map<string, WorkboardSessionFacts>();
  let people: WorkboardSessionsBoardRead["people"];
  let offset = 0;
  for (;;) {
    const payload = await gateway.request<{
      sessions: unknown[];
      hasMore?: boolean;
      nextOffset?: number;
      people?: WorkboardSessionsBoardRead["people"];
    }>(
      "sessions.list",
      {
        limit: 1000,
        rowMode: "compact",
        offset,
        configuredAgentsOnly: true,
        includeGlobal: false,
        includeUnknown: false,
        ...(board.sessions.scope?.includeAutomation
          ? {}
          : { excludeCron: true, excludeSystem: true }),
        archived: board.sessions.scope?.includeArchived ? "all" : false,
        sortBy: "activity",
        activeMinutes: Math.max(1, Math.ceil((board.sessions.scope?.maxAgeHours ?? 72) * 60)),
        ...(board.sessions.scope?.agentIds?.length === 1
          ? { agentId: board.sessions.scope.agentIds[0] }
          : {}),
        ...view,
      },
      { scopes: ["operator.read"] },
    );
    if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
      throw new Error("sessions.list returned an invalid Sessions board roster.");
    }
    if (offset === 0 && view?.includePeople) {
      people = payload.people;
    }
    for (const session of payload.sessions) {
      if (
        isRecord(session) &&
        typeof session.key === "string" &&
        typeof session.sessionId === "string" &&
        session.visibility !== "draft" &&
        session.incognito !== true &&
        (board.sessions.scope?.includeHome === true || session.isMain !== true) &&
        !isIncognitoSessionKey(session.key)
      ) {
        sessions.set(session.key, {
          key: session.key,
          sessionId: session.sessionId,
          agentId: resolveAgentIdFromSessionKey(session.key),
          label: typeof session.label === "string" ? session.label : undefined,
          derivedTitle: typeof session.derivedTitle === "string" ? session.derivedTitle : undefined,
          run: "idle",
          pullRequests: [],
          pullRequestsUnavailable: true,
          archived: session.archived === true,
          lastActivityAt:
            typeof session.lastActivityAt === "number"
              ? session.lastActivityAt
              : typeof session.updatedAt === "number"
                ? session.updatedAt
                : Date.now(),
        });
      }
    }
    if (payload.hasMore !== true) {
      return { sessions, people };
    }
    const next = payload.nextOffset;
    if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= offset) {
      throw new Error("sessions.list returned an invalid Sessions board page cursor.");
    }
    offset = next;
  }
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
  const lastKnown = new Map<string, WorkboardSessionFacts>();
  const boards = new Map<string, Promise<WorkboardSessionsBoard>>();
  const projections = new Map<
    string,
    { read: Promise<{ snapshot: WorkboardSessionsBoardRead; complete: boolean }>; expires: number }
  >();
  let revision = params.store.sessionsRevision;
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
    params.store.invalidateSessionBoards();
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
  const project = async (
    board: WorkboardSessionsBoard,
    roster: Map<string, WorkboardSessionFacts>,
    people: WorkboardSessionsBoardRead["people"],
    admittedRevision: typeof revision,
    caller?: CallerAuthority,
  ) => {
    const id = board.id;
    const assertReadCurrent = interactiveAuthority(caller);
    assertReadCurrent();
    const unavailable = new Set<string>();
    const reasons = new Set<string>();
    const resolved = new Map<string, WorkboardSessionFacts>();
    const rows = [...roster.values()].filter((row) => row.key !== board.sessions.agentSessionKey);
    let complete = true;
    for (let offset = 0; offset < rows.length; offset += FACTS_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + FACTS_BATCH_SIZE);
      try {
        const result = await params.gateway.readSessionFacts({
          sessionKeys: batch.map((row) => row.key),
        });
        assertReadCurrent();
        const returned = new Map(result.sessions.map((facts) => [facts.key, facts]));
        for (const row of batch) {
          const facts = returned.get(row.key);
          if (facts?.sessionId === row.sessionId) {
            resolved.set(row.key, facts);
          } else {
            complete = false;
          }
          // Late snapshots may finish, but cannot replace a newer generation's fallback facts.
          if (params.store.sessionsRevision === admittedRevision) {
            if (facts?.sessionId === row.sessionId) {
              lastKnown.set(row.key, facts);
            } else {
              lastKnown.delete(row.key);
            }
          }
        }
      } catch (error) {
        assertReadCurrent();
        complete = false;
        for (const row of batch) {
          unavailable.add(row.key);
          const previous = lastKnown.get(row.key);
          if (previous?.sessionId === row.sessionId) {
            resolved.set(row.key, previous);
          }
        }
        reasons.add(redactToolPayloadText(String(error)).replace(/\s+/g, " ").slice(0, 300));
      }
    }
    const placements = new Map(
      (await params.store.listSessionPlacements(id)).map((entry) => [entry.sessionKey, entry]),
    );
    assertReadCurrent();
    const fallback = sessionsBoardFallback(board);
    const sessions: WorkboardSessionsBoardRead["sessions"] = [];
    for (const row of roster.values()) {
      if (!resolved.has(row.key) && !unavailable.has(row.key)) {
        continue;
      }
      const known = resolved.get(row.key);
      const facts = known ?? row;
      if (!inScope(facts, board, now())) {
        continue;
      }
      const pin = placements.get(row.key);
      const pinned =
        pin?.source === "operator" &&
        board.sessions.columns.some((column) => column.id === pin.columnId);
      const match = known
        ? board.sessions.columns.find((column) => sessionMatchesColumn(facts, column))
        : undefined;
      sessions.push({
        ...facts,
        columnId: pinned ? pin.columnId : (match ?? fallback).id,
        source: pinned ? "operator" : "state",
        reason: pinned
          ? pin.reason
          : !known || (!match && facts.pullRequestsUnavailable)
            ? "facts-unavailable"
            : match
              ? "Matched column rules"
              : "fallback",
      });
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
    if (sessions.some((session) => session.pullRequestsUnavailable)) {
      warnings.push(
        "Some pull-request information is unavailable. The board updates when background facts are ready.",
      );
    }
    return {
      complete,
      snapshot: {
        board,
        columns: board.sessions.columns,
        sessions,
        ...(people !== undefined ? { people } : {}),
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
    if (revision !== params.store.sessionsRevision) {
      boards.clear();
      projections.clear();
      revision = params.store.sessionsRevision;
    }
    const admittedRevision = revision;
    let boardRead = boards.get(id);
    if (!boardRead) {
      const pending = params.store.getSessionsBoard(id).catch((error: unknown) => {
        if (boards.get(id) === pending) {
          boards.delete(id);
        }
        throw error;
      });
      if (boards.size >= 64) {
        boards.delete(boards.keys().next().value!);
      }
      boards.set(id, pending);
      boardRead = pending;
    }
    const board = await boardRead;
    const { sessions, people } = await listSessions(params.gateway, board, view);
    assertReadCurrent();
    // Roster membership and facets remain invocation-bound; only equal authorized inputs share work.
    const key = JSON.stringify([id, view, [...sessions.values()], people]);
    const cacheable = params.store.sessionsRevision === admittedRevision;
    let projection = cacheable ? projections.get(key) : undefined;
    if (projection && projection.expires < now()) {
      projections.delete(key);
      projection = undefined;
    }
    const joined = Boolean(projection);
    if (!projection) {
      const prepared = {
        expires: Infinity,
        read: project(board, sessions, people, admittedRevision, caller).then(
          ({ snapshot: result, complete }) => {
            const maxAge = (board.sessions.scope?.maxAgeHours ?? 72) * 3_600_000;
            prepared.expires = result.sessions.reduce(
              (expires, row) => Math.min(expires, row.lastActivityAt + maxAge),
              Infinity,
            );
            const snapshot = {
              ...result,
              revision: { ...admittedRevision, boardId: id, scope: randomUUID() },
            };
            freezeCardList(snapshot);
            return { snapshot, complete };
          },
        ),
      };
      // Bound arbitrary filters and aging roster windows; eviction only causes a cold read.
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
      // Complete an admitted read under its captured revision even during continuous churn.
      // Retire incomplete and superseded work rather than retrying until writers become idle.
      if (
        (!complete || params.store.sessionsRevision !== admittedRevision) &&
        projections.get(key) === projection
      ) {
        projections.delete(key);
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
  };
  const cancel = () => {
    stopped = true;
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
    }
    timer = undefined;
    lastKnown.clear();
    boards.clear();
    projections.clear();
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
      const board = await params.store.getSessionsBoard(id);
      if (!board.sessions.columns.some((column) => column.id === columnId)) {
        throw new Error("Unknown Sessions board column.");
      }
      const { sessions: visible } = await listSessions(params.gateway, board);
      if (!visible.has(sessionKey)) {
        throw new Error("Session is not available in this board's scope.");
      }
      const result = await params.gateway.readSessionFacts({ sessionKeys: [sessionKey] });
      const facts = result.sessions.find(
        (entry) =>
          entry.key === sessionKey &&
          entry.sessionId === visible.get(sessionKey)?.sessionId &&
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
