import { AsyncLocalStorage } from "node:async_hooks";
import type {
  WorkboardSessionFacts,
  WorkboardSessionPlacement,
  WorkboardSessionsBoard,
  WorkboardSessionsBoardRead,
} from "@openclaw/workboard-contract";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi, OpenClawPluginService } from "../api.js";
import {
  parseSessionPlacements,
  sessionFactsHash,
  sessionMatchesColumn,
  sessionsBoardFallback,
  sessionsBoardSpecHash,
  SESSIONS_BOARD_BATCH_SIZE,
  SESSIONS_BOARD_MODEL_BATCH_SIZE,
  SESSIONS_BOARD_MODEL_INTERVAL_MS,
} from "./sessions-board-classification.js";
import {
  createSessionsBoardCompletion,
  type SessionsBoardCompletionInput,
} from "./sessions-board-model.js";
import type { WorkboardStore } from "./store.js";

type Gateway = Pick<
  OpenClawPluginApi["runtime"]["gateway"],
  "request" | "readSessionFacts" | "isAvailable"
>;
type SessionsBoardServiceParams = {
  store: WorkboardStore;
  gateway: Gateway;
  getConfig?: () => OpenClawConfig;
  complete?: (input: SessionsBoardCompletionInput) => Promise<string>;
  now?: () => number;
};
type BoardState = {
  facts: WorkboardSessionFacts[];
  checkedAt: number;
  lastReadAt: number;
  specHash?: string;
  warning?: string;
  failed: boolean;
  classifiedAt?: number;
  lastModelAt: number;
  forceRequested: boolean;
  forced: Set<string>;
  modelQueue: string[];
  again: boolean;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};
type CallerAuthority = { assertCurrent: () => void };
type Operations = {
  read: (boardId: string) => Promise<WorkboardSessionsBoardRead>;
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
  refresh: (boardId: string, caller?: CallerAuthority) => Promise<WorkboardSessionsBoardRead>;
  /** Reclassify every active Sessions board, or only boards read within `viewedWithinMs`. */
  sweep: (options?: { viewedWithinMs?: number }) => Promise<void>;
};
export type WorkboardSessionsBoardService = OpenClawPluginService &
  Operations & { stop: () => Promise<void> };
