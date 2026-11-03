import type { UsersSelfResult } from "@openclaw/gateway-protocol";
import type {
  WorkboardBoardSummary,
  WorkboardSessionsBoardRead,
  WorkboardSessionsBoardRevision,
  WorkboardSessionsBoardView,
} from "@openclaw/workboard-contract";
import type { ControlUiHost, ControlUiSession } from "openclaw/plugin-sdk/control-ui";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { normalizeWorkboardChange } from "../../lib/workboard/change-payload.ts";

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
  let revision: WorkboardSessionsBoardRevision | undefined;
  let error: string | undefined;
  let busy = false;
  let draggedKey: string | undefined;
  let dropColumn: string | undefined;
  let peopleFilter = "everyone";
  let viewerProfileId: string | undefined;
  let gatewayId: string | undefined;
  let identityLoad: Promise<{ gatewayId?: string; viewerProfileId?: string }> | undefined;
  let restoredBoardId: string | undefined;
  const invalidate = () => {
    generation += 1;
    pending = undefined;
    revision = undefined;
  };
  const storageKey = (id: string) =>
    gatewayId && viewerProfileId
      ? `openclaw.workboard.sessions.people:${JSON.stringify([gatewayId, viewerProfileId, id])}`
      : undefined;
  // The preference scope follows the live connection: a reconnect within one mount may
  // belong to another viewer or Gateway, so identity reloads whenever the view activates.
  const resetIdentity = () => {
    identityLoad = undefined;
    gatewayId = undefined;
    viewerProfileId = undefined;
    restoredBoardId = undefined;
  };
  const loadIdentity = () =>
    (identityLoad ??= Promise.allSettled([
      host.request<{ deviceId: string }>("gateway.identity.get", {}),
      host.request<UsersSelfResult>("users.self", {}),
    ]).then(([gateway, viewer]) => ({
      gatewayId: gateway.status === "fulfilled" ? gateway.value.deviceId : undefined,
      viewerProfileId: viewer.status === "fulfilled" ? viewer.value.profile.id : undefined,
    })));
  const restoreFilter = (id: string) => {
    if (restoredBoardId === id) {
      return;
    }
    restoredBoardId = id;
    peopleFilter = "everyone";
    try {
      const key = storageKey(id);
      const saved = key ? localStorage.getItem(key) : null;
      if (saved === "me" || (saved?.startsWith("profile:") && saved.length > 8)) {
        peopleFilter = saved;
      }
    } catch {
      // Browser storage is optional; the current view remains usable without it.
    }
  };
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

  const read = async (more = false): Promise<boolean> => {
    if (!active || !boardId) {
      return false;
    }
    if (pending) {
      return pending;
    }
    if (more && !snapshot?.nextCursor) {
      return false;
    }
    const id = boardId;
    const receipt = generation;
    const previous = snapshot;
    attempted = true;
    const load = (async () => {
      try {
        const identity = await loadIdentity();
        if (!current(id, receipt)) {
          return false;
        }
        gatewayId = identity.gatewayId;
        viewerProfileId = identity.viewerProfileId;
        restoreFilter(id);
        const view: WorkboardSessionsBoardView = {
          includePeople: true,
          ...(peopleFilter === "me" ? { involvingMe: true } : {}),
          ...(peopleFilter.startsWith("profile:")
            ? { involvingProfileId: peopleFilter.slice(8) }
            : {}),
        };
        const result = await host.request<
          | (WorkboardSessionsBoardRead & { revision: WorkboardSessionsBoardRevision })
          | { unchanged: true; revision: WorkboardSessionsBoardRevision }
        >("workboard.sessionsBoard.read", {
          boardId: id,
          view,
          ...(more ? { after: previous?.nextCursor } : revision ? { sinceRevision: revision } : {}),
        });
        if (!current(id, receipt)) {
          return false;
        }
        if (!("unchanged" in result)) {
          let page = result;
          const sessions = new Map(
            (more ? (previous?.sessions ?? []) : []).map((session) => [session.key, session]),
          );
          for (const session of page.sessions) {
            sessions.set(session.key, session);
          }
          // A refresh restores the loaded window, while Load more requests just one page.
          if (!more) {
            while (page.nextCursor && sessions.size < (previous?.sessions.length ?? 0)) {
              page = await host.request<
                WorkboardSessionsBoardRead & { revision: WorkboardSessionsBoardRevision }
              >("workboard.sessionsBoard.read", { boardId: id, view, after: page.nextCursor });
              if (!current(id, receipt)) {
                return false;
              }
              for (const session of page.sessions) {
                sessions.set(session.key, session);
              }
            }
          }
          snapshot = { ...result, sessions: [...sessions.values()], nextCursor: page.nextCursor };
        }
        if (!more) {
          revision = result.revision;
        }
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
    invalidate();
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
    hasCurrent(payload: unknown) {
      const change = normalizeWorkboardChange(payload);
      return Boolean(
        active &&
        boardId &&
        change &&
        revision &&
        change.epoch === revision.epoch &&
        change.sessionsRevision === revision.revision,
      );
    },
    get snapshot() {
      return snapshot;
    },
    get peopleFilter() {
      return peopleFilter;
    },
    get viewerProfileId() {
      return viewerProfileId;
    },
    selectPeople(value: string) {
      if (!boardId || !active || busy || value === peopleFilter) {
        return;
      }
      peopleFilter = value;
      try {
        const key = storageKey(boardId);
        if (key) {
          localStorage.setItem(key, value);
        }
      } catch {
        // Keep the selection for this mounted view if storage is unavailable.
      }
      invalidate();
      snapshot = snapshot ? { ...snapshot, sessions: [], nextCursor: undefined } : undefined;
      error = undefined;
      void read();
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
        invalidate();
        attempted = false;
        busy = false;
        draggedKey = undefined;
        dropColumn = undefined;
        if (boardId !== nextId) {
          restoredBoardId = undefined;
          peopleFilter = "everyone";
          snapshot = undefined;
          error = undefined;
        }
        if (enabled && !active) {
          resetIdentity();
          peopleFilter = "everyone";
        }
        boardId = nextId;
        active = enabled;
      }
      if (active && boardId && !attempted) {
        void read();
      }
    },
    read: () => read(),
    loadMore: () => read(true),
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
        if (sessionKey) {
          const { session } = await host.request<{ session: ControlUiSession | null }>(
            "sessions.describe",
            { key: sessionKey },
          );
          if (!current(id, receipt) || !writable()) {
            return;
          }
          agentId = session?.agentId ?? agentId;
          if (!session?.isDock) {
            sessionKey = undefined;
          }
        }
        if (!sessionKey) {
          if (createdConversation?.boardId === id) {
            ({ sessionKey, agentId } = createdConversation);
          } else {
            if (!agentId) {
              throw new Error(t("workboard.sessionsBoard.agentUnavailable"));
            }
            sessionKey =
              (await host.sessions.create({
                agentId,
                displayName: label,
                surface: "plugin-dock",
              })) ?? undefined;
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
      invalidate();
    },
  };
}

export type SessionsBoardController = ReturnType<typeof createSessionsBoardController>;
