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
  read: (boardId: string, view?: WorkboardSessionsBoardView) => Promise<WorkboardSessionsBoardRead>;
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
type CachedFacts = { sessionId: string; facts: WorkboardSessionFacts; readAt: number };
const FACTS_MAX_AGE_MS = 10 * 60_000;
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
        offset,
        configuredAgentsOnly: true,
        includeGlobal: false,
        includeUnknown: false,
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
  const cache = new Map<string, CachedFacts>();
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
  const unsubscribe = params.gateway.subscribeSessionChanges(({ sessionKey }) => {
    const previous = cache.get(sessionKey);
    if (stopped || !hasRead) {
      return;
    }
    // Retain last-known facts for failed reads, but invalidate both freshness and in-flight reads.
    if (previous) {
      cache.set(sessionKey, { ...previous, readAt: -Infinity });
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped && isCurrent()) {
        params.store.announceChangeEpoch();
      }
    }, 250);
    timer.unref?.();
  });
  const read = async (
    id: string,
    view?: WorkboardSessionsBoardView,
  ): Promise<WorkboardSessionsBoardRead> => {
    assertCurrent();
    const board = await params.store.getSessionsBoard(id);
    hasRead = true;
    const { sessions: roster, people } = await listSessions(params.gateway, board, view);
    assertCurrent();
    const missing = [...roster.values()].filter((row) => {
      const cached = cache.get(row.key);
      return (
        row.key !== board.sessions.agentSessionKey &&
        (!cached ||
          cached.sessionId !== row.sessionId ||
          now() - cached.readAt >= FACTS_MAX_AGE_MS ||
          cached.facts.pullRequestsUnavailable)
      );
    });
    const unavailable = new Set<string>();
    const reasons = new Set<string>();
    // Results belong to this caller's roster; omitted facts are not permission to reuse old data.
    const omitted = new Set<string>();
    for (let offset = 0; offset < missing.length; offset += FACTS_BATCH_SIZE) {
      const batch = missing.slice(offset, offset + FACTS_BATCH_SIZE);
      const before = new Map(batch.map((row) => [row.key, cache.get(row.key)]));
      try {
        const result = await params.gateway.readSessionFacts({
          sessionKeys: batch.map((row) => row.key),
        });
        assertCurrent();
        const returned = new Map(result.sessions.map((facts) => [facts.key, facts]));
        for (const row of batch) {
          const facts = returned.get(row.key);
          if (!facts || facts.sessionId !== row.sessionId) {
            omitted.add(row.key);
            if (cache.get(row.key) === before.get(row.key)) {
              cache.delete(row.key);
            }
          } else if (cache.get(row.key) === before.get(row.key)) {
            cache.set(row.key, { sessionId: facts.sessionId, facts, readAt: now() });
          }
        }
      } catch (error) {
        assertCurrent();
        for (const row of batch) {
          unavailable.add(row.key);
        }
        reasons.add(redactToolPayloadText(String(error)).replace(/\s+/g, " ").slice(0, 300));
      }
    }
    const placements = new Map(
      (await params.store.listSessionPlacements(id)).map((entry) => [entry.sessionKey, entry]),
    );
    assertCurrent();
    const fallback = sessionsBoardFallback(board);
    const sessions: WorkboardSessionsBoardRead["sessions"] = [];
    for (const row of roster.values()) {
      if (omitted.has(row.key)) {
        continue;
      }
      const cached = cache.get(row.key);
      const known = cached?.sessionId === row.sessionId ? cached.facts : undefined;
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
          : !known
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
      warnings.push("Some pull-request information is unavailable. Refresh to retry.");
    }
    return {
      board,
      columns: board.sessions.columns,
      sessions,
      ...(people !== undefined ? { people } : {}),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  };
  const cancel = () => {
    stopped = true;
    unsubscribe();
    if (timer) {
      clearTimeout(timer);
    }
    timer = undefined;
    cache.clear();
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
      return await read(id);
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
    reload: { configPrefixes: ["agents", "plugins"] },
    async start(context) {
      const state = activeState();
      await state.owner?.stop();
      state.owner = undefined;
      const repaired = await params.store.repairSessionPlacements();
      if (repaired) {
        context.logger.info(`Sessions board removed ${repaired} non-operator placements.`);
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
    read: (id, view) => current().read(id, view),
    update: (id, patch, caller) => current().update(id, patch, caller),
    move: (id, key, column, caller) => current().move(id, key, column, caller),
  };
}
