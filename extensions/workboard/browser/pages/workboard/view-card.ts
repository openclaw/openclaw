import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { asDateTimestampMs } from "openclaw/plugin-sdk/string-coerce-runtime";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { getCardAlerts, visibleCardAlerts } from "../../lib/workboard/card-alerts.ts";
import { isActiveWorkboardCard } from "../../lib/workboard/card-state.ts";
import {
  getWorkboardDependencyState,
  getWorkboardLifecycle,
  getWorkboardState,
  moveWorkboardCard,
  type WorkboardCard,
  type WorkboardStatus,
} from "../../lib/workboard/index.ts";
import { matchesAgentScope } from "./agent-filter.ts";
import { matchesBoardFilter } from "./board-filter.ts";
import {
  getCardActionState,
  renderArchiveCardAction,
  renderCardMoveControl,
  renderDeleteCardAction,
  renderEditCardAction,
  renderOpenSessionCardAction,
  renderStartExecutionButton,
  renderStopCardAction,
} from "./view-card-actions.ts";
import {
  renderCardAlert,
  cardRelativeTime,
  renderCardMeta,
  renderCardCounts,
  renderCardSession,
} from "./view-card-content.ts";
import { openCardDetails, workboardCardDetailDrawerId } from "./view-card-details.ts";
import { openCreateModal, workboardCardModalId } from "./view-card-modal.ts";
import {
  canMutate,
  formatPriorityLabel,
  renderPriorityIcon,
  formatStatusLabel,
  formatUpdatedTime,
  type WorkboardProps,
} from "./view-helpers.ts";
import { closeWorkboardPopoverOnAction, workboardPopoverRef } from "./view-popover.ts";
import { workboardScrollFadeRef } from "./view-scroll-fade.ts";
import { getSessionStatus } from "./view-session-status.ts";

function isCardActionTarget(event: Event): boolean {
  return event.target instanceof Element
    ? Boolean(event.target.closest("button, a, input, select, textarea, details"))
    : false;
}

type WorkboardCardSurface = "page" | "widget";

