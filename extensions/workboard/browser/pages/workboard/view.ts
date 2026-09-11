import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { renderSelectPicker } from "../../components/host-components.ts";
import { icons } from "../../components/icons.ts";
import { renderWorkboardToast } from "../../components/toast.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import "../../styles/workboard.css";
import {
  dispatchWorkboard,
  filterWorkboardCards,
  workboardCardMatchesHealthKey,
  getWorkboardState,
  workboardHasActiveWrites,
  WORKBOARD_PRIORITIES,
  type WorkboardCard,
  type WorkboardStatus,
  type WorkboardUiState,
} from "../../lib/workboard/index.ts";
import {
  buildAgentFilterOptions,
  matchesAgentFilter,
  matchesAgentScope,
  normalizeActiveAgentFilter,
} from "./agent-filter.ts";
import {
  buildBoardFilterOptions,
  matchesBoardFilter,
  WORKBOARD_ALL_BOARDS_FILTER,
} from "./board-filter.ts";
import { getVisibleDetailCard, renderCardDetailsPanel } from "./view-card-details.ts";
import { openCreateModal, renderCardModal, workboardCardModalId } from "./view-card-modal.ts";
import { renderColumn } from "./view-card.ts";
import {
  multiFilterLabel,
  renderActiveFilters,
  renderStatusTabs,
  renderFilterSelect,
  renderFilterChoices,
  renderMultiFilter,
  type ActiveFilter,
} from "./view-filter-controls.ts";
import {
  canMutate,
  formatPriorityLabel,
  workboardErrorMessage,
  renderPriorityIcon,
  formatRefreshTime,
  matchesFilter,
  type WorkboardProps,
} from "./view-helpers.ts";
import { workboardPopoverRef } from "./view-popover.ts";
import { boardScrollEdgesRef } from "./view-scroll-fade.ts";
import { renderSelectionActions, renderSelectionDialog } from "./view-selection.ts";
import type { WorkboardSelectOption } from "./workboard-select.ts";

function dispatchSummaryMessage(state: WorkboardUiState) {
  const summary = state.lastDispatchSummary;
  if (!summary) {
    return "";
  }
  const total = Object.values(summary).reduce((sum, count) => sum + count, 0);
  return t(total === 0 ? "workboard.dispatchSummaryEmpty" : "workboard.dispatchSummary", {
    started: String(summary.started),
    failures: String(summary.failures),
    promoted: String(summary.promoted),
    blocked: String(summary.blocked),
    reclaimed: String(summary.reclaimed),
    orchestrated: String(summary.orchestrated),
  });
}

function refreshStatusLabel(state: WorkboardUiState) {
  if (state.lastRefreshAt) {
    return state.lastRefreshError
      ? t("workboard.refreshError")
      : t("workboard.lastRefreshed", { time: formatRefreshTime(state.lastRefreshAt) });
  }
  return state.lastRefreshError ? t("workboard.refreshError") : "";
}

const workboardFilterPopoverId = "workboard-filter-popover";

