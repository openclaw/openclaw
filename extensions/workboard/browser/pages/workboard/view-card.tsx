/** @jsxImportSource @solidjs/web */
import { asDateTimestampMs } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createMemo, For } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { getCardAlerts, visibleCardAlerts } from "../../lib/workboard/card-alerts.ts";
import {
  getWorkboardDependencyState,
  getWorkboardLifecycle,
  type WorkboardCard,
} from "../../lib/workboard/index.ts";
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
import type { WorkboardProps } from "./view-helpers.tsx";
import { closeWorkboardPopoverOnAction, workboardPopoverRef } from "./view-popover.ts";
import { getSessionStatus } from "./view-session-status.tsx";
function isCardActionTarget(event: Event): boolean {
  return event.target instanceof Element
    ? Boolean(event.target.closest("button, a, input, select, textarea, details"))
    : false;
}
export type WorkboardCardSurface = "page" | "widget" | "list";
export function WorkboardCardView(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  surface: WorkboardCardSurface;
}) {
  const action = createMemo(() => {
    void input.workboard.revision;
    return getCardActionState(input.workboard, input.card);
  });
  const widget = createMemo(() => input.surface === "widget");
  const dependencies = createMemo(() =>
    getWorkboardDependencyState(input.card, action().state.cards),
  );
  const lifecycle = createMemo(() =>
    getWorkboardLifecycle(input.card, input.workboard.sessions, input.workboard.sessionResolution),
  );
  const now = createMemo(() => {
    void input.workboard.revision;
    return Date.now();
  });
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
      class={[
        "workboard-card",
        input.surface === "list" ? "workboard-card--list" : "",
        `priority-${input.card.priority}`,
        action().busy ? "workboard-card--busy" : "",
        action().archived ? "workboard-card--archived" : "",
        action().state.draggedCardId === input.card.id ? "workboard-card--dragging" : "",
        selected() ? "workboard-card--selected" : "",
        widget() ? "workboard-card--widget" : "workboard-card--openable",
      ]}
      role={widget() ? undefined : "button"}
      tabindex={widget() ? undefined : "0"}
      aria-pressed={selectionMode() ? (selected() ? "true" : "false") : undefined}
      aria-describedby={alerts().length ? alertDescriptionId() : undefined}
      aria-keyshortcuts={selectable() ? "Shift+Enter Shift+Space" : undefined}
      title={
        widget() || !selectionMode()
          ? undefined
          : t(selected() ? "workboard.deselectCard" : "workboard.selectCard", {
              title: input.card.title,
            })
      }
      aria-haspopup={widget() || selectionMode() ? undefined : "dialog"}
      aria-expanded={
        widget() || selectionMode()
          ? undefined
          : action().state.detailCardId === input.card.id
            ? "true"
            : "false"
      }
      aria-controls={widget() || selectionMode() ? undefined : workboardCardDetailDrawerId}
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