function renderCard(props: WorkboardProps, card: WorkboardCard, surface: WorkboardCardSurface) {
  const {
    state,
    task,
    busy,
    activeTask,
    live,
    linkedSessionKey,
    sessionTarget,
    writable,
    showStartControls,
    archived,
  } = getCardActionState(props, card);
  const widget = surface === "widget";
  const dependencies = getWorkboardDependencyState(card, state.cards);
  const lifecycle = getWorkboardLifecycle(card, props.sessions, task, props.sessionResolution);
  const now = Date.now();
  const updatedAt = asDateTimestampMs(card.updatedAt);
  const sessionStatus = getSessionStatus(card, lifecycle, task, now);
  const alerts = visibleCardAlerts(
    getCardAlerts(card, lifecycle, dependencies, now),
    sessionStatus.visible || sessionStatus.state === "running" ? sessionStatus.state : undefined,
  );
  const startAction =
    !widget && showStartControls
      ? renderStartExecutionButton(props, card, null, "autonomous")
      : nothing;
  const editAction = !widget && writable && !archived ? renderEditCardAction(props, card) : nothing;
  const archiveAction =
    !widget && writable ? renderArchiveCardAction(props, card, busy, archived) : nothing;
  const detailAction = widget
    ? nothing
    : html`
        <button
          class="btn"
          type="button"
          aria-label=${t("workboard.viewDetails")}
          aria-haspopup="dialog"
          aria-expanded=${state.detailCardId === card.id ? "true" : "false"}
          aria-controls=${workboardCardDetailDrawerId}
          @click=${() => {
            openCardDetails(state, card);
            props.onRequestUpdate?.();
          }}
        >
          ${icons.eye}<span>${t("workboard.viewDetails")}</span>
        </button>
      `;
  const sessionAction = widget ? nothing : renderOpenSessionCardAction(props, sessionTarget);
  const stopAction =
    !widget && writable && (linkedSessionKey ? live : activeTask)
      ? renderStopCardAction(props, card, busy)
      : nothing;
  const moveAction =
    !archived && (writable || widget)
      ? renderCardMoveControl(props, card, busy || !writable, { wide: widget })
      : nothing;
  const deleteAction = !widget && writable ? renderDeleteCardAction(props, card, busy) : nothing;
  const alertDescriptionId = `workboard-card-alert-${surface}-${card.id}`;
  const actionsMenu =
    !widget && (writable || linkedSessionKey)
      ? html`
          <div class="workboard-card__action-menu">
            <button
              type="button"
              class="workboard-card__menu-trigger"
              aria-label=${t("workboard.cardActions")}
              aria-haspopup="dialog"
              aria-expanded="false"
              popovertarget=${`workboard-card-menu-${card.id}`}
            >
              ${icons.moreHorizontal}
            </button>
            <div
              id=${`workboard-card-menu-${card.id}`}
              popover="auto"
              role="dialog"
              aria-label=${t("workboard.cardActions")}
              class="workboard-card__action-menu-panel"
              ${ref(workboardPopoverRef("end"))}
              @click=${closeWorkboardPopoverOnAction}
            >
              <div class="workboard-card__menu-group">${detailAction} ${editAction}</div>
              ${
                startAction !== nothing || sessionAction !== nothing || stopAction !== nothing
                  ? html`<div class="workboard-card__menu-group">
                      ${startAction} ${sessionAction} ${stopAction}
                    </div>`
                  : nothing
              }
              ${
                moveAction === nothing
                  ? nothing
                  : html`
                      <div class="workboard-card__menu-status">
                        <span>${t("workboard.moveTo")}</span>
                        ${moveAction}
                      </div>
                    `
              }
              ${
                archiveAction !== nothing || deleteAction !== nothing
                  ? html`<div class="workboard-card__menu-group">
                      ${archiveAction} ${deleteAction}
                    </div>`
                  : nothing
              }
            </div>
          </div>
        `
      : nothing;
  const updatedTime =
    updatedAt === undefined
      ? nothing
      : html`<time
          class="workboard-card__updated"
          datetime=${new Date(updatedAt).toISOString()}
          title=${t("workboard.detailUpdatedValue", { time: formatUpdatedTime(updatedAt) })}
          >${cardRelativeTime(updatedAt, now)}</time
        >`;
  const priority =
    card.priority === "normal"
      ? nothing
      : html`<span class="workboard-card__priority">
          <span aria-hidden="true">${renderPriorityIcon(card.priority)}</span>${formatPriorityLabel(
            card.priority,
          )}
        </span>`;
  return html`
    <article
      class="workboard-card priority-${card.priority} ${busy ? "workboard-card--busy" : ""} ${
        archived ? "workboard-card--archived" : ""
      }
      ${state.draggedCardId === card.id ? "workboard-card--dragging" : ""} ${
        widget ? "workboard-card--widget" : "workboard-card--openable"
      }"
      role=${widget ? nothing : "button"}
      tabindex=${widget ? nothing : "0"}
      aria-describedby=${alerts.length ? alertDescriptionId : nothing}
      aria-haspopup=${widget ? nothing : "dialog"}
      aria-expanded=${widget ? nothing : state.detailCardId === card.id ? "true" : "false"}
      aria-controls=${widget ? nothing : workboardCardDetailDrawerId}
      draggable=${writable && !archived && !state.dispatching ? "true" : "false"}
      @click=${(event: MouseEvent) => {
        if (!widget && !isCardActionTarget(event)) {
          openCardDetails(state, card);
          props.onRequestUpdate?.();
        }
      }}
      @keydown=${(event: KeyboardEvent) => {
        if (widget || isCardActionTarget(event) || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        openCardDetails(state, card);
        props.onRequestUpdate?.();
        event.preventDefault();
      }}
      @dragstart=${(event: DragEvent) => {
        if (!writable || archived || state.dispatching) {
          event.preventDefault();
          return;
        }
        state.draggedCardId = card.id;
        state.dragOverStatus = null;
        state.dragBeforeCardId = null;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", card.id);
          const source = event.currentTarget;
          if (!(source instanceof HTMLElement)) {
            return;
          }
          const bounds = source.getBoundingClientRect();
          event.dataTransfer.setDragImage(
            source,
            event.clientX - bounds.left,
            event.clientY - bounds.top,
          );
        }
        props.onRequestUpdate?.();
      }}
      @dragend=${() => {
        state.draggedCardId = null;
        state.dragOverStatus = null;
        state.dragBeforeCardId = null;
        props.onRequestUpdate?.();
      }}
    >
      ${html` <header class="workboard-card__title">
          <h3 class="workboard-truncate-two" title=${card.title}>${card.title}</h3>
          <div class="workboard-card__header-actions">${actionsMenu}</div>
        </header>
        ${renderCardSession(props, card, lifecycle, task, sessionStatus)}
        ${renderCardMeta(card, archived)} ${renderCardAlert(alerts, alertDescriptionId)}
        ${renderCardCounts(card)}
        <footer class="workboard-card__footer">${priority} ${updatedTime}</footer>
        ${
          widget
            ? html`<div class="workboard-card__actions workboard-card__actions--widget">
                ${moveAction}
              </div>`
            : nothing
        }`}
    </article>
  `;
}

