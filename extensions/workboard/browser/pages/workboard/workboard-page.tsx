/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSignal, Show } from "solid-js";
import { AgentPicker } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { WorkboardBoardGlyph } from "../../components/workboard-board-glyph.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { workboardCardBoardId } from "../../lib/workboard/board-filter.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";
import { workboardCardSessionKey } from "../../lib/workboard/card-state.ts";
import {
  configureWorkboardLiveRefresh,
  handleWorkboardChanged,
  loadWorkboard,
  refreshWorkboard,
  resetDraftState,
  resumeWorkboardLiveRefresh,
  resetWorkboardConnectionState,
  stopWorkboardLiveRefresh,
  type WorkboardCard,
  type WorkboardUiState,
  WORKBOARD_CHANGED_EVENT,
} from "../../lib/workboard/index.ts";
import { invalidateWorkboardLoads } from "../../lib/workboard/runtime.ts";
import { createWorkboardSessionResolver } from "../../lib/workboard/session-resolution.ts";
import type { WorkboardBoardMetadata } from "../../lib/workboard/types.ts";
import {
  buildAgentFilterOptions,
  normalizeActiveAgentFilter,
  matchesAgentScope,
} from "./agent-filter.ts";
import { matchesBoardFilter, WORKBOARD_ALL_BOARDS_FILTER } from "./board-filter.ts";
import { workboardPageTarget } from "./page-target.ts";
import { createSessionsBoardController } from "./sessions-board-controller.ts";
import { loadBoardAutomation, BoardAutomationHeading } from "./view-automation.tsx";
import {
  createBoardDraft,
  createNewBoardDraft,
  BoardModal,
  type BoardDraft,
} from "./view-board-modal.tsx";
import { getVisibleDetailCard } from "./view-card-details.tsx";
import {
  workboardErrorMessage,
  type BoardAutomationState,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { reconcileSelectionScope } from "./view-selection.tsx";
import { SessionsBoard } from "./view-sessions-board.tsx";
import { WorkboardView } from "./view.tsx";

function reconcileCardOverlays(state: WorkboardUiState, visible: (card: WorkboardCard) => boolean) {
  const remainsVisible = (id: string) =>
    state.cards.some((card) => card.id === id && visible(card));
  if (state.detailCardId && !remainsVisible(state.detailCardId)) {
    state.detailCardId = null;
    state.detailCommentBody = "";
  }
  // Preserve submitted input for retry if the pending save fails.
  if (!state.draftSaving && state.editingCardId && !remainsVisible(state.editingCardId)) {
    resetDraftState(state);
  }
}

export function createWorkboardPage(
  workboard: WorkboardCapability,
  registerBoardNavigation: (board: WorkboardBoardMetadata) => void,
): ControlUiView {
  return (container, initialContext) => {
    const host = initialContext.host;
    let context = initialContext;
    let disposed = false;
    let boardDraft: BoardDraft | null = null;
    const automations = new Map<string, BoardAutomationState>();
    type PagePresentation = {
      workboardProps: WorkboardProps & { onRefresh: () => void };
      selectedBoard: (typeof state.boards)[number] | null | undefined;
      boards: typeof state.boards;
      boardDraft: BoardDraft | null;
      revision: number;
    };
    const [presentation, setPresentation] = createSignal<PagePresentation>();
    let revision = 0;
    let queued = false;
    let connected = false;
    let refreshActive = false;
    let metadataGeneration = 0;
    let navigationGeneration = 0;
    let metadataLoad: Promise<void> | null = null;
    // Card reloads cannot clear an unresolved agent/session metadata failure.
    let metadataError: string | null = null;
    let observedScope: string | null | undefined;
    let redirectedBoard = "";
    const client = host;
    const state = workboard.state;
    const requestUpdate = () => {
      if (disposed || queued) {
        return;
      }
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!disposed) {
          update();
        }
      });
    };
    const sessionResolver = createWorkboardSessionResolver(host, requestUpdate);
    const sessionsBoard = createSessionsBoardController(host, requestUpdate);
    const stop = () => {
      // A paused page no longer owns shared loads started by session actions.
      if (!refreshActive) {
        return;
      }
      refreshActive = false;
      stopWorkboardLiveRefresh(workboard);
      resetWorkboardConnectionState(workboard);
    };
    const refreshMetadata = () => {
      if (disposed || !connected) {
        return Promise.resolve();
      }
      if (metadataLoad) {
        return metadataLoad;
      }
      const generation = metadataGeneration;
      const load = host.agents
        .refresh()
        .then(() => {
          if (disposed || generation !== metadataGeneration) {
            return;
          }
          metadataError = null;
          requestUpdate();
        })
        .catch((error: unknown) => {
          if (disposed || generation !== metadataGeneration) {
            return;
          }
          metadataError = formatUiError(error);
          requestUpdate();
        })
        .finally(() => {
          if (metadataLoad === load) {
            metadataLoad = null;
          }
        });
      metadataLoad = load;
      return load;
    };
    const synchronizeConnection = () => {
      const nextConnected = host.connection.connected;
      if (connected === nextConnected) {
        return;
      }
      connected = nextConnected;
      metadataGeneration += 1;
      metadataLoad = null;
      if (connected) {
        void refreshMetadata();
      } else {
        sessionsBoard.sync(
          state.boards.find((board) => board.id === state.boardFilter),
          false,
        );
        stop();
      }
    };
    const update = () => {
      synchronizeConnection();
      const agents = host.agents.rows;
      const defaultId = host.agents.defaultId;
      const defaultAgentId = defaultId ?? host.connection.assistantAgentId;
      const agentsList = defaultId === null ? null : { defaultId, agents: [...agents] };
      const boardId =
        context.props.boardId || context.props.boardFilter || WORKBOARD_ALL_BOARDS_FILTER;
      const scope = host.agents.scopeId;
      if (observedScope !== scope) {
        observedScope = scope;
        state.agentFilter = "all";
        reconcileCardOverlays(state, (card) => matchesAgentScope(card, defaultAgentId, scope));
      }
      if (state.boardFilter !== boardId) {
        if (state.boards.find((board) => board.id === state.boardFilter)?.kind === "sessions") {
          state.loaded = false;
          state.loadAttempted = false;
        }
        state.boardFilter = boardId;
        reconcileCardOverlays(state, (card) => matchesBoardFilter(card, boardId));
      }
      if (
        context.presented &&
        boardId !== WORKBOARD_ALL_BOARDS_FILTER &&
        workboard.boardsReady &&
        !state.boards.some((board) => board.id === boardId)
      ) {
        if (redirectedBoard !== boardId) {
          redirectedBoard = boardId;
          host.navigation.openPage(workboardPageTarget(), {
            replace: true,
            preserveSearch: true,
          });
        }
      } else {
        redirectedBoard = "";
      }
      const selectedBoard =
        boardId === WORKBOARD_ALL_BOARDS_FILTER
          ? null
          : state.boards.find((board) => board.id === boardId);
      sessionsBoard.sync(selectedBoard, connected && context.presented);
      if (connected && context.presented) {
        refreshActive = true;
        const force = configureWorkboardLiveRefresh({
          host: workboard,
          client,
          requestUpdate,
          shouldDefer: () => Boolean(boardDraft || sessionsBoard.busy || sessionsBoard.draggedKey),
          refresh: selectedBoard?.kind === "sessions" ? sessionsBoard.read : undefined,
        });
        void loadWorkboard({
          host: workboard,
          client,
          requestUpdate,
          force,
          refreshDiagnostics: host.connection.canWrite && selectedBoard?.kind !== "sessions",
        });
        resumeWorkboardLiveRefresh(workboard);
      } else {
        stop();
      }
      const detailCard = getVisibleDetailCard(state);
      const detailJobId = detailCard
        ? state.boards.find((board) => board.id === workboardCardBoardId(detailCard))
            ?.automationJobId
        : undefined;
      const activeJobIds = new Set(
        connected && context.presented
          ? [selectedBoard?.automationJobId, detailJobId].filter((id) => typeof id === "string")
          : [],
      );
      for (const jobId of automations.keys()) {
        if (!activeJobIds.has(jobId)) {
          automations.delete(jobId);
        }
      }
      for (const jobId of activeJobIds) {
        if (automations.has(jobId)) {
          continue;
        }
        const pending: BoardAutomationState = { jobId, status: "loading" };
        automations.set(jobId, pending);
        void loadBoardAutomation(client, jobId).then((automation) => {
          if (disposed || automations.get(jobId) !== pending) {
            return;
          }
          automations.set(jobId, automation);
          requestUpdate();
        });
      }
      const focusedCard = state.draftOpen
        ? state.cards.find((card) => card.id === state.editingCardId)
        : getVisibleDetailCard(state);
      sessionResolver.sync(
        focusedCard ? workboardCardSessionKey(focusedCard) : undefined,
        connected && context.presented,
      );
      const sessionResolution = sessionResolver.resolution;
      const sessionError =
        sessionResolution && sessionResolution.status !== "resolved"
          ? sessionResolution.error
          : undefined;
      const pageError = [metadataError, sessionError].filter(Boolean).join("\n") || undefined;
      const candidates =
        sessionResolution?.status === "resolved"
          ? [sessionResolution.session]
          : (sessionResolution?.candidates ?? []);
      const sessions = [
        ...new Map(
          [...host.sessions.rows, ...candidates].map((session) => [session.key, session]),
        ).values(),
      ];
      const onNewBoard = () => {
        boardDraft = createNewBoardDraft();
        requestUpdate();
      };
      const onBoardChange = (boardFilter: string) =>
        host.navigation.openPage(workboardPageTarget(boardFilter), {
          replace: true,
          preserveSearch: true,
        });
      const workboardProps: WorkboardProps & { onRefresh: () => void } = {
        pageError,
        overlayOpen: Boolean(boardDraft),
        presented: context.presented,
        detailBoardAutomation: detailJobId ? automations.get(detailJobId) : undefined,
        host: workboard,
        client: connected ? client : null,
        connected,
        canWrite: host.connection.canWrite,
        canGrant: host.connection.canGrant,
        canModelOverride: host.connection.canAdmin,
        agentsList,
        defaultAgentId,
        sessions,
        sessionResolution,
        scopeAgentId: scope,
        onClearAgentScope: () => host.agents.setScope(null),
        showAgentFilter: false,
        onOpenSession: host.sessions.open,
        onRefresh: () => {
          automations.clear();
          void refreshMetadata();
          sessionResolver.refresh();
          void refreshWorkboard({
            host: workboard,
            client: connected ? client : null,
            requestUpdate,
            source: "manual",
            refreshDiagnostics: host.connection.canWrite,
          });
        },
        onBoardFilterChange: onBoardChange,
        onNewBoard,
        onRequestUpdate: requestUpdate,
      };
      state.agentFilter = normalizeActiveAgentFilter(
        buildAgentFilterOptions(agentsList, state.cards),
        state.agentFilter,
      );
      reconcileSelectionScope(workboardProps);
      setPresentation({
        workboardProps,
        selectedBoard,
        boards: state.boards,
        boardDraft,
        revision: ++revision,
      });
    };
    function PageHeading() {
      const board = () => presentation()?.selectedBoard;
      return (
        <div class="workboard-heading__identity">
          <div class="page-title workboard-page-title">
            <Show when={board()}>
              {(selected) => (
                <WorkboardBoardGlyph board={selected()} class="workboard-board-glyph--header" />
              )}
            </Show>
            <span>{board() ? workboardBoardName(board()!) : "Workboard"}</span>
            <Show when={board() && presentation()?.workboardProps.canWrite}>
              <button
                class="btn btn--icon workboard-board-edit"
                type="button"
                aria-label={t("workboard.editBoard")}
                title={t("workboard.editBoard")}
                onClick={() => {
                  const selected = board();
                  if (!selected) {
                    return;
                  }
                  boardDraft = createBoardDraft({
                    ...selected,
                    ...(sessionsBoard.snapshot?.board.id === selected.id
                      ? sessionsBoard.snapshot.board
                      : {}),
                  });
                  requestUpdate();
                }}
              >
                {icons.penLine}
              </button>
            </Show>
          </div>
          <Show when={board()?.automationJobId}>
            {(jobId) => (
              <BoardAutomationHeading
                automation={automations.get(jobId())}
                revision={presentation()?.revision}
              />
            )}
          </Show>
        </div>
      );
    }
    function ScopeControl() {
      const agents = () =>
        presentation()?.workboardProps.agentsList?.agents.filter(
          (agent) => agent.kind !== "system",
        ) ?? [];
      const scope = () => presentation()?.workboardProps.scopeAgentId;
      const missing = () => scope() && !agents().some((agent) => agent.id === scope());
      return (
        <Show when={agents().length > 1 || scope()}>
          <AgentPicker
            class="workboard-scope"
            options={[
              { value: "", label: t("workboard.allAgents"), icon: "users" },
              ...agents().map((agent) => ({
                value: agent.id,
                label: agent.name ?? agent.identity?.name ?? agent.id,
                agent,
              })),
              ...(missing() ? [{ value: scope()!, label: scope()!, agent: { id: scope()! } }] : []),
            ]}
            value={scope() ?? ""}
            variant="compact"
            accessibleLabel={t("workboard.agentFilter")}
            onSelect={(value) => host.agents.setScope(value || null)}
          />
        </Show>
      );
    }
    function Page() {
      const liveClient = () => {
        void presentation()?.revision;
        return host.connection.connected ? host : null;
      };
      const canWrite = () => {
        void presentation()?.revision;
        return (
          !disposed &&
          !context.signal.aborted &&
          host.connection.connected &&
          host.connection.canWrite
        );
      };
      return (
        <Show when={presentation()}>
          {(current) => (
            <>
              <Show
                when={current().selectedBoard?.kind === "sessions"}
                fallback={
                  <WorkboardView
                    {...current().workboardProps}
                    revision={current().revision}
                    heading={<PageHeading />}
                    scopeControl={() => <ScopeControl />}
                  />
                }
              >
                <SessionsBoard
                  board={current().selectedBoard!}
                  boards={current().boards}
                  controller={sessionsBoard}
                  host={host}
                  revision={current().revision}
                  heading={<PageHeading />}
                  scopeControl={<ScopeControl />}
                  pageError={current().workboardProps.pageError ?? undefined}
                  overlayOpen={Boolean(current().boardDraft)}
                  onNewBoard={() => {
                    boardDraft = createNewBoardDraft();
                    requestUpdate();
                  }}
                  onBoardChange={(boardFilter) =>
                    host.navigation.openPage(workboardPageTarget(boardFilter), {
                      replace: true,
                      preserveSearch: true,
                    })
                  }
                />
              </Show>
              <Show when={current().boardDraft}>
                {(draft) => (
                  <BoardModal
                    draft={draft()}
                    revision={current().revision}
                    toastOwner={state}
                    pageError={workboardErrorMessage(state, current().workboardProps.pageError)}
                    client={liveClient()}
                    canWrite={canWrite()}
                    requestUpdate={requestUpdate}
                    onCancel={() => {
                      boardDraft = null;
                      requestUpdate();
                    }}
                    onSaved={(board) => {
                      if (disposed) {
                        return;
                      }
                      const creating = boardDraft?.create;
                      const savedNavigation = navigationGeneration;
                      boardDraft = null;
                      if (creating) {
                        invalidateWorkboardLoads(workboard);
                        registerBoardNavigation(board);
                        host.ui.pinNavigation(`board-${board.id}`);
                      }
                      void refreshWorkboard({
                        host: workboard,
                        client,
                        requestUpdate,
                        source: "manual",
                      }).then(() => {
                        if (
                          disposed ||
                          !context.presented ||
                          savedNavigation !== navigationGeneration
                        ) {
                          return;
                        }
                        if (creating) {
                          host.navigation.openPage(workboardPageTarget(board.id), {
                            replace: true,
                            preserveSearch: true,
                          });
                        } else if (
                          state.boards.find((candidate) => candidate.id === state.boardFilter)
                            ?.kind === "sessions"
                        ) {
                          void sessionsBoard.read();
                        }
                      });
                      requestUpdate();
                    }}
                  />
                )}
              </Show>
            </>
          )}
        </Show>
      );
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        resumeWorkboardLiveRefresh(workboard);
      }
    };
    const unsubscribeHost = host.subscribe(() => {
      if (disposed) {
        return;
      }
      synchronizeConnection();
      requestUpdate();
    });
    const unsubscribeState = workboard.subscribe(requestUpdate);
    const unsubscribeEvents = host.onEvent(WORKBOARD_CHANGED_EVENT, (payload) => {
      if (!disposed && connected && context.presented && !sessionsBoard.hasCurrent(payload)) {
        handleWorkboardChanged(workboard, payload);
      }
    });
    const unsubscribeCron = host.onEvent("cron", (payload) => {
      if (
        !disposed &&
        connected &&
        context.presented &&
        isRecord(payload) &&
        typeof payload.jobId === "string" &&
        automations.delete(payload.jobId)
      ) {
        requestUpdate();
      }
    });
    document.addEventListener("visibilitychange", onVisibilityChange);
    update();
    const disposeRoot = render(() => <Page />, container);
    return {
      update(next) {
        if (
          context.presented !== next.presented ||
          context.props.boardId !== next.props.boardId ||
          context.props.boardFilter !== next.props.boardFilter
        ) {
          navigationGeneration += 1;
        }
        context = next;
        requestUpdate();
      },
      dispose() {
        disposed = true;
        metadataGeneration += 1;
        unsubscribeHost();
        unsubscribeState();
        unsubscribeEvents();
        unsubscribeCron();
        sessionsBoard.dispose();
        sessionResolver.dispose();
        document.removeEventListener("visibilitychange", onVisibilityChange);
        stop();
        disposeRoot();
      },
    };
  };
}
