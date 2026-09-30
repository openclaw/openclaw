import type {
  WorkboardBoardSummary,
  WorkboardSessionsBoardRead,
} from "@openclaw/workboard-contract";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";

/** Optional host contract supplied by the shared page dock owner. */
type BoardDockHost = ControlUiHost & {
  dock?: {
    openSession: (params: {
      sessionKey: string;
      agentId: string;
      label: string;
      context?: { page: string; detail?: Readonly<Record<string, string>> };
    }) => void;
    close: () => void;
    readonly openSessionKey: string | null;
  };
};

export function createSessionsBoardController(host: BoardDockHost, notify: () => void) {
  let boardId: string | undefined;
  let active = false;
  let generation = 0;
  let attempted = false;
  let pending: Promise<boolean> | undefined;
  let snapshot: WorkboardSessionsBoardRead | undefined;
  let error: string | undefined;
  let busy = false;
  let draggedKey: string | undefined;
  let dropColumn: string | undefined;
  // Retain the created conversation if saving its reference fails, so Retry never creates a duplicate.
  let createdConversation: { boardId: string; sessionKey: string; agentId: string } | undefined;
  const current = (id: string, receipt: number) =>
    active &&
    host.connection.connected &&
    boardId === id &&
    receipt === generation &&
    !host.signal.aborted;
  const writable = () =>
    active && host.connection.connected && host.connection.canWrite && !host.signal.aborted;

  const read = async (): Promise<boolean> => {
    if (!active || !boardId) {
      return false;
    }
    if (pending) {
      return pending;
    }
    const id = boardId;
    const receipt = generation;
    attempted = true;
    const load = (async () => {
      try {
        const result = await host.request<WorkboardSessionsBoardRead>(
          "workboard.sessionsBoard.read",
          { boardId: id },
        );
        if (!current(id, receipt)) {
          return false;
        }
        snapshot = result;
        error = undefined;
        return true;
      } catch (cause) {
        if (current(id, receipt)) {
          error = formatUiError(cause);
        }
        return false;
      }
    })();
    pending = load;
    notify();
    try {
      return await load;
    } finally {
      if (pending === load) {
        pending = undefined;
      }
      notify();
    }
  };

  const write = async (operation: (id: string, receipt: number) => Promise<void>) => {
    if (!boardId || !writable() || busy) {
      return;
    }
    const id = boardId;
    const receipt = generation;
    busy = true;
    error = undefined;
    notify();
    try {
      await operation(id, receipt);
      if (pending) {
        await pending;
      }
      if (current(id, receipt)) {
        await read();
      }
    } catch (cause) {
      if (current(id, receipt)) {
        error = formatUiError(cause);
      }
    } finally {
      if (current(id, receipt)) {
        busy = false;
      }
      notify();
    }
  };

  return {
    get snapshot() {
      return snapshot;
    },
    get error() {
      return error;
    },
    get loading() {
      return Boolean(pending);
    },
    get busy() {
      return busy;
    },
    get draggedKey() {
      return draggedKey;
    },
    get dropColumn() {
      return dropColumn;
    },
    get hasDock() {
      return Boolean(host.dock);
    },
    sync(board: WorkboardBoardSummary | undefined | null, enabled: boolean) {
      const nextId = board?.kind === "sessions" ? board.id : undefined;
      if (boardId !== nextId || active !== enabled) {
        generation += 1;
        pending = undefined;
        attempted = false;
        busy = false;
        draggedKey = undefined;
        dropColumn = undefined;
        if (boardId !== nextId) {
          snapshot = undefined;
          error = undefined;
        }
        boardId = nextId;
        active = enabled;
      }
      if (active && boardId && !attempted) {
        void read();
      }
    },
    read,
    refresh: () =>
      write(async (id) => {
        await host.request("workboard.sessionsBoard.refresh", { boardId: id });
      }),
    move: (sessionKey: string, columnId: string) =>
      write(async (id) => {
        await host.request("workboard.sessionsBoard.move", { boardId: id, sessionKey, columnId });
      }),
    drag(sessionKey?: string, columnId?: string) {
      draggedKey = sessionKey;
      dropColumn = columnId;
      notify();
    },
    openAgent: () =>
      write(async (id, receipt) => {
        if (!host.dock || !snapshot?.board.sessions) {
          return;
        }
        const board = snapshot.board;
        const spec = board.sessions;
        const label = t("workboard.sessionsBoard.agentLabel", { name: board.name || id });
        let sessionKey = spec.agentSessionKey;
        let agentId = sessionKey
          ? (host.sessions.rows.find((session) => session.key === sessionKey)?.agentId ??
            snapshot.sessions.find((session) => session.key === sessionKey)?.agentId ??
            host.agents.rows.find((agent) => sessionKey?.startsWith(`agent:${agent.id}:`))?.id)
          : (spec.scope?.agentIds?.[0] ??
            host.agents.scopeId ??
            host.agents.selectedId ??
            host.agents.defaultId ??
            host.connection.assistantAgentId ??
            undefined);
        if (!sessionKey) {
          if (createdConversation?.boardId === id) {
            ({ sessionKey, agentId } = createdConversation);
          } else {
            if (!agentId) {
              throw new Error(t("workboard.sessionsBoard.agentUnavailable"));
            }
            sessionKey = (await host.sessions.create({ agentId, label })) ?? undefined;
            if (!sessionKey) {
              throw new Error(t("workboard.sessionsBoard.agentCreateFailed"));
            }
            createdConversation = { boardId: id, sessionKey, agentId };
          }
          if (!current(id, receipt) || !writable()) {
            return;
          }
          await host.request("workboard.sessionsBoard.update", {
            boardId: id,
            patch: { agentSessionKey: sessionKey },
          });
          if (current(id, receipt) && snapshot) {
            snapshot = {
              ...snapshot,
              board: { ...board, sessions: { ...spec, agentSessionKey: sessionKey } },
            };
            createdConversation = undefined;
          }
        }
        if (!current(id, receipt) || !writable()) {
          return;
        }
        if (!agentId) {
          throw new Error(t("workboard.sessionsBoard.agentUnavailable"));
        }
        host.dock.openSession({
          sessionKey,
          agentId,
          label,
          context: { page: "workboard", detail: { boardId: id } },
        });
      }),
    dispose() {
      active = false;
      generation += 1;
      pending = undefined;
    },
  };
}

export type SessionsBoardController = ReturnType<typeof createSessionsBoardController>;