function dropBeforeCardId(event: DragEvent, draggedCardId: string | null): string | null {
  const column = event.currentTarget;
  if (!(column instanceof HTMLElement)) {
    return null;
  }
  const items = column.querySelectorAll<HTMLElement>(".workboard-column__item");
  for (const item of items) {
    if (item.dataset.cardId === draggedCardId) {
      continue;
    }
    const bounds = item.getBoundingClientRect();
    if (event.clientY < bounds.top + bounds.height / 2) {
      return item.dataset.cardId ?? null;
    }
  }
  return null;
}

export function renderColumn(
  props: WorkboardProps,
  status: WorkboardStatus,
  cards: WorkboardCard[],
  options: { surface?: WorkboardCardSurface; boardFilter?: string } = {},
) {
  const state = getWorkboardState(props.host);
  const writable = canMutate(props);
  const surface = options.surface ?? "page";
  const collapsible = surface !== "widget";
  const canCreate = surface !== "widget" && writable;
  const label = formatStatusLabel(status);
  const hasHiddenCards =
    cards.length === 0 &&
    state.cards.some(
      (card) =>
        card.status === status &&
        (state.showArchived || isActiveWorkboardCard(card)) &&
        matchesBoardFilter(card, options.boardFilter ?? state.boardFilter) &&
        matchesAgentScope(
          card,
          props.agentsList?.defaultId ?? props.defaultAgentId,
          props.scopeAgentId,
        ),
    );
  const renderCreateButton = (className: string, withLabel = false) => html`
    <button
      class=${className}
      type="button"
      title=${withLabel ? nothing : t("workboard.newCardInColumn", { column: label })}
      aria-label=${t("workboard.newCardInColumn", { column: label })}
      aria-haspopup="dialog"
      aria-expanded=${state.draftOpen ? "true" : "false"}
      aria-controls=${workboardCardModalId}
      ?disabled=${state.dispatching}
      @click=${() => {
        openCreateModal(state, props);
        state.draftStatus = status;
        props.onRequestUpdate?.();
      }}
    >
      <span aria-hidden="true">${icons.plus}</span>
      ${withLabel ? html`<span>${t("workboard.newCard")}</span>` : nothing}
    </button>
  `;
  const autoCollapsed =
    state.emptyColumnMode === "collapse" &&
    cards.length === 0 &&
    !state.expandedEmptyStatuses.has(status);
  const collapsed = collapsible && (state.collapsedStatuses.has(status) || autoCollapsed);
  const dropTarget = Boolean(state.draggedCardId && state.dragOverStatus === status);
  const lastDropCardId = cards.findLast((card) => card.id !== state.draggedCardId)?.id;
  const restoreToggleFocus = (event: MouseEvent) => {
    if (event.detail !== 0) {
      return;
    }
    if (!(event.currentTarget instanceof HTMLElement)) {
      return;
    }
    const column = event.currentTarget.closest(".workboard-column");
    // The toggle is replaced on collapse; keep keyboard focus on its replacement.
    queueMicrotask(() => {
      column
        ?.querySelector<HTMLButtonElement>(".workboard-column__rail, .workboard-column__collapse")
        ?.focus({ preventScroll: true });
    });
  };
  const expandColumn = (event: MouseEvent) => {
    state.collapsedStatuses.delete(status);
    if (cards.length === 0) {
      state.expandedEmptyStatuses.add(status);
    }
    props.onRequestUpdate?.();
    restoreToggleFocus(event);
  };
  const collapseColumn = (event: MouseEvent) => {
    state.collapsedStatuses.add(status);
    state.expandedEmptyStatuses.delete(status);
    props.onRequestUpdate?.();
    restoreToggleFocus(event);
  };
  return html`
    <section
      class="workboard-column workboard-column--${status} ${
        state.draggedCardId && state.dragOverStatus === status
          ? "workboard-column--drop-target"
          : ""
      } ${collapsed ? "workboard-column--collapsed" : ""}"
      aria-label=${`${label}, ${cards.length}`}
      @dragover=${(event: DragEvent) => {
        if (writable && state.draggedCardId) {
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
          }
          const beforeCardId = dropBeforeCardId(event, state.draggedCardId);
          if (state.dragOverStatus !== status || state.dragBeforeCardId !== beforeCardId) {
            state.dragOverStatus = status;
            state.dragBeforeCardId = beforeCardId;
            props.onRequestUpdate?.();
          }
        }
      }}
      @dragleave=${(event: DragEvent) => {
        const column = event.currentTarget;
        if (!(column instanceof HTMLElement)) {
          return;
        }
        // Moving between cards in the same column keeps that destination active.
        if (event.relatedTarget instanceof Node && column.contains(event.relatedTarget)) {
          return;
        }
        if (state.dragOverStatus === status) {
          state.dragOverStatus = null;
          state.dragBeforeCardId = null;
          props.onRequestUpdate?.();
        }
      }}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        const cardId = event.dataTransfer?.getData("text/plain") || state.draggedCardId;
        const beforeCardId = dropBeforeCardId(event, cardId);
        state.draggedCardId = null;
        state.dragOverStatus = null;
        state.dragBeforeCardId = null;
        props.onRequestUpdate?.();
        if (!writable) {
          return;
        }
        const card = state.cards.find((candidate) => candidate.id === cardId);
        if (!card || !isActiveWorkboardCard(card)) {
          return;
        }
        void moveWorkboardCard({
          host: props.host,
          client: props.client,
          cardId: card.id,
          status,
          beforeCardId,
          boardFilter: options.boardFilter ?? state.boardFilter,
          requestUpdate: props.onRequestUpdate,
        });
      }}
    >
      ${
        collapsed
          ? html`
              <button
                class="workboard-column__rail"
                type="button"
                aria-label=${t("workboard.expandColumn", { column: label })}
                aria-expanded="false"
                @click=${expandColumn}
              >
                <span class="workboard-column__rail-title">${label}</span>
                <span class="workboard-column__count">${cards.length}</span>
                <span class="workboard-column__rail-icon" aria-hidden="true">
                  <span class="workboard-column__direction-icon">${icons.maximize}</span>
                </span>
              </button>
            `
          : html`
              <div class="workboard-column__header">
                <div class="workboard-column__heading">
                  <h2>${label}</h2>
                  <span class="workboard-column__count">${cards.length}</span>
                </div>
                ${
                  collapsible
                    ? html`<div class="workboard-column__header-actions">
                        <button
                          class="workboard-column__control workboard-column__collapse"
                          type="button"
                          aria-label=${t("workboard.collapseColumn", { column: label })}
                          title=${t("workboard.collapseColumn", { column: label })}
                          aria-expanded="true"
                          @click=${collapseColumn}
                        >
                          <span class="workboard-column__direction-icon" aria-hidden="true"
                            >${icons.minimize}</span
                          >
                        </button>
                        ${canCreate ? renderCreateButton("workboard-column__control") : nothing}
                      </div>`
                    : nothing
                }
              </div>
              <div class="workboard-column__cards" ${ref(workboardScrollFadeRef())}>
                ${
                  cards.length
                    ? cards.map(
                        (card) => html`
                          <div
                            class="workboard-column__item ${
                              dropTarget && state.dragBeforeCardId === card.id
                                ? "workboard-column__item--drop-before"
                                : ""
                            } ${
                              dropTarget &&
                              state.dragBeforeCardId === null &&
                              card.id === lastDropCardId
                                ? "workboard-column__item--drop-after"
                                : ""
                            }"
                            data-card-id=${card.id}
                          >
                            ${renderCard(props, card, surface)}
                          </div>
                        `,
                      )
                    : state.draggedCardId
                      ? html`<div class="workboard-empty">${t("workboard.emptyColumn")}</div>`
                      : !hasHiddenCards && canCreate
                        ? renderCreateButton(
                            "workboard-column__add workboard-column__add--empty",
                            true,
                          )
                        : html`<div class="workboard-column__empty">
                            <span
                              >${t(
                                hasHiddenCards
                                  ? "workboard.emptyFilteredTitle"
                                  : "workboard.emptyColumnTitle",
                              )}</span
                            >
                            ${
                              hasHiddenCards
                                ? html`<span>${t("workboard.emptyFilteredHint")}</span>`
                                : nothing
                            }
                          </div>`
                }
                ${
                  canCreate && !state.draggedCardId && cards.length > 0
                    ? renderCreateButton("workboard-column__add", true)
                    : nothing
                }
              </div>
            `
      }
    </section>
  `;
}