export function renderWorkboard(props: WorkboardProps & { onRefresh: () => void }) {
  const state = getWorkboardState(props.host);
  const defaultAgentId = props.agentsList?.defaultId ?? props.defaultAgentId;
  const agentOptions = buildAgentFilterOptions(props.agentsList, state.cards);
  state.agentFilter = normalizeActiveAgentFilter(agentOptions, state.agentFilter);
  const boardOptions = buildBoardFilterOptions(state.boards, state.cards);
  // A valid route can outlive a deleted board. Keep that id as the active
  // filter so the page becomes empty instead of silently showing every card.
  const activeBoardFilter = state.boardFilter;
  const scopedCards = state.cards
    .filter((card) => state.showArchived || !card.metadata?.archivedAt)
    .filter((card) => matchesBoardFilter(card, activeBoardFilter))
    .filter((card) => matchesAgentScope(card, defaultAgentId, props.scopeAgentId))
    .filter(
      (card) =>
        props.showAgentFilter === false ||
        matchesAgentFilter(card, props.agentsList, state.agentFilter),
    )
    .filter((card) => matchesFilter(card, { query: state.query, priority: "all" }));
  const now = Date.now();
  const cardsForFilters = (ignore?: "status" | "priority" | "attention") =>
    filterWorkboardCards({
      cards: scopedCards,
      filters: state,
      tasksByCardId: state.tasksByCardId,
      sessions: props.sessions,
      now,
      ignore,
    });
  const filtered = cardsForFilters();
  const visibleError = workboardErrorMessage(state, props.pageError);
  const writable = canMutate(props);
  const selectedCards = state.cards.filter((card) => state.selectedCardIds.has(card.id));
  const byStatus = new Map<WorkboardStatus, WorkboardCard[]>();
  for (const status of state.statuses) {
    byStatus.set(status, []);
  }
  for (const card of filtered) {
    byStatus.get(card.status)?.push(card);
  }
  const visibleStatuses = state.statuses.filter(
    (status) =>
      (!state.statusFilter.size || state.statusFilter.has(status)) &&
      (state.emptyColumnMode !== "hide" || (byStatus.get(status)?.length ?? 0) > 0),
  );
  // Counts ignore their own group, so selecting one option does not erase alternatives.
  const priorityCards = cardsForFilters("priority");
  const priorityOptions = WORKBOARD_PRIORITIES.map((priority) => ({
    value: priority,
    label: formatPriorityLabel(priority),
    icon: renderPriorityIcon(priority),
    count: priorityCards.filter((card) => card.priority === priority).length,
  }));
  const attentionCards = cardsForFilters("attention");
  const attentionOptions = (["stale", "missingProof"] as const).map((key) => ({
    value: key,
    label: t(key === "stale" ? "workboard.filterStale" : "workboard.filterMissingProof"),
    title: t(key === "stale" ? "workboard.filterStaleHint" : "workboard.filterMissingProofHint"),
    count: attentionCards.filter((card) =>
      workboardCardMatchesHealthKey(card, key, props.sessions, state.tasksByCardId.get(card.id)),
    ).length,
  }));
  const clearFilters = () => {
    state.query = "";
    state.searchOpen = false;
    state.statusFilter.clear();
    state.priorityFilter.clear();
    state.attentionFilter.clear();
    state.donePeriod = "all";
    state.showArchived = false;
    props.onRequestUpdate?.();
  };
  const agentFilterOptions: WorkboardSelectOption[] = agentOptions.map((option) => ({
    value: option.id,
    label: option.label,
    description: option.description,
    icon: option.id === "all" ? "users" : option.id === "default" ? "bot" : undefined,
  }));
  const activeFilters: ActiveFilter[] = [];
  if (state.query.trim()) {
    activeFilters.push({
      id: "query",
      label: t("workboard.filterChipSearch", { query: state.query.trim() }),
      clear: () => {
        state.query = "";
      },
    });
  }
  if (state.priorityFilter.size) {
    activeFilters.push({
      id: "priority",
      label: multiFilterLabel(
        t("workboard.fieldPriority"),
        state.priorityFilter,
        priorityOptions,
        true,
      ),
      clear: () => state.priorityFilter.clear(),
    });
  }
  if (state.attentionFilter.size) {
    activeFilters.push({
      id: "attention",
      label: multiFilterLabel(
        t("workboard.filterAttention"),
        state.attentionFilter,
        attentionOptions,
      ),
      clear: () => state.attentionFilter.clear(),
    });
  }
  if (state.donePeriod !== "all") {
    activeFilters.push({
      id: "done-period",
      label: t("workboard.filterChipValue", {
        field: t("workboard.filterDonePeriod"),
        value: t("workboard.filterLastWeek"),
      }),
      clear: () => {
        state.donePeriod = "all";
      },
    });
  }
  if (state.showArchived) {
    activeFilters.push({
      id: "archived",
      label: t("workboard.filterChipArchived"),
      clear: () => {
        state.showArchived = false;
      },
    });
  }
  const activeFilterCount = activeFilters.length;
  const hasActiveFilters = activeFilterCount > 0 || state.statusFilter.size > 0;
  const activeFiltering =
    hasActiveFilters ||
    Boolean(props.scopeAgentId) ||
    (props.showAgentFilter !== false && state.agentFilter !== "all") ||
    activeBoardFilter !== WORKBOARD_ALL_BOARDS_FILTER;
  const agentControl =
    props.scopeControl ??
    (props.showAgentFilter !== false &&
    listSelectableAgents(props.agentsList?.agents ?? []).length > 1
      ? renderSelectPicker({
          value: state.agentFilter,
          options: agentFilterOptions,
          accessibleLabel: t("workboard.fieldAgent"),
          onSelect: (value) => {
            if (!agentFilterOptions.some((option) => option.value === value)) {
              return;
            }
            state.agentFilter = value;
            props.onRequestUpdate?.();
          },
        })
      : nothing);
  const refreshStatus = state.loading ? t("common.refreshing") : refreshStatusLabel(state);
  // The active dialog owns the error alert while the board is inert.
  const dialogOpen =
    props.overlayOpen ||
    state.draftOpen ||
    Boolean(state.bulkDialog) ||
    Boolean(getVisibleDetailCard(state));
  return html`
    <section class="workboard">
      <div
        class="workboard-main"
        ?inert=${dialogOpen || state.bulkSaving}
        aria-hidden=${dialogOpen ? "true" : nothing}
      >
        <header class="workboard-heading">
          ${props.heading}
          <div class="workboard-heading__actions settings-section__actions">
            <span title=${refreshStatus || t("common.refresh")}>
              <button
                class="btn btn--icon btn--ghost workboard-refresh ${
                  state.lastRefreshError ? "workboard-refresh--error" : ""
                }"
                type="button"
                aria-label=${state.loading ? t("common.refreshing") : t("common.refresh")}
                aria-busy=${state.loading}
                ?disabled=${state.loading || state.dispatching || workboardHasActiveWrites(state)}
                @click=${props.onRefresh}
              >
                ${icons.refresh}
              </button>
            </span>
            ${
              writable
                ? html`
                    <button
                      class="btn workboard-dispatch"
                      type="button"
                      aria-label=${t("workboard.dispatch")}
                      title=${t(
                        activeBoardFilter === WORKBOARD_ALL_BOARDS_FILTER
                          ? "workboard.dispatchHelpAll"
                          : "workboard.dispatchHelp",
                      )}
                      ?disabled=${state.dispatching || workboardHasActiveWrites(state)}
                      @click=${() =>
                        dispatchWorkboard({
                          host: props.host,
                          client: props.client,
                          requestUpdate: props.onRequestUpdate,
                        })}
                    >
                      ${icons.play}<span class="workboard-action-label"
                        >${t("workboard.dispatch")}</span
                      >
                    </button>
                  `
                : nothing
            }
            ${
              writable
                ? html`
                    <button
                      class="btn primary workboard-create"
                      type="button"
                      aria-label=${t("workboard.newCard")}
                      aria-haspopup="dialog"
                      aria-expanded=${state.draftOpen ? "true" : "false"}
                      aria-controls=${workboardCardModalId}
                      ?disabled=${state.dispatching}
                      @click=${() => {
                        openCreateModal(state, props);
                        props.onRequestUpdate?.();
                      }}
                    >
                      ${icons.plus}<span class="workboard-action-label"
                        >${t("workboard.newCard")}</span
                      >
                    </button>
                  `
                : nothing
            }
          </div>
        </header>
        <div
          class="workboard-toolbar ${selectedCards.length ? "workboard-toolbar--selection" : ""}"
        >
          ${
            selectedCards.length
              ? renderSelectionActions(props)
              : html`<div class="workboard-toolbar__filters">
                  <div class="workboard-toolbar__navigation">
                    ${renderStatusTabs(state, props.onRequestUpdate)}
                  </div>
                </div>`
          }
          <div class="workboard-toolbar__tools">
            <div class="workboard-search-control">
              ${
                state.searchOpen || state.query
                  ? html`<div class="workboard-search">
                      <span aria-hidden="true">${icons.search}</span>
                      <input
                        class="settings-input"
                        id="workboard-search-input"
                        type="search"
                        aria-label=${t("workboard.searchPlaceholder")}
                        placeholder=${t("workboard.searchPlaceholder")}
                        .value=${state.query}
                        @input=${(event: InputEvent) => {
                          if (!(event.currentTarget instanceof HTMLInputElement)) {
                            return;
                          }
                          state.query = event.currentTarget.value;
                          props.onRequestUpdate?.();
                        }}
                        @keydown=${(event: KeyboardEvent) => {
                          if (event.key !== "Escape") {
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          if (!(event.currentTarget instanceof HTMLElement)) {
                            return;
                          }
                          const control = event.currentTarget.closest(".workboard-search-control");
                          state.query = "";
                          state.searchOpen = false;
                          props.onRequestUpdate?.();
                          queueMicrotask(() =>
                            control?.querySelector<HTMLButtonElement>("button")?.focus(),
                          );
                        }}
                      />
                      <button
                        class="btn btn--icon workboard-search__clear"
                        type="button"
                        aria-label=${t("workboard.closeSearch")}
                        @click=${(event: MouseEvent) => {
                          if (!(event.currentTarget instanceof HTMLElement)) {
                            return;
                          }
                          const control = event.currentTarget.closest(".workboard-search-control");
                          state.query = "";
                          state.searchOpen = false;
                          props.onRequestUpdate?.();
                          if (event.detail === 0) {
                            queueMicrotask(() =>
                              control?.querySelector<HTMLButtonElement>("button")?.focus(),
                            );
                          }
                        }}
                      >
                        ${icons.x}
                      </button>
                    </div>`
                  : html`<button
                      class="btn btn--icon workboard-search-trigger"
                      type="button"
                      aria-label=${t("workboard.searchPlaceholder")}
                      title=${t("workboard.searchPlaceholder")}
                      aria-expanded="false"
                      aria-controls="workboard-search-input"
                      @click=${(event: Event) => {
                        if (!(event.currentTarget instanceof HTMLElement)) {
                          return;
                        }
                        const control = event.currentTarget.closest(".workboard-search-control");
                        state.searchOpen = true;
                        props.onRequestUpdate?.();
                        queueMicrotask(() =>
                          control?.querySelector<HTMLInputElement>("input")?.focus(),
                        );
                      }}
                    >
                      ${icons.search}
                    </button>`
              }
            </div>
            ${
              agentControl === nothing
                ? nothing
                : html`<div class="workboard-agent-filter">${agentControl}</div>`
            }
            <button
              popovertarget=${workboardFilterPopoverId}
              class="btn workboard-filter-trigger ${activeFilterCount > 0 ? "active" : ""}"
              type="button"
              aria-label=${
                activeFilterCount > 0
                  ? t("workboard.filtersActive", { count: String(activeFilterCount) })
                  : t("workboard.filters")
              }
              aria-haspopup="dialog"
              aria-expanded="false"
            >
              ${icons.listFilter}<span>${t("workboard.filters")}</span>
              ${
                activeFilterCount > 0
                  ? html`<span class="workboard-filter-trigger__count">${activeFilterCount}</span>`
                  : nothing
              }
            </button>
            <div
              class="workboard-filter-popover"
              ${ref(workboardPopoverRef("end"))}
              id=${workboardFilterPopoverId}
              popover="auto"
              role="dialog"
              aria-label=${t("workboard.filters")}
            >
              <div class="workboard-filter-popover__panel">
                <div class="workboard-filter-heading">
                  <strong>${t("workboard.filters")}</strong>
                  ${
                    hasActiveFilters
                      ? html`<button
                          class="workboard-filter-clear"
                          type="button"
                          @click=${clearFilters}
                        >
                          ${t("workboard.clearFilters")}
                        </button>`
                      : nothing
                  }
                  <button
                    type="button"
                    class="btn btn--icon"
                    aria-label=${t("common.close")}
                    @click=${(event: Event) => {
                      if (!(event.currentTarget instanceof HTMLElement)) {
                        return;
                      }
                      event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
                    }}
                  >
                    ${icons.x}
                  </button>
                </div>
                <div class="workboard-filter-display">
                  ${renderFilterChoices({
                    label: t("workboard.filterLayout"),
                    value: state.viewMode,
                    options: [
                      { value: "board", label: t("workboard.viewBoard"), icon: "kanban" },
                      { value: "list", label: t("workboard.viewList"), icon: "list" },
                    ],
                    onChange: (value) => {
                      state.viewMode = value;
                      props.onRequestUpdate?.();
                    },
                  })}
                  ${renderFilterChoices({
                    label: t("workboard.filterDensity"),
                    value: state.layout,
                    options: [
                      {
                        value: "comfortable",
                        label: t("workboard.densityComfortable"),
                        icon: "layoutComfortable",
                      },
                      {
                        value: "compact",
                        label: t("workboard.densityCompact"),
                        icon: "layoutCompact",
                      },
                    ],
                    onChange: (value) => {
                      state.layout = value;
                      props.onRequestUpdate?.();
                    },
                  })}
                  ${renderFilterChoices({
                    label: t("workboard.emptyColumns"),
                    value: state.emptyColumnMode,
                    options: [
                      {
                        value: "show",
                        label: t("workboard.emptyColumnsShow"),
                        icon: "eye",
                        title: t("workboard.showEmptyColumns"),
                      },
                      {
                        value: "collapse",
                        label: t("workboard.emptyColumnsCollapse"),
                        icon: "chevronLeft",
                        title: t("workboard.collapseEmptyColumns"),
                      },
                      {
                        value: "hide",
                        label: t("workboard.emptyColumnsHide"),
                        icon: "eyeOff",
                        title: t("workboard.hideEmptyColumns"),
                      },
                    ],
                    onChange: (value) => {
                      state.emptyColumnMode = value;
                      state.expandedEmptyStatuses.clear();
                      props.onRequestUpdate?.();
                    },
                  })}
                </div>
                ${renderMultiFilter({
                  label: t("workboard.fieldPriority"),
                  values: state.priorityFilter,
                  options: priorityOptions,
                  onChange: () => props.onRequestUpdate?.(),
                })}
                ${renderMultiFilter({
                  label: t("workboard.filterAttention"),
                  values: state.attentionFilter,
                  options: attentionOptions,
                  wide: true,
                  onChange: () => props.onRequestUpdate?.(),
                })}
                <div class="workboard-filter-fields">
                  ${renderFilterSelect({
                    value: state.donePeriod,
                    options: [
                      { value: "all", label: t("workboard.filterAllTime") },
                      { value: "week", label: t("workboard.filterLastWeek") },
                    ],
                    label: t("workboard.filterDonePeriod"),
                    onChange: (value) => {
                      state.donePeriod = value;
                      props.onRequestUpdate?.();
                    },
                  })}
                  ${
                    boardOptions.length >= 3
                      ? renderFilterSelect({
                          value: activeBoardFilter,
                          options: boardOptions,
                          label: t("workboard.boardFilter"),
                          onChange: (value) => {
                            state.boardFilter = value;
                            props.onBoardFilterChange?.(value);
                            props.onRequestUpdate?.();
                          },
                        })
                      : nothing
                  }
                  <label class="workboard-filter-row workboard-filter-archived">
                    <span>${t("workboard.showArchived")}</span>
                    <input
                      type="checkbox"
                      role="switch"
                      .checked=${state.showArchived}
                      @change=${(event: Event) => {
                        if (!(event.currentTarget instanceof HTMLInputElement)) {
                          return;
                        }
                        state.showArchived = event.currentTarget.checked;
                        props.onRequestUpdate?.();
                      }}
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>
          ${
            !selectedCards.length && activeFilters.length
              ? renderActiveFilters(activeFilters, props.onRequestUpdate)
              : nothing
          }
        </div>
        ${
          (filtered.length === 0 && activeFiltering) || visibleStatuses.length === 0
            ? html`
                <div class="workboard-empty-state" role="status">
                  <strong>${t("workboard.emptyFilteredTitle")}</strong>
                  <span>${t("workboard.emptyFilteredHint")}</span>
                  ${
                    hasActiveFilters
                      ? html`<button class="btn" type="button" @click=${clearFilters}>
                          ${t("workboard.clearFilters")}
                        </button>`
                      : nothing
                  }
                </div>
              `
            : html`
                <div
                  class="workboard-board-viewport ${
                    state.viewMode === "list" ? "workboard-board-viewport--list" : ""
                  }"
                >
                  <div
                    ${ref(boardScrollEdgesRef())}
                    class="workboard-board workboard-board--page workboard-board--${state.layout} ${
                      state.viewMode === "list" ? "workboard-board--list" : ""
                    } ${visibleStatuses.length === 1 ? "workboard-board--single-column" : ""}"
                  >
                    ${
                      state.viewMode === "list"
                        ? html`<div class="workboard-list-header" aria-hidden="true">
                            <span>${t("workboard.fieldTitle")}</span>
                            <span>${t("workboard.fieldSession")}</span>
                            <span>${t("workboard.detailTabDetails")}</span>
                            <span>${t("workboard.fieldPriority")}</span>
                            <span>${t("workboard.detailUpdated")}</span>
                            <span></span><span></span>
                          </div>`
                        : nothing
                    }
                    ${visibleStatuses.map((status) =>
                      renderColumn(props, status, byStatus.get(status) ?? [], {
                        surface: state.viewMode === "list" ? "list" : "page",
                      }),
                    )}
                  </div>
                </div>
              `
        }
      </div>
      ${renderWorkboardToast({
        owner: state,
        outcomeSource: true,
        message:
          visibleError ??
          (state.bulkResult
            ? t("workboard.bulkResult", {
                completed: String(state.bulkResult.completed),
                total: String(state.bulkResult.total),
              })
            : dispatchSummaryMessage(state)),
        hidden: dialogOpen,
        key: visibleError ?? state.bulkResult ?? state.lastDispatchSummary,
        tone: visibleError ? "error" : "info",
      })}
      ${renderCardModal(props)} ${renderCardDetailsPanel(props)} ${renderSelectionDialog(props)}
    </section>
  `;
}
