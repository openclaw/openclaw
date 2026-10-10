/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { asDateTimestampMs } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createMemo, For, onSettled } from "solid-js";
import { icons } from "../../components/icons.tsx";
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
  ArchiveCardAction,
  CardMoveControl,
  DeleteCardAction,
  EditCardAction,
  OpenSessionCardAction,
  StartExecutionButton,
  StopCardAction,
} from "./view-card-actions.tsx";
import {
  CardAlertView,
  CardUpdatedTime,
  CardPriority,
  CardMeta,
  CardCounts,
  CardSession,
} from "./view-card-content.tsx";
import { openCardDetails, workboardCardDetailDrawerId } from "./view-card-details.tsx";
import { openCreateModal, workboardCardModalId } from "./view-card-modal.tsx";
import {
  canMutate,
  formatStatusLabel,
  workboardMutationContext,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { closeWorkboardPopoverOnAction, workboardPopoverRef } from "./view-popover.ts";
import { workboardScrollFadeRef } from "./view-scroll-fade.ts";
import { getSessionStatus } from "./view-session-status.tsx";
function isCardActionTarget(event: Event): boolean {
  return event.target instanceof Element
    ? Boolean(event.target.closest("button, a, input, select, textarea, details"))
    : false;
}
type WorkboardCardSurface = "page" | "widget" | "list";
function WorkboardCardView(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  surface: WorkboardCardSurface;
}) {
  const action = createMemo(
    () => (input.workboard.revision, getCardActionState(input.workboard, input.card)),
  );
  const widget = createMemo(() => input.surface === "widget");
  const dependencies = createMemo(() =>
    getWorkboardDependencyState(input.card, action().state.cards),
  );
  const lifecycle = createMemo(() =>
    getWorkboardLifecycle(input.card, input.workboard.sessions, input.workboard.sessionResolution),
  );
  const now = createMemo(() => (input.workboard.revision, Date.now()));
  const updatedAt = createMemo(() => asDateTimestampMs(input.card.updatedAt));
  const sessionStatus = createMemo(() => getSessionStatus(input.card, lifecycle(), now()));
  const alerts = createMemo(() =>
    visibleCardAlerts(
      getCardAlerts(input.card, lifecycle(), dependencies(), now()),
      sessionStatus().visible || sessionStatus().state === "running"
        ? sessionStatus().state
        : undefined,
    ),
  );
  const StartAction = () => (
    <>
      {!widget() && action().showStartControls ? (
        <StartExecutionButton
          workboard={input.workboard}
          card={input.card}
          engine={null}
          mode={"autonomous"}
        />
      ) : null}
    </>
  );
  const EditAction = () => (
    <>
      {!widget() && action().writable && !action().archived ? (
        <EditCardAction workboard={input.workboard} card={input.card} />
      ) : null}
    </>
  );
  const ArchiveAction = () => (
    <>
      {!widget() && action().writable ? (
        <ArchiveCardAction
          workboard={input.workboard}
          card={input.card}
          busy={action().busy}
          archived={action().archived}
        />
      ) : null}
    </>
  );
  const showDetails = () => {
    openCardDetails(action().state, input.card);
    input.workboard.onRequestUpdate?.();
  };
  const DetailAction = () => (
    <>
      {widget() ? null : (
        <button
          class="btn"
          type="button"
          aria-label={t("workboard.viewDetails")}
          aria-haspopup="dialog"
          aria-expanded={action().state.detailCardId === input.card.id ? "true" : "false"}
          aria-controls={workboardCardDetailDrawerId}
          onClick={showDetails}
        >
          {icons.eye}
          <span>{t("workboard.viewDetails")}</span>
        </button>
      )}
    </>
  );
  const SessionAction = () => (
    <>
      {widget() ? null : (
        <OpenSessionCardAction workboard={input.workboard} session={action().sessionTarget} />
      )}
    </>
  );
  const StopAction = () => (
    <>
      {!widget() && action().writable && action().linkedSessionKey && action().live ? (
        <StopCardAction workboard={input.workboard} card={input.card} busy={action().busy} />
      ) : null}
    </>
  );
  const MoveAction = () => (
    <>
      {!action().archived && (action().writable || widget()) ? (
        <CardMoveControl
          workboard={input.workboard}
          card={input.card}
          busy={action().busy || !action().writable}
          options={{
            wide: widget(),
          }}
        />
      ) : null}
    </>
  );
  const DeleteAction = () => (
    <>
      {!widget() && action().writable ? (
        <DeleteCardAction workboard={input.workboard} card={input.card} busy={action().busy} />
      ) : null}
    </>
  );
  const selected = createMemo(() => action().state.selectedCardIds.has(input.card.id));
  const alertDescriptionId = createMemo(
    () => `workboard-card-alert-${input.surface}-${input.card.id}`,
  );
  const selectable = createMemo(() => !widget() && action().writable && !action().archived);
  const selectionMode = createMemo(() => selectable() && action().state.selectedCardIds.size > 0);
  const toggleSelection = () => {
    if (!selectable() || action().busy || action().state.dispatching) {
      return;
    }
    if (action().state.selectedCardIds.has(input.card.id)) {
      action().state.selectedCardIds.delete(input.card.id);
    } else {
      action().state.selectedCardIds.add(input.card.id);
    }
    input.workboard.onRequestUpdate?.();
  };
  const ActionsMenu = () => (
    <>
      {!widget() && (action().writable || action().linkedSessionKey) ? (
        <div class="workboard-card__action-menu">
          <button
            type="button"
            class="workboard-card__menu-trigger"
            aria-label={t("workboard.cardActions")}
            aria-haspopup="dialog"
            aria-expanded="false"
            popovertarget={`workboard-card-menu-${input.card.id}`}
          >
            {icons.moreHorizontal}
          </button>
          <div
            id={`workboard-card-menu-${input.card.id}`}
            popover="auto"
            role="dialog"
            aria-label={t("workboard.cardActions")}
            class="workboard-card__action-menu-panel"
            ref={workboardPopoverRef("end")}
            onClick={closeWorkboardPopoverOnAction}
          >
            <div class="workboard-card__menu-group">
              <DetailAction /> <EditAction />
            </div>
            {action().showStartControls ||
            action().sessionTarget ||
            (action().writable && action().linkedSessionKey && action().live) ? (
              <div class="workboard-card__menu-group">
                <StartAction /> <SessionAction /> <StopAction />
              </div>
            ) : null}
            {!(!action().archived && (action().writable || widget())) ? null : (
              <div class="workboard-card__menu-status">
                <span>{t("workboard.moveTo")}</span>
                <MoveAction />
              </div>
            )}
            {action().writable ? (
              <div class="workboard-card__menu-group">
                <ArchiveAction /> <DeleteAction />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
  const ListContents = () => (
    <>
      {input.surface === "list" ? (
        <>
          <div class="workboard-list-row__priority">
            <CardPriority card={input.card} />
          </div>
          <div class="workboard-list-row__identity">
            <div class="workboard-list-row__title">
              <h3
                class="workboard-truncate"
                title={[input.card.title, input.card.notes].filter(Boolean).join("\n\n")}
              >
                {input.card.title}
              </h3>
              {input.card.labels.length ? (
                <div class="workboard-card__labels">
                  <For each={input.card.labels.slice(0, 1)} keyed={(label) => label}>
                    {(label) => (
                      <span class="workboard-chip workboard-truncate" title={label()}>
                        {label()}
                      </span>
                    )}
                  </For>
                  {input.card.labels.length > 1 ? (
                    <span
                      class="workboard-chip"
                      title={input.card.labels.slice(1).join(", ")}
                      aria-label={t("workboard.cardMoreLabels", {
                        count: String(input.card.labels.length - 1),
                        labels: input.card.labels.slice(1).join(", "),
                      })}
                    >
                      +{input.card.labels.length - 1}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {action().archived ? (
                <span class="workboard-card__archived">{t("workboard.archived")}</span>
              ) : null}
            </div>
            <div class="workboard-list-row__context">
              {alerts().length ? (
                <div class="workboard-list-row__alert">
                  <CardAlertView alerts={alerts()} descriptionId={alertDescriptionId()} />
                </div>
              ) : null}
              <CardCounts card={input.card} />
            </div>
          </div>
          <div class="workboard-list-row__session">
            <CardSession
              workboard={input.workboard}
              card={input.card}
              lifecycle={lifecycle()}
              status={sessionStatus()}
            />
          </div>
          <div class="workboard-list-row__updated">
            <CardUpdatedTime updatedAt={updatedAt()} now={now()} />
          </div>
          <div class="workboard-list-row__actions">
            <ActionsMenu />
          </div>
        </>
      ) : null}
    </>
  );
  return (
    <article
      class={`workboard-card ${input.surface === "list" ? "workboard-card--list" : ""} priority-${input.card.priority} ${action().busy ? "workboard-card--busy" : ""} ${action().archived ? "workboard-card--archived" : ""}
      ${action().state.draggedCardId === input.card.id ? "workboard-card--dragging" : ""} ${selected() ? "workboard-card--selected" : ""} ${widget() ? "workboard-card--widget" : "workboard-card--openable"}`}
      role={widget() ? null : "button"}
      tabindex={widget() ? null : "0"}
      aria-pressed={selectionMode() ? (selected() ? "true" : "false") : null}
      aria-describedby={alerts().length ? alertDescriptionId() : null}
      aria-keyshortcuts={selectable() ? "Shift+Enter Shift+Space" : null}
      title={
        widget() || !selectionMode()
          ? null
          : t(selected() ? "workboard.deselectCard" : "workboard.selectCard", {
              title: input.card.title,
            })
      }
      aria-haspopup={widget() || selectionMode() ? null : "dialog"}
      aria-expanded={
        widget() || selectionMode()
          ? null
          : action().state.detailCardId === input.card.id
            ? "true"
            : "false"
      }
      aria-controls={widget() || selectionMode() ? null : workboardCardDetailDrawerId}
      draggable={
        action().writable && !action().archived && !action().state.dispatching ? "true" : "false"
      }
      onMouseDown={(event: MouseEvent) => {
        if (event.button === 0 && event.shiftKey && selectable() && !isCardActionTarget(event)) {
          event.preventDefault();
          if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.focus({
              preventScroll: true,
            });
          }
        }
      }}
      onClick={(event: MouseEvent) => {
        if (!widget() && !isCardActionTarget(event)) {
          if (selectionMode() || (event.shiftKey && selectable())) {
            toggleSelection();
            return;
          }
          showDetails();
        }
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (widget() || isCardActionTarget(event) || (event.key !== "Enter" && event.key !== " ")) {
          return;
        }
        if (selectionMode() || (event.shiftKey && selectable())) {
          toggleSelection();
        } else {
          showDetails();
        }
        event.preventDefault();
      }}
      onDragStart={(event: DragEvent) => {
        if (!action().writable || action().archived || action().state.dispatching) {
          event.preventDefault();
          return;
        }
        action().state.draggedCardId = input.card.id;
        action().state.dragOverStatus = null;
        action().state.dragBeforeCardId = null;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", input.card.id);
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
        input.workboard.onRequestUpdate?.();
      }}
      onDragEnd={() => {
        action().state.draggedCardId = null;
        action().state.dragOverStatus = null;
        action().state.dragBeforeCardId = null;
        input.workboard.onRequestUpdate?.();
      }}
    >
      {input.surface === "list" ? (
        <ListContents />
      ) : (
        <>
          {" "}
          <header class="workboard-card__title">
            <h3 class="workboard-truncate-two" title={input.card.title}>
              {input.card.title}
            </h3>
            <div class="workboard-card__header-actions">
              <ActionsMenu />
            </div>
          </header>
          <CardSession
            workboard={input.workboard}
            card={input.card}
            lifecycle={lifecycle()}
            status={sessionStatus()}
          />
          <CardMeta card={input.card} archived={action().archived} />{" "}
          <CardAlertView alerts={alerts()} descriptionId={alertDescriptionId()} />
          <CardCounts card={input.card} />
          <footer class="workboard-card__footer">
            <CardPriority card={input.card} />{" "}
            <CardUpdatedTime updatedAt={updatedAt()} now={now()} />
          </footer>
          {widget() ? (
            <div class="workboard-card__actions workboard-card__actions--widget">
              <MoveAction />
            </div>
          ) : null}
        </>
      )}
    </article>
  );
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
export function WorkboardColumn(input: {
  workboard: WorkboardProps;
  status: WorkboardStatus;
  cards: WorkboardCard[];
  options?: {
    surface?: WorkboardCardSurface;
    boardFilter?: string;
  };
}) {
  const state = () => (input.workboard.revision, getWorkboardState(input.workboard.host));
  const writable = createMemo(() => (state(), canMutate(input.workboard)));
  const surface = createMemo(() => input.options?.surface ?? "page");
  const collapsible = createMemo(() => surface() !== "widget");
  const canCreate = createMemo(() => surface() !== "widget" && writable());
  const label = createMemo(() => formatStatusLabel(input.status));
  const hasHiddenCards = createMemo(
    () =>
      input.cards.length === 0 &&
      state().cards.some(
        (card) =>
          card.status === input.status &&
          (state().showArchived || isActiveWorkboardCard(card)) &&
          matchesBoardFilter(card, input.options?.boardFilter ?? state().boardFilter) &&
          matchesAgentScope(
            card,
            input.workboard.agentsList?.defaultId ?? input.workboard.defaultAgentId,
            input.workboard.scopeAgentId,
          ),
      ),
  );
  const columnMenuId = createMemo(() => `workboard-column-menu-${input.status}`);
  const selectableCards = createMemo(() =>
    input.cards.filter((card) => isActiveWorkboardCard(card) && !state().busyCardIds.has(card.id)),
  );
  const closeColumnMenu = (event: MouseEvent) => {
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
    }
  };
  const renderCreateButton = (className: string, withLabel = false) => (
    <button
      class={className}
      type="button"
      title={
        withLabel
          ? null
          : t("workboard.newCardInColumn", {
              column: label(),
            })
      }
      aria-label={t("workboard.newCardInColumn", {
        column: label(),
      })}
      aria-haspopup="dialog"
      aria-expanded={state().draftOpen ? "true" : "false"}
      aria-controls={workboardCardModalId}
      disabled={state().dispatching}
      onClick={() => {
        openCreateModal(state(), input.workboard, input.status);
        input.workboard.onRequestUpdate?.();
      }}
    >
      <span aria-hidden="true">{icons.plus}</span>
      {withLabel ? <span>{t("workboard.newCard")}</span> : null}
    </button>
  );
  const autoCollapsed = createMemo(
    () =>
      state().emptyColumnMode === "collapse" &&
      input.cards.length === 0 &&
      !state().expandedEmptyStatuses.has(input.status),
  );
  const collapsed = createMemo(
    () => collapsible() && (state().collapsedStatuses.has(input.status) || autoCollapsed()),
  );
  const dropTarget = createMemo(() =>
    Boolean(state().draggedCardId && state().dragOverStatus === input.status),
  );
  const lastDropCardId = createMemo(
    () => input.cards.findLast((card) => card.id !== state().draggedCardId)?.id,
  );
  let pendingToggleFocus: HTMLButtonElement | undefined;
  const ColumnToggle = (props: JSX.IntrinsicElements["button"]) => {
    let button!: HTMLButtonElement;
    onSettled(() => {
      const previous = pendingToggleFocus;
      pendingToggleFocus = undefined;
      if (
        previous &&
        (document.activeElement === previous || document.activeElement === document.body)
      ) {
        button.focus({
          preventScroll: true,
        });
      }
    });
    return <button {...props} ref={button} />;
  };
  const restoreToggleFocus = (event: MouseEvent) => {
    // List toggles retain their DOM node; board toggles are replaced on collapse.
    pendingToggleFocus =
      surface() !== "list" && event.detail === 0 && event.currentTarget instanceof HTMLButtonElement
        ? event.currentTarget
        : undefined;
  };
  const expandColumn = (event: MouseEvent) => {
    state().collapsedStatuses.delete(input.status);
    if (input.cards.length === 0) {
      state().expandedEmptyStatuses.add(input.status);
    }
    restoreToggleFocus(event);
    input.workboard.onRequestUpdate?.();
  };
  const collapseColumn = (event: MouseEvent) => {
    state().collapsedStatuses.add(input.status);
    state().expandedEmptyStatuses.delete(input.status);
    restoreToggleFocus(event);
    input.workboard.onRequestUpdate?.();
  };
  return (
    <section
      class={`workboard-column workboard-column--${input.status} ${state().draggedCardId && state().dragOverStatus === input.status ? "workboard-column--drop-target" : ""} ${collapsed() ? "workboard-column--collapsed" : ""}`}
      aria-label={`${label()}, ${input.cards.length}`}
      onDragOver={(event: DragEvent) => {
        if (writable() && state().draggedCardId) {
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
          }
          const beforeCardId = dropBeforeCardId(event, state().draggedCardId);
          if (
            state().dragOverStatus !== input.status ||
            state().dragBeforeCardId !== beforeCardId
          ) {
            state().dragOverStatus = input.status;
            state().dragBeforeCardId = beforeCardId;
            input.workboard.onRequestUpdate?.();
          }
        }
      }}
      onDragLeave={(event: DragEvent) => {
        const column = event.currentTarget;
        if (!(column instanceof HTMLElement)) {
          return;
        }
        // Moving between cards in the same column keeps that destination active.
        if (event.relatedTarget instanceof Node && column.contains(event.relatedTarget)) {
          return;
        }
        if (state().dragOverStatus === input.status) {
          state().dragOverStatus = null;
          state().dragBeforeCardId = null;
          input.workboard.onRequestUpdate?.();
        }
      }}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        const cardId = event.dataTransfer?.getData("text/plain") || state().draggedCardId;
        const beforeCardId = dropBeforeCardId(event, cardId);
        state().draggedCardId = null;
        state().dragOverStatus = null;
        state().dragBeforeCardId = null;
        input.workboard.onRequestUpdate?.();
        if (!writable()) {
          return;
        }
        const card = state().cards.find((candidate) => candidate.id === cardId);
        if (!card || !isActiveWorkboardCard(card)) {
          return;
        }
        void moveWorkboardCard({
          ...workboardMutationContext(input.workboard),
          cardId: card.id,
          status: input.status,
          beforeCardId,
          boardFilter: input.options?.boardFilter ?? state().boardFilter,
        });
      }}
    >
      {collapsed() && surface() !== "list" ? (
        <ColumnToggle
          class="workboard-column__rail"
          type="button"
          aria-label={t("workboard.expandColumn", {
            column: label(),
          })}
          aria-expanded="false"
          onClick={expandColumn}
        >
          <span class="workboard-column__rail-title">{label()}</span>
          <span class="workboard-column__count">{input.cards.length}</span>
          <span class="workboard-column__rail-icon" aria-hidden="true">
            <span class="workboard-column__direction-icon">{icons.maximize}</span>
          </span>
        </ColumnToggle>
      ) : (
        <>
          <div class="workboard-column__header">
            <div class="workboard-column__heading">
              {surface() === "list" ? (
                <h2>
                  <button
                    class="workboard-list-group__toggle"
                    type="button"
                    aria-expanded={collapsed() ? "false" : "true"}
                    aria-controls={`workboard-column-cards-${input.status}`}
                    onClick={collapsed() ? expandColumn : collapseColumn}
                  >
                    <span class="workboard-list-group__chevron" aria-hidden="true">
                      {collapsed() ? icons.chevronRight : icons.chevronDown}
                    </span>
                    <span class="workboard-list-group__label">{label()}</span>
                    <span class="workboard-column__count">{input.cards.length}</span>
                  </button>
                </h2>
              ) : (
                <>
                  <h2>{label()}</h2>
                  <span class="workboard-column__count">{input.cards.length}</span>
                </>
              )}
            </div>
            {collapsible() ? (
              <div class="workboard-column__header-actions">
                {surface() !== "list" ? (
                  <ColumnToggle
                    class="workboard-column__control workboard-column__collapse"
                    type="button"
                    aria-label={t("workboard.collapseColumn", {
                      column: label(),
                    })}
                    title={t("workboard.collapseColumn", {
                      column: label(),
                    })}
                    aria-expanded="true"
                    onClick={collapseColumn}
                  >
                    <span class="workboard-column__direction-icon" aria-hidden="true">
                      {icons.minimize}
                    </span>
                  </ColumnToggle>
                ) : null}
                {writable() ? (
                  <div class="workboard-column__menu">
                    <button
                      class="workboard-column__control"
                      type="button"
                      popovertarget={columnMenuId()}
                      aria-label={t("workboard.columnActions", {
                        column: label(),
                      })}
                      title={t("workboard.columnActions", {
                        column: label(),
                      })}
                      aria-expanded="false"
                    >
                      {icons.moreHorizontal}
                    </button>
                    <div
                      class="workboard-column__popover"
                      id={columnMenuId()}
                      popover="auto"
                      role="group"
                      aria-label={t("workboard.columnActions", {
                        column: label(),
                      })}
                      ref={workboardPopoverRef("end")}
                    >
                      <button
                        type="button"
                        disabled={!selectableCards().length || state().dispatching}
                        onClick={(event: MouseEvent) => {
                          closeColumnMenu(event);
                          for (const card of selectableCards()) {
                            state().selectedCardIds.add(card.id);
                          }
                          input.workboard.onRequestUpdate?.();
                        }}
                      >
                        {t("workboard.selectAllInColumn", {
                          column: label(),
                        })}
                      </button>
                    </div>
                  </div>
                ) : null}
                {canCreate() ? renderCreateButton("workboard-column__control") : null}
              </div>
            ) : null}
          </div>
          {collapsed() ? (
            <div id={`workboard-column-cards-${input.status}`} hidden></div>
          ) : (
            <div
              class="workboard-column__cards"
              id={surface() === "list" ? `workboard-column-cards-${input.status}` : null}
              role={surface() === "list" ? "list" : null}
              ref={workboardScrollFadeRef()}
            >
              {input.cards.length ? (
                <For each={input.cards} keyed={(card) => card.id}>
                  {(card) => (
                    <div
                      class={`workboard-column__item ${dropTarget() && state().dragBeforeCardId === card().id ? "workboard-column__item--drop-before" : ""} ${dropTarget() && state().dragBeforeCardId === null && card().id === lastDropCardId() ? "workboard-column__item--drop-after" : ""}`}
                      role={surface() === "list" ? "listitem" : null}
                      data-card-id={card().id}
                    >
                      <WorkboardCardView
                        workboard={input.workboard}
                        card={card()}
                        surface={surface()}
                      />
                    </div>
                  )}
                </For>
              ) : state().draggedCardId ? (
                <div class="workboard-empty">{t("workboard.emptyColumn")}</div>
              ) : !hasHiddenCards() && canCreate() ? (
                renderCreateButton("workboard-column__add workboard-column__add--empty", true)
              ) : (
                <div class="workboard-column__empty">
                  <span>
                    {t(
                      hasHiddenCards()
                        ? "workboard.emptyFilteredTitle"
                        : "workboard.emptyColumnTitle",
                    )}
                  </span>
                  {hasHiddenCards() ? <span>{t("workboard.emptyFilteredHint")}</span> : null}
                </div>
              )}
              {canCreate() &&
              !state().draggedCardId &&
              input.cards.length > 0 &&
              surface() !== "list"
                ? renderCreateButton("workboard-column__add", true)
                : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}
