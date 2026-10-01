import type {
  WorkboardBoardSummary,
  WorkboardSessionsBoardRead,
} from "@openclaw/workboard-contract";
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { renderAgentAvatar, renderSelectPicker } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import { workboardBoardName } from "../../lib/workboard/board-presentation.ts";
import { agentDisplayName } from "./agent-filter.ts";
import type { SessionsBoardController } from "./sessions-board-controller.ts";
import { cardRelativeTime } from "./view-card-time.ts";
import { boardScrollEdgesRef } from "./view-scroll-fade.ts";
import { renderSessionStatusBadge } from "./view-session-status.ts";
import "../../styles/sessions-board.css";

export function renderSessionsBoard(props: {
  board: WorkboardBoardSummary;
  boards: WorkboardBoardSummary[];
  controller: SessionsBoardController;
  host: ControlUiHost;
  heading: TemplateResult;
  scopeControl?: TemplateResult;
  pageError?: string;
  overlayOpen: boolean;
  onNewBoard: () => void;
  onBoardChange: (boardId: string) => void;
}) {
  const { controller, host } = props;
  const snapshot = controller.snapshot;
  const columns = snapshot?.columns ?? props.board.sessions?.columns ?? [];
  const visibleSessions = (snapshot?.sessions ?? []).filter(
    (session) => !host.agents.scopeId || session.agentId === host.agents.scopeId,
  );
  const writable = host.connection.connected && host.connection.canWrite && !controller.busy;
  const visibleError = [props.pageError, controller.error].filter(Boolean).join("\n");
  const agents = listSelectableAgents(host.agents.rows);
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
  const renderSession = (session: WorkboardSessionsBoardRead["sessions"][number]) => {
    const title = session.label || session.derivedTitle || session.key;
    const agentName = agentDisplayName(
      agents.find((agent) => agent.id === session.agentId),
      session.agentId,
    );
    const run = session.run === "active" ? "running" : session.run;
    const source = t(`workboard.sessionsBoard.source.${session.source}`);
    return html`<button
      class="workboard-session-tile ${controller.draggedKey === session.key ? "workboard-session-tile--dragging" : ""}"
      type="button"
      data-session-key=${session.key}
      title=${[title, source, session.reason].filter(Boolean).join("\n")}
      draggable=${writable ? "true" : "false"}
      @click=${() => host.sessions.open({ sessionKey: session.key, agentId: session.agentId })}
      @dragstart=${(event: DragEvent) => {
        if (!writable) {
          event.preventDefault();
          return;
        }
        event.dataTransfer?.setData("text/plain", session.key);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
        }
        controller.drag(session.key);
      }}
      @dragend=${() => controller.drag()}
    >
      <span class="workboard-session-tile__title">${title}</span>
      ${session.observerDigest?.headline ? html`<span class="workboard-session-tile__headline">${session.observerDigest.headline}</span>` : nothing}
      <span class="workboard-session-tile__meta">
        <span
          class="workboard-session-tile__agent"
          title=${`${agentName} (agent:${session.agentId})`}
        >
          ${renderAgentAvatar({ agentId: session.agentId, label: agentName })}${agentName}
        </span>
        ${renderSessionStatusBadge({ state: run, label: t(`workboard.sessionsBoard.run.${session.run}`), detail: "", visible: true, tone: session.run === "active" ? "live" : session.run === "failed" ? "blocked" : "idle" })}
      </span>
      ${session.pullRequests.length ? html`<span class="workboard-session-tile__prs">${session.pullRequests.map((pr) => html`<span class="workboard-session-pr" data-state=${pr.state}>${pr.state === "merged" ? icons.gitMerge : icons.gitPullRequest}#${pr.number} · ${t(`workboard.sessionsBoard.pullRequest.${pr.state}`)}</span>`)}</span>` : nothing}
      <span class="workboard-session-tile__time" title=${formatDateTimeMs(session.lastActivityAt)}
        >${cardRelativeTime(session.lastActivityAt, Date.now())}</span
      >
    </button>`;
  };
  return html`<section class="workboard workboard-sessions">
    <div
      class="workboard-main"
      ?inert=${props.overlayOpen}
      aria-hidden=${props.overlayOpen ? "true" : nothing}
    >
      <header class="workboard-heading">
        ${props.heading}
        <div class="workboard-heading__actions settings-section__actions">
          ${host.connection.canWrite ? html`<button class="btn workboard-new-board" type="button" ?disabled=${!writable} @click=${props.onNewBoard}>${icons.plus}${t("workboard.newBoard")}</button>` : nothing}
          ${controller.hasDock ? html`<button class="btn workboard-board-agent" type="button" ?disabled=${!writable || !snapshot} @click=${() => controller.openAgent()}>${icons.messageSquare}${t("workboard.sessionsBoard.agent")}</button>` : nothing}
          <button
            class="btn btn--icon btn--ghost workboard-refresh"
            type="button"
            aria-label=${t("common.refresh")}
            aria-busy=${controller.loading || controller.busy}
            ?disabled=${!host.connection.connected || controller.loading || controller.busy}
            @click=${() => (host.connection.canWrite ? controller.refresh() : controller.read())}
          >
            ${icons.refresh}
          </button>
        </div>
      </header>
      <div class="workboard-toolbar">
        ${renderSelectPicker({ value: props.board.id, options: [{ value: "__all__", label: t("workboard.allBoards") }, ...props.boards.map((board) => ({ value: board.id, label: workboardBoardName(board) }))], accessibleLabel: t("workboard.boardFilter"), onSelect: props.onBoardChange })}
        <div class="workboard-agent-filter">${props.scopeControl}</div>
        ${renderSelectPicker({ value: controller.peopleFilter, options: peopleOptions, accessibleLabel: t("workboard.sessionsBoard.peopleFilter"), searchable: true, disabled: !host.connection.connected || controller.busy || !snapshot, onSelect: (value) => controller.selectPeople(value) }, "workboard-people-filter")}
      </div>
      ${visibleError ? html`<div class="workboard-sessions__warning" role="alert">${visibleError}</div>` : nothing}
      ${snapshot?.warning ? html`<div class="workboard-sessions__warning" role="status">${snapshot.warning}</div>` : nothing}
      ${!snapshot && controller.loading ? html`<div role="status">${t("workboard.sessionsBoard.loading")}</div>` : nothing}
      <div class="workboard-board-viewport">
        <div
          ${ref(boardScrollEdgesRef())}
          class="workboard-board workboard-board--page workboard-board--comfortable"
        >
          ${columns.map((column) => {
            const sessions = visibleSessions.filter((session) => session.columnId === column.id);
            const color = host.components.resolveAppearanceColor(column.color) || "var(--muted)";
            return html`<section
              class="workboard-column ${controller.dropColumn === column.id ? "workboard-column--drop-target" : ""}"
              data-session-column=${column.id}
              style=${`--workboard-column-accent: ${color}`}
              aria-label=${`${column.label}, ${sessions.length}`}
              @dragover=${(event: DragEvent) => {
                if (!writable || !controller.draggedKey) {
                  return;
                }
                event.preventDefault();
                if (event.dataTransfer) {
                  event.dataTransfer.dropEffect = "move";
                }
                if (controller.dropColumn !== column.id) {
                  controller.drag(controller.draggedKey, column.id);
                }
              }}
              @drop=${(event: DragEvent) => {
                event.preventDefault();
                const key = controller.draggedKey;
                controller.drag();
                if (writable && key) {
                  void controller.move(key, column.id);
                }
              }}
            >
              <header class="workboard-column__header" title=${column.description}>
                <h2>
                  ${column.label}<span class="workboard-column__count">${sessions.length}</span>
                </h2>
              </header>
              <div class="workboard-column__cards">
                ${sessions.map(renderSession)}${sessions.length ? nothing : html`<span class="workboard-sessions__empty">${t("workboard.sessionsBoard.empty")}</span>`}
              </div>
            </section>`;
          })}
        </div>
      </div>
    </div>
  </section>`;
}
