/** @jsxImportSource @solidjs/web */
import type { WorkboardBoardSummary } from "@openclaw/workboard-contract";
import type { JSX } from "@solidjs/web";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createMemo, For, Show } from "solid-js";
import { AgentAvatar, SelectPicker } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import { agentDisplayName } from "./agent-filter.ts";
import type { SessionsBoardController } from "./sessions-board-controller.ts";
import { cardRelativeTime } from "./view-card-time.tsx";
import { boardScrollEdgesRef } from "./view-scroll-fade.ts";
import { SessionStatusBadge, type SessionStatusPresentation } from "./view-session-status.tsx";
import "../../styles/sessions-board.css";

const PULL_REQUEST_STATE_PRIORITY = { open: 0, draft: 1, merged: 2, closed: 3 };

export type SessionsBoardProps = {
  board: WorkboardBoardSummary;
  boards: WorkboardBoardSummary[];
  controller: SessionsBoardController;
  host: ControlUiHost;
  revision: number;
  heading: JSX.Element;
  scopeControl?: JSX.Element;
  pageError?: string;
  overlayOpen: boolean;
  onNewBoard: () => void;
  onBoardChange: (boardId: string) => void;
};

export function SessionsBoard(props: SessionsBoardProps) {
  const state = createMemo(() => {
    // The controller and host own mutable state; their notification publishes this projection.
    void props.revision;
    const controller = props.controller;
    const host = props.host;
    const snapshot = controller.snapshot;
    const peopleOptions = [
      { value: "everyone", label: t("workboard.sessionsBoard.everyone") },
      { value: "me", label: t("workboard.sessionsBoard.involvingMe") },
      ...(snapshot?.people ?? [])
        .filter((person) => person.identity.id !== controller.viewerProfileId)
        .map((person) => ({
          value: `profile:${person.identity.id}`,
          label: person.label || person.identity.id,
        })),
    ];
    if (
      controller.peopleFilter.startsWith("profile:") &&
      !peopleOptions.some((option) => option.value === controller.peopleFilter)
    ) {
      peopleOptions.push({
        value: controller.peopleFilter,
        label: controller.peopleFilter.slice(8),
      });
    }
    const agents = listSelectableAgents(host.agents.rows);
    const sessions = (snapshot?.sessions ?? [])
      .filter((session) => !host.agents.scopeId || session.agentId === host.agents.scopeId)
      .map((session) => ({
        key: session.key,
        agentId: session.agentId,
        columnId: session.columnId,
        reason: session.reason,
        headline: session.observerDigest?.headline,
        lastActivityAt: session.lastActivityAt,
        title: session.label || session.derivedTitle || session.key,
        agentName: agentDisplayName(
          agents.find((agent) => agent.id === session.agentId),
          session.agentId,
        ),
        sourceLabel: t(`workboard.sessionsBoard.source.${session.source}`),
        status: {
          state: session.run === "active" ? "running" : session.run,
          label: t(`workboard.sessionsBoard.run.${session.run}`),
          detail: "",
          visible: true,
          tone: session.run === "active" ? "live" : session.run === "failed" ? "blocked" : "idle",
        } satisfies SessionStatusPresentation,
        pullRequests: session.pullRequests
          .map((pr) => ({ ...pr }))
          .toSorted(
            (left, right) =>
              PULL_REQUEST_STATE_PRIORITY[left.state] - PULL_REQUEST_STATE_PRIORITY[right.state],
          ),
      }));
    return {
      canWrite: host.connection.canWrite,
      boardOptions: [
        { value: "__all__", label: t("workboard.allBoards") },
        ...props.boards.map((board) => ({ value: board.id, label: workboardBoardName(board) })),
      ],
      writable: host.connection.connected && host.connection.canWrite && !controller.busy,
      hasDock: controller.hasDock,
      hasSnapshot: Boolean(snapshot),
      loading: controller.loading,
      visibleError: [props.pageError, controller.error].filter(Boolean).join("\n"),
      warning: snapshot?.warning,
      peopleFilter: controller.peopleFilter,
      peopleOptions,
      peopleDisabled: !host.connection.connected || controller.busy || !snapshot,
      draggedKey: controller.draggedKey,
      dropColumn: controller.dropColumn,
      columns: (snapshot?.columns ?? props.board.sessions?.columns ?? []).map((column) => ({
        id: column.id,
        label: column.label,
        description: column.description,
        color: host.components.resolveAppearanceColor(column.color) || "var(--muted)",
        sessions: sessions.filter((session) => session.columnId === column.id),
      })),
    };
  });

  const startDrag = (event: DragEvent, sessionKey: string) => {
    if (!state().writable) {
      event.preventDefault();
      return;
    }
    event.dataTransfer?.setData("text/plain", sessionKey);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
    props.controller.drag(sessionKey);
  };

  return (
    <section class="workboard workboard-sessions">
      <div
        class="workboard-main"
        inert={props.overlayOpen}
        aria-hidden={props.overlayOpen ? "true" : undefined}
      >
        <header class="workboard-heading">
          {props.heading}
          <div class="workboard-heading__actions settings-section__actions">
            {state().canWrite ? (
              <button
                class="btn workboard-new-board"
                type="button"
                disabled={!state().writable}
                onClick={() => props.onNewBoard()}
              >
                {icons.plus}
                {t("workboard.newBoard")}
              </button>
            ) : null}
            {state().hasDock ? (
              <button
                class="btn workboard-board-agent"
                type="button"
                disabled={!state().writable || !state().hasSnapshot}
                onClick={() => void props.controller.openAgent()}
              >
                {icons.messageSquare}
                {t("workboard.sessionsBoard.agent")}
              </button>
            ) : null}
          </div>
        </header>
        <div class="workboard-toolbar">
          <SelectPicker
            value={props.board.id}
            options={state().boardOptions}
            accessibleLabel={t("workboard.boardFilter")}
            onSelect={(value) => props.onBoardChange(value)}
          />
          <div class="workboard-agent-filter">{props.scopeControl}</div>
          <SelectPicker
            class="workboard-people-filter"
            value={state().peopleFilter}
            options={state().peopleOptions}
            accessibleLabel={t("workboard.sessionsBoard.peopleFilter")}
            searchable
            disabled={state().peopleDisabled}
            onSelect={(value) => props.controller.selectPeople(value)}
          />
        </div>
        {state().visibleError ? (
          <div class="workboard-sessions__warning" role="alert">
            {state().visibleError}
          </div>
        ) : null}
        {state().warning ? (
          <div class="workboard-sessions__warning" role="status">
            {state().warning}
          </div>
        ) : null}
        {!state().hasSnapshot && state().loading ? (
          <div role="status">{t("workboard.sessionsBoard.loading")}</div>
        ) : null}
        <div class="workboard-board-viewport">
          <div
            ref={boardScrollEdgesRef()}
            class="workboard-board workboard-board--page workboard-board--comfortable"
          >
            <For each={state().columns} keyed={(column) => column.id}>
              {(column) => (
                <section
                  class={[
                    "workboard-column",
                    { "workboard-column--drop-target": state().dropColumn === column().id },
                  ]}
                  data-session-column={column().id}
                  style={{ "--workboard-column-accent": column().color }}
                  aria-label={`${column().label}, ${column().sessions.length}`}
                  onDragOver={(event: DragEvent) => {
                    if (!state().writable || !props.controller.draggedKey) {
                      return;
                    }
                    event.preventDefault();
                    if (event.dataTransfer) {
                      event.dataTransfer.dropEffect = "move";
                    }
                    if (props.controller.dropColumn !== column().id) {
                      props.controller.drag(props.controller.draggedKey, column().id);
                    }
                  }}
                  onDrop={(event: DragEvent) => {
                    event.preventDefault();
                    const key = props.controller.draggedKey;
                    props.controller.drag();
                    if (state().writable && key) {
                      void props.controller.move(key, column().id);
                    }
                  }}
                >
                  <header class="workboard-column__header" title={column().description}>
                    <h2>
                      {column().label}
                      <span class="workboard-column__count">{column().sessions.length}</span>
                    </h2>
                  </header>
                  <div class="workboard-column__cards">
                    <For each={column().sessions} keyed={(session) => session.key}>
                      {(session) => (
                        <div
                          class={[
                            "workboard-session-tile",
                            {
                              "workboard-session-tile--dragging":
                                state().draggedKey === session().key,
                            },
                          ]}
                          data-session-key={session().key}
                          title={[session().title, session().sourceLabel, session().reason]
                            .filter(Boolean)
                            .join("\n")}
                          draggable={state().writable ? "true" : "false"}
                          onClick={() =>
                            props.host.sessions.open({
                              sessionKey: session().key,
                              agentId: session().agentId,
                            })
                          }
                          onDragStart={(event: DragEvent) => startDrag(event, session().key)}
                          onDragEnd={() => props.controller.drag()}
                        >
                          <button class="workboard-session-tile__title" type="button">
                            {session().title}
                          </button>
                          {session().headline ? (
                            <span class="workboard-session-tile__headline">
                              {session().headline}
                            </span>
                          ) : null}
                          <span class="workboard-session-tile__meta">
                            <span
                              class="workboard-session-tile__agent"
                              title={`${session().agentName} (agent:${session().agentId})`}
                            >
                              <AgentAvatar
                                agentId={session().agentId}
                                label={session().agentName}
                              />
                              {session().agentName}
                            </span>
                            <SessionStatusBadge presentation={session().status} />
                          </span>
                          {session().pullRequests.length ? (
                            <span class="workboard-session-tile__prs">
                              <For
                                each={session().pullRequests.slice(0, 4)}
                                keyed={(pr) => pr.number}
                              >
                                {(pr) => (
                                  <Show
                                    when={pr().url}
                                    fallback={
                                      <span
                                        class="workboard-session-pr"
                                        data-state={pr().state}
                                        title={pr().title}
                                      >
                                        {pr().state === "merged"
                                          ? icons.gitMerge
                                          : icons.gitPullRequest}
                                        #{pr().number} ·{" "}
                                        {t(`workboard.sessionsBoard.pullRequest.${pr().state}`)}
                                      </span>
                                    }
                                  >
                                    <a
                                      class="workboard-session-pr"
                                      data-state={pr().state}
                                      href={pr().url}
                                      target="_blank"
                                      rel="noreferrer"
                                      title={pr().title}
                                      onClick={(event: MouseEvent) => event.stopPropagation()}
                                      onDragStart={(event: DragEvent) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                      }}
                                    >
                                      {pr().state === "merged"
                                        ? icons.gitMerge
                                        : icons.gitPullRequest}
                                      #{pr().number} ·{" "}
                                      {t(`workboard.sessionsBoard.pullRequest.${pr().state}`)}
                                    </a>
                                  </Show>
                                )}
                              </For>
                              {session().pullRequests.length > 4 ? (
                                <span>+{session().pullRequests.length - 4}</span>
                              ) : null}
                            </span>
                          ) : null}
                          <span
                            class="workboard-session-tile__time"
                            title={formatDateTimeMs(session().lastActivityAt)}
                          >
                            {cardRelativeTime(session().lastActivityAt, Date.now())}
                          </span>
                        </div>
                      )}
                    </For>
                    {column().sessions.length ? null : (
                      <span class="workboard-sessions__empty">
                        {t("workboard.sessionsBoard.empty")}
                      </span>
                    )}
                  </div>
                </section>
              )}
            </For>
          </div>
        </div>
      </div>
    </section>
  );
}
