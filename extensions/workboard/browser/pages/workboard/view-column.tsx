/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { createMemo, For, onSettled, Show } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { workboardLocale } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { createElementRefs } from "../../lib/element-refs.ts";
import { isActiveWorkboardCard } from "../../lib/workboard/card-state.ts";
import { moveWorkboardCard } from "../../lib/workboard/mutations.ts";
import type { WorkboardCard, WorkboardStatus } from "../../lib/workboard/types.ts";
import { matchesAgentScope } from "./agent-filter.ts";
import { matchesBoardFilter } from "./board-filter.ts";
import { openCreateModal, workboardCardModalId } from "./view-card-modal.tsx";
import { WorkboardCardView, type WorkboardCardSurface } from "./view-card.tsx";
import { createWorkboardColumnWindow } from "./view-column-window.ts";
import {
  canMutate,
  formatStatusLabel,
  workboardMutationContext,
  workboardViewState,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { workboardPopoverRef } from "./view-popover.ts";
import { workboardScrollFadeRef } from "./view-scroll-fade.ts";
function dropBeforeCardId(
  event: DragEvent,
  draggedCardId: string | null,
  cards: readonly WorkboardCard[],
  items: () => Iterable<HTMLElement>,
  beforeAt: (clientY: number, draggedId: string | null) => string | null | undefined,
): string | null {
  const row =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>(".workboard-column__item")
      : null;
  if (row && row.closest(".workboard-column") === event.currentTarget) {
    if (row.dataset.cardId !== draggedCardId) {
      const bounds = row.getBoundingClientRect();
      if (event.clientY < bounds.top + bounds.height / 2) {
        return row.dataset.cardId ?? null;
      }
    }
    // A row's lower half belongs before the next card, excluding the drag source.
    const index = cards.findIndex((card) => card.id === row.dataset.cardId);
    return cards.slice(index + 1).find((card) => card.id !== draggedCardId)?.id ?? null;
  }
  const logical = beforeAt(event.clientY, draggedCardId);
  if (logical !== undefined) {
    return logical;
  }
  for (const item of items()) {
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
  cardRefs?: ReturnType<typeof createElementRefs<HTMLElement>>;
  menuCardId?: string;
  options?: {
    surface?: WorkboardCardSurface;
    boardFilter?: string;
  };
}) {
  const rows = createElementRefs<HTMLElement>();
  const orderedRows = () =>
    input.cards.flatMap((card) => {
      const row = rows.get(card.id);
      return row ? [row] : [];
    });
  const state = workboardViewState(() => input.workboard);
  const writable = createMemo(() => {
    state();
    return canMutate(input.workboard);
  });
  const surface = createMemo(() => input.options?.surface ?? "page");
  const columnWindow = createWorkboardColumnWindow({
    cards: () => input.cards,
    enabled: () => surface() === "page",
    layout: () => `${state().layout}:${workboardLocale()}`,
    retained: () => [
      state().draggedCardId,
      state().dragBeforeCardId,
      state().detailCardId,
      input.menuCardId,
      input.cards.find((card) => state().selectedCardIds.has(card.id))?.id,
    ],
    rows,
  });
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
          ? undefined
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
    return (
      <button
        {...props}
        ref={(element) => {
          button = element;
        }}
      />
    );
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
      class={[
        "workboard-column",
        `workboard-column--${input.status}`,
        state().draggedCardId && state().dragOverStatus === input.status
          ? "workboard-column--drop-target"
          : "",
        collapsed() ? "workboard-column--collapsed" : "",
      ]}
      aria-label={`${label()}, ${input.cards.length}`}
      onDragOver={(event: DragEvent) => {
        if (writable() && state().draggedCardId) {
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
          }
          const beforeCardId = dropBeforeCardId(
            event,
            state().draggedCardId,
            input.cards,
            orderedRows,
            columnWindow.beforeAt,
          );
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
        const beforeCardId = dropBeforeCardId(
          event,
          cardId,
          input.cards,
          orderedRows,
          columnWindow.beforeAt,
        );
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
                    onClick={(event) => (collapsed() ? expandColumn(event) : collapseColumn(event))}
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
            <div id={`workboard-column-cards-${input.status}`} hidden />
          ) : (
            <div
              class="workboard-column__cards"
              id={surface() === "list" ? `workboard-column-cards-${input.status}` : undefined}
              role={surface() === "list" ? "list" : undefined}
              ref={[workboardScrollFadeRef(), columnWindow.viewportRef()]}
              onScroll={columnWindow.scroll}
              onFocusIn={columnWindow.focus}
            >
              <div
                ref={columnWindow.contentRef}
                class={[
                  "workboard-column__window",
                  { "workboard-column__window--active": columnWindow.active() },
                ]}
                style={{ height: columnWindow.height() }}
                data-window-layout={columnWindow.layoutKey()}
              >
                {input.cards.length ? (
                  <For each={input.cards} keyed={(card) => card.id}>
                    {(card) => (
                      // Stable lightweight slots keep window changes from moving focused rows.
                      <div class="workboard-column__slot">
                        <Show when={columnWindow.includes(card().id)}>
                          <div
                            class={[
                              "workboard-column__item",
                              dropTarget() && state().dragBeforeCardId === card().id
                                ? "workboard-column__item--drop-before"
                                : "",
                              dropTarget() &&
                              state().dragBeforeCardId === null &&
                              card().id === lastDropCardId()
                                ? "workboard-column__item--drop-after"
                                : "",
                            ]}
                            role={surface() === "list" ? "listitem" : undefined}
                            data-card-id={card().id}
                            ref={[rows.ref(() => card().id), columnWindow.rowRef()]}
                            style={
                              columnWindow.active()
                                ? {
                                    position: "absolute",
                                    top: `${columnWindow.top(card().id)}px`,
                                    left: "0",
                                    right: "0",
                                  }
                                : undefined
                            }
                          >
                            <WorkboardCardView
                              workboard={input.workboard}
                              card={card()}
                              cardRefs={input.cardRefs}
                              surface={surface()}
                            />
                          </div>
                        </Show>
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
              </div>
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