type Owner = Operations & { cancel: () => void; stop: () => Promise<void> };

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
async function listSessions(gateway: Gateway, board: WorkboardSessionsBoard) {
  const sessions = new Map<string, string>();
  let offset = 0;
  for (;;) {
    const payload = await gateway.request(
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
      },
      { scopes: ["operator.read"] },
    );
    if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
      throw new Error("sessions.list returned an invalid Sessions board roster.");
    }
    for (const session of payload.sessions) {
      if (
        isRecord(session) &&
        typeof session.key === "string" &&
        typeof session.sessionId === "string"
      ) {
        sessions.set(session.key, session.sessionId);
      }
    }
    if (payload.hasMore !== true) {
      return sessions;
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
  const runAsService = AsyncLocalStorage.snapshot();
  const lifetime = new AbortController();
  const boards = new Map<string, BoardState>();
  const now = params.now ?? Date.now;
  const complete = params.complete ?? createSessionsBoardCompletion();
  const assertCurrent = () => {
    lifetime.signal.throwIfAborted();
    if (!isCurrent()) {
      throw new Error("Sessions board service is no longer active.");
    }
  };
  const interactiveAuthority = (caller?: CallerAuthority) => () => {
    assertCurrent();
    caller?.assertCurrent();
  };
  const stateFor = (id: string): BoardState => {
    let state = boards.get(id);
    if (!state) {
      state = {
        facts: [],
        checkedAt: -Infinity,
        lastReadAt: -Infinity,
        lastModelAt: -Infinity,
        failed: false,
        forceRequested: false,
        forced: new Set(),
        modelQueue: [],
        again: false,
      };
      boards.set(id, state);
    }
    return state;
  };
  const deferModel = (id: string, state: BoardState) => {
    if (state.timer || lifetime.signal.aborted) {
      return;
    }
    state.timer = setTimeout(
      () => {
        state.timer = undefined;
        void schedule(id);
      },
      Math.max(0, state.lastModelAt + SESSIONS_BOARD_MODEL_INTERVAL_MS - now()),
    );
    state.timer.unref?.();
  };
  const classify = async (id: string, state: BoardState) => {
    assertCurrent();
    const board = await params.store.getSessionsBoard(id);
    const roster = await listSessions(params.gateway, board);
    const facts: WorkboardSessionFacts[] = [];
    const keys = [...roster.keys()];
    for (let offset = 0; offset < keys.length; offset += SESSIONS_BOARD_BATCH_SIZE) {
      assertCurrent();
      const result = await params.gateway.readSessionFacts({
        sessionKeys: keys.slice(offset, offset + SESSIONS_BOARD_BATCH_SIZE),
      });
      facts.push(
        ...result.sessions.filter(
          (session) =>
            roster.get(session.key) === session.sessionId && inScope(session, board, now()),
        ),
      );
    }
    assertCurrent();
    const previousFacts = state.facts.map(sessionFactsHash).join(":");
    const previousWarning = state.warning;
    state.facts = facts;
    state.checkedAt = now();
    state.specHash = sessionsBoardSpecHash(board);
    const prWarning = facts.some((session) => session.pullRequestsUnavailable)
      ? "Some pull-request information is unavailable. Refresh to retry."
      : undefined;
    if (state.forceRequested) {
      for (const session of facts) {
        state.forced.add(session.key);
      }
      state.forceRequested = false;
    }
    const present = new Set(keys);
    for (const key of state.forced) {
      if (!present.has(key)) {
        state.forced.delete(key);
      }
    }
    let cached = new Map(
      (await params.store.listSessionPlacements(id)).map((entry) => [entry.sessionKey, entry]),
    );
    const columns = new Set(board.sessions.columns.map((column) => column.id));
    const fallback = sessionsBoardFallback(board);
    const writes: Array<WorkboardSessionPlacement & { expectedUpdatedAt?: number }> = [];
    const needsModel: WorkboardSessionFacts[] = [];
    for (const session of facts) {
      const old = cached.get(session.key);
      const factsHash = sessionFactsHash(session);
      const cacheHash = `${state.specHash}:${factsHash}`;
      if (
        old?.source === "operator" &&
        old.factsHash.endsWith(`:${factsHash}`) &&
        columns.has(old.columnId)
      ) {
        state.forced.delete(session.key);
        continue;
      }
      if (
        !state.forced.has(session.key) &&
        old?.factsHash === cacheHash &&
        columns.has(old.columnId)
      ) {
        continue;
      }
      const column = !board.sessions.instructions?.trim()
        ? board.sessions.columns.find((entry) => sessionMatchesColumn(session, entry))
        : undefined;
      if (column) {
        writes.push({
          sessionKey: session.key,
          columnId: column.id,
          source: "state",
          reason: "Matched column rules",
          factsHash: cacheHash,
          updatedAt: now(),
          expectedUpdatedAt: old?.updatedAt,
        });
        state.forced.delete(session.key);
      } else {
        needsModel.push(session);
        // A changed fact retires a pin immediately. Keep its position while inference retries.
        if (!old || old.source === "operator" || !columns.has(old.columnId)) {
          writes.push({
            sessionKey: session.key,
            columnId: old && columns.has(old.columnId) ? old.columnId : fallback.id,
            source: "state",
            reason: "unresolved",
            factsHash: `pending:${factsHash}`,
            updatedAt: now(),
            expectedUpdatedAt: old?.updatedAt,
          });
        }
      }
    }
    try {
      if (writes.length) {
        if (
          !(await params.store.writeSessionPlacements(id, writes, {
            expectedSpec: board.sessions,
            assertCurrent,
          }))
        ) {
          state.again = true;
          return;
        }
        cached = new Map(
          (await params.store.listSessionPlacements(id)).map((entry) => [entry.sessionKey, entry]),
        );
        state.classifiedAt = now();
      }
      if (!needsModel.length) {
        state.modelQueue = [];
        state.failed = false;
        state.warning = prWarning;
        return;
      }
      if (now() < state.lastModelAt + SESSIONS_BOARD_MODEL_INTERVAL_MS) {
        deferModel(id, state);
        return;
      }
      const queued = new Map(state.modelQueue.map((key, index) => [key, index]));
      needsModel.sort(
        (left, right) =>
          (queued.get(left.key) ?? queued.size) - (queued.get(right.key) ?? queued.size),
      );
      const batch = needsModel.slice(0, SESSIONS_BOARD_MODEL_BATCH_SIZE);
      // Repeatedly changing runs return to the tail instead of starving later sessions.
      state.modelQueue = [...needsModel.slice(batch.length), ...batch].map(
        (session) => session.key,
      );
      const cfg = params.getConfig?.() ?? context.config;
      const agentId = board.orchestration?.defaultAssignee ?? resolveDefaultAgentId(cfg);
      state.lastModelAt = now();
      const output = parseSessionPlacements(
        await complete({
          board,
          sessions: batch,
          cfg,
          agentId,
          signal: lifetime.signal,
          assertCurrent,
        }),
        board,
        batch,
      );
      assertCurrent();
      const modelWrites = batch.map(
        (session): WorkboardSessionPlacement & { expectedUpdatedAt?: number } => {
          const result = output.get(session.key) ?? { columnId: fallback.id, reason: "unresolved" };
          return {
            sessionKey: session.key,
            ...result,
            source: "model",
            factsHash: `${state.specHash}:${sessionFactsHash(session)}`,
            updatedAt: now(),
            expectedUpdatedAt: cached.get(session.key)?.updatedAt,
          };
        },
      );
      if (
        !(await params.store.writeSessionPlacements(id, modelWrites, {
          expectedSpec: board.sessions,
          assertCurrent,
        }))
      ) {
        state.again = true;
        return;
      }
      for (const session of batch) {
        state.forced.delete(session.key);
      }
      state.classifiedAt = now();
      state.failed = false;
      state.warning = prWarning;
      if (needsModel.length > batch.length) {
        deferModel(id, state);
      }
    } catch (error) {
      assertCurrent();
      state.warning =
        "Utility-model classification is unavailable. Previous placements are retained; check the agent's utility model and refresh.";
      if (!state.failed) {
        context.logger.warn(
          `Sessions board ${id} classification failed: ${redactToolPayloadText(String(error)).slice(0, 300)}`,
        );
      }
      state.failed = true;
    } finally {
      if (
        isCurrent() &&
        !lifetime.signal.aborted &&
        (previousWarning !== state.warning ||
          previousFacts !== facts.map(sessionFactsHash).join(":"))
      ) {
        params.store.announceChangeEpoch();
      }
    }
  };
  const schedule = (id: string, force = false): Promise<void> =>
    runAsService(() => {
      if (lifetime.signal.aborted || !isCurrent()) {
        return Promise.resolve();
      }
      const state = stateFor(id);
      state.forceRequested ||= force;
      if (state.pending) {
        state.again = true;
        return state.pending;
      }
      const pending = params.store
        .runOperation(() => classify(id, state))
        .catch((error: unknown) => {
          if (!isCurrent() || lifetime.signal.aborted) {
            return;
          }
          state.warning = "Session facts are unavailable. Refresh to retry.";
          if (!state.failed) {
            context.logger.warn(
              `Sessions board ${id} refresh failed: ${redactToolPayloadText(String(error)).slice(0, 300)}`,
            );
          }
          state.failed = true;
          state.checkedAt = now();
          params.store.announceChangeEpoch();
        })
        .finally(() => {
          if (state.pending === pending) {
            state.pending = undefined;
          }
          if (state.again && isCurrent() && !lifetime.signal.aborted) {
            state.again = false;
            void schedule(id);
          }
        });
      state.pending = pending;
      return pending;
    });
  const read = async (id: string): Promise<WorkboardSessionsBoardRead> => {
    assertCurrent();
    const board = await params.store.getSessionsBoard(id);
    const state = stateFor(id);
    state.lastReadAt = now();
    if (state.specHash !== sessionsBoardSpecHash(board) || now() - state.checkedAt >= 60_000) {
      void schedule(id);
    }
    // Foreground authorization stays in the requesting operator/tool scope, not the service scope.
    const visible = await listSessions(params.gateway, board);
    const placements = new Map(
      (await params.store.listSessionPlacements(id)).map((entry) => [entry.sessionKey, entry]),
    );
    assertCurrent();
    const fallback = sessionsBoardFallback(board);
    const sessions: WorkboardSessionsBoardRead["sessions"] = [];
    for (const facts of state.facts) {
      if (visible.get(facts.key) !== facts.sessionId || !inScope(facts, board, now())) {
        continue;
      }
      const placement = placements.get(facts.key);
      const valid =
        placement && board.sessions.columns.some((column) => column.id === placement.columnId);
      sessions.push({
        ...facts,
        columnId: valid ? placement.columnId : fallback.id,
        source: valid ? placement.source : "state",
        reason: valid ? placement.reason : "unresolved",
      });
    }
    return {
      board,
      columns: board.sessions.columns,
      sessions,
      ...(state.warning ? { warning: state.warning } : {}),
      ...(state.classifiedAt !== undefined ? { classifiedAt: state.classifiedAt } : {}),
    };
  };
  const cancel = () => {
    lifetime.abort();
    for (const state of boards.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
    }
  };
  return {
    read,
    cancel,
    async stop() {
      cancel();
      await Promise.allSettled(
        [...boards.values()].flatMap((state) => (state.pending ? [state.pending] : [])),
      );
      boards.clear();
    },
    async update(id, patch, caller) {
      const assertWriteCurrent = interactiveAuthority(caller);
      assertWriteCurrent();
      const board = await params.store.updateSessionsBoard(id, patch, assertWriteCurrent);
      void schedule(id);
      return board;
    },
    async move(id, sessionKey, columnId, caller) {
      const assertWriteCurrent = interactiveAuthority(caller);
      assertWriteCurrent();
      const board = await params.store.getSessionsBoard(id);
      if (!board.sessions.columns.some((column) => column.id === columnId)) {
        throw new Error("Unknown Sessions board column.");
      }
      const visible = await listSessions(params.gateway, board);
      if (!visible.has(sessionKey)) {
        throw new Error("Session is not available in this board's scope.");
      }
      const result = await params.gateway.readSessionFacts({ sessionKeys: [sessionKey] });
      const facts = result.sessions.find(
        (entry) =>
          entry.key === sessionKey &&
          entry.sessionId === visible.get(sessionKey) &&
          inScope(entry, board, now()),
      );
      if (!facts) {
        throw new Error("Session is not available in this board's scope.");
      }
      const previous = (await params.store.listSessionPlacements(id)).find(
        (entry) => entry.sessionKey === sessionKey,
      );
      if (
        !(await params.store.writeSessionPlacements(
          id,
          [
            {
              sessionKey,
              columnId,
              source: "operator",
              reason: "Moved by operator",
              factsHash: `${sessionsBoardSpecHash(board)}:${sessionFactsHash(facts)}`,
              updatedAt: now(),
              expectedUpdatedAt: previous?.updatedAt,
            },
          ],
          { expectedSpec: board.sessions, assertCurrent: assertWriteCurrent },
        ))
      ) {
        throw new Error("Sessions board changed. Refresh and retry the move.");
      }
      const state = stateFor(id);
      state.facts = [...state.facts.filter((entry) => entry.key !== sessionKey), facts];
      return await read(id);
    },
    async refresh(id, caller) {
      await params.store.getSessionsBoard(id);
      interactiveAuthority(caller)();
      void schedule(id, true);
      return await read(id);
    },
    sweep: (options) =>
      runAsService(async () => {
        if (lifetime.signal.aborted || !isCurrent() || !(await params.gateway.isAvailable())) {
          return;
        }
        const current = (await params.store.listBoards()).boards.filter(
          (board) => board.kind === "sessions" && !board.archivedAt,
        );
        const ids = new Set(current.map((board) => board.id));
        for (const [id, state] of boards) {
          if (!ids.has(id) && !state.pending) {
            if (state.timer) {
              clearTimeout(state.timer);
            }
            boards.delete(id);
          }
        }
        const viewedWithinMs = options?.viewedWithinMs;
        await Promise.all(
          current
            .filter(
              (board) =>
                viewedWithinMs === undefined ||
                now() - stateFor(board.id).lastReadAt <= viewedWithinMs,
            )
            .map((board) => schedule(board.id)),
        );
      }),
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
    reload: { configPrefixes: ["agents", "models", "auth", "plugins"] },
    async start(context) {
      const state = activeState();
      await state.owner?.stop();
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
    read: (id) => current().read(id),
    update: (id, patch, caller) => current().update(id, patch, caller),
    move: (id, key, column, caller) => current().move(id, key, column, caller),
    refresh: (id, caller) => current().refresh(id, caller),
    sweep: (options) => activeState().owner?.sweep(options) ?? Promise.resolve(),
  };
}
