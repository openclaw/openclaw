/** @jsxImportSource @solidjs/web */
import { createMemo, For } from "solid-js";
import { SelectPicker } from "../../components/host-components.tsx";
import { icons } from "../../components/icons.tsx";
import { WorkboardToast } from "../../components/toast.tsx";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents } from "../../lib/agents/display.ts";
import { groupWorkboardCardsByStatus } from "../../lib/workboard/derived.ts";
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
} from "../../lib/workboard/index.ts";
import { agentDisplayName, buildAgentFilterOptions } from "./agent-filter.ts";
import { buildBoardFilterOptions, WORKBOARD_ALL_BOARDS_FILTER } from "./board-filter.ts";
import { getVisibleDetailCard, CardDetailsPanel } from "./view-card-details.tsx";
import { openCreateModal, CardModal, workboardCardModalId } from "./view-card-modal.tsx";
import { WorkboardColumn } from "./view-column.tsx";
import {
  multiFilterLabel,
  ActiveFilters,
  StatusTabs,
  MobileStatusPicker,
  FilterSelect,
  DisplayChoices,
  MultiFilter,
  type ActiveFilter,
} from "./view-filter-controls.tsx";
import {
  canMutate,
  formatPriorityLabel,
  workboardErrorMessage,
  workboardMutationContext,
  PriorityIcon,
  dispatchSummaryMessage,
  refreshStatusLabel,
  matchesCardQuery,
  type WorkboardProps,
} from "./view-helpers.tsx";
import { workboardPopoverRef } from "./view-popover.ts";
import { boardScrollEdgesRef } from "./view-scroll-fade.ts";
import { WorkboardSearch } from "./view-search.tsx";
import { matchesWorkboardCardScope, SelectionActions, SelectionDialog } from "./view-selection.tsx";
import type { WorkboardSelectOption } from "./workboard-select.ts";

const workboardFilterPopoverId = "workboard-filter-popover";

function AgentControl(props: { workboard: WorkboardProps; options: WorkboardSelectOption[] }) {
  const state = () => {
    void props.workboard.revision;
    return getWorkboardState(props.workboard.host);
  };
  return (
    <>
      {props.workboard.scopeControl ? (
        props.workboard.scopeControl()
      ) : (
        <SelectPicker
          value={state().agentFilter}
          options={props.options}
          accessibleLabel={t("workboard.fieldAgent")}
          onSelect={(value) => {
            if (!props.options.some((option) => option.value === value)) {
              return;
            }
            state().agentFilter = value;
            props.workboard.onRequestUpdate?.();
          }}
        />
      )}
    </>
  );
}

function WorkboardColumns(props: {
  workboard: WorkboardProps;
  statuses: WorkboardStatus[];
  byStatus: Map<WorkboardStatus, WorkboardCard[]>;
}) {
  const state = () => {
    void props.workboard.revision;
    return getWorkboardState(props.workboard.host);
  };
  const boardEdges = boardScrollEdgesRef();
  return (
    <div
      class={[
        "workboard-board-viewport",
        { "workboard-board-viewport--list": state().viewMode === "list" },
      ]}
    >
      <div
        ref={boardEdges}
        class={[
          "workboard-board workboard-board--page",
          `workboard-board--${state().layout}`,
          {
            "workboard-board--list": state().viewMode === "list",
            "workboard-board--single-column": props.statuses.length === 1,
          },
        ]}
      >
        {state().viewMode === "list" ? (
          <div class="workboard-list-header" aria-hidden="true">
            <span>{t("workboard.fieldPriority")}</span>
            <span>{t("workboard.fieldTitle")}</span>
            <span>{t("workboard.fieldSession")}</span>
            <span>{t("workboard.detailUpdated")}</span>
            <span />
          </div>
        ) : null}
        <For each={props.statuses} keyed={(status) => status}>
          {(status) => (
            <WorkboardColumn
              workboard={props.workboard}
              status={status()}
              cards={props.byStatus.get(status()) ?? []}
              options={{ surface: state().viewMode === "list" ? "list" : "page" }}
            />
          )}
        </For>
      </div>
    </div>
  );
}

export function WorkboardView(props: WorkboardProps & { onRefresh: () => void }) {
  const state = () => {
    void props.revision;
    return getWorkboardState(props.host);
  };
  const view = createMemo(() => {
    const current = state();
    const agentOptions = buildAgentFilterOptions(props.agentsList, current.cards);
    const boardOptions = buildBoardFilterOptions(current.boards, current.cards);
    // A deleted board keeps its route filter instead of exposing every board.
    const activeBoardFilter = current.boardFilter;
    const scopedCards = current.cards
      .filter((card) => current.showArchived || !card.metadata?.archivedAt)
      .filter((card) => matchesWorkboardCardScope(props, card))
      .filter((card) => matchesCardQuery(card, current.query));
    const now = Date.now();
    const cardsForFilters = (ignore?: "status" | "priority" | "attention") =>
      filterWorkboardCards({
        cards: scopedCards,
        filters: current,
        sessions: props.sessions,
        now,
        ignore,
      });
    const filtered = cardsForFilters();
    const visibleError = workboardErrorMessage(current, props.pageError);
    const selectedCards = current.cards.filter((card) => current.selectedCardIds.has(card.id));
    const byStatus = groupWorkboardCardsByStatus(filtered, current.statuses);
    const visibleStatuses = current.statuses.filter(
      (status) =>
        (!current.statusFilter.size || current.statusFilter.has(status)) &&
        (current.emptyColumnMode !== "hide" || (byStatus.get(status)?.length ?? 0) > 0),
    );
    // Counts ignore their own group so selecting one does not erase alternatives.
    const priorityCards = cardsForFilters("priority");
    const priorityOptions = WORKBOARD_PRIORITIES.map((priority) => ({
      value: priority,
      label: formatPriorityLabel(priority),
      icon: () => <PriorityIcon priority={priority} />,
      count: priorityCards.filter((card) => card.priority === priority).length,
    }));
    const attentionCards = cardsForFilters("attention");
    const attentionOptions = (["stale", "missingProof"] as const).map((key) => ({
      value: key,
      label: t(key === "stale" ? "workboard.filterStale" : "workboard.filterMissingProof"),
      title: t(key === "stale" ? "workboard.filterStaleHint" : "workboard.filterMissingProofHint"),
      count: attentionCards.filter((card) =>
        workboardCardMatchesHealthKey(card, key, props.sessions),
      ).length,
    }));
    const agentFilterOptions: WorkboardSelectOption[] = agentOptions.map((option) => ({
      value: option.id,
      label: option.label,
      description: option.description,
      icon: option.id === "all" ? "users" : option.id === "default" ? "bot" : undefined,
    }));
    const activeFilters: ActiveFilter[] = [];
    if (current.query.trim()) {
      activeFilters.push({
        id: "query",
        label: t("workboard.filterChipSearch", { query: current.query.trim() }),
        clear: () => {
          state().query = "";
        },
      });
    }
    if (current.priorityFilter.size) {
      activeFilters.push({
        id: "priority",
        label: multiFilterLabel(
          t("workboard.fieldPriority"),
          current.priorityFilter,
          priorityOptions,
          true,
        ),
        clear: () => state().priorityFilter.clear(),
      });
    }
    if (current.attentionFilter.size) {
      activeFilters.push({
        id: "attention",
        label: multiFilterLabel(
          t("workboard.filterAttention"),
          current.attentionFilter,
          attentionOptions,
        ),
        clear: () => state().attentionFilter.clear(),
      });
    }
    if (current.donePeriod !== "all") {
      activeFilters.push({
        id: "done-period",
        label: t("workboard.filterChipValue", {
          field: t("workboard.filterDonePeriod"),
          value: t("workboard.filterLastWeek"),
        }),
        clear: () => {
          state().donePeriod = "all";
        },
      });
    }
    if (current.showArchived) {
      activeFilters.push({
        id: "archived",
        label: t("workboard.filterChipArchived"),
        clear: () => {
          state().showArchived = false;
        },
      });
    }
    const activeFilterCount = activeFilters.length;
    const hasActiveFilters = activeFilterCount > 0 || current.statusFilter.size > 0;
    const activeFiltering =
      hasActiveFilters ||
      Boolean(props.scopeAgentId) ||
      (props.showAgentFilter !== false && current.agentFilter !== "all") ||
      activeBoardFilter !== WORKBOARD_ALL_BOARDS_FILTER;
    const hasAgentControl =
      Boolean(props.scopeControl) ||
      (props.showAgentFilter !== false &&
        listSelectableAgents(props.agentsList?.agents ?? []).length > 1);
    const activeAgent =
      props.scopeAgentId || (props.showAgentFilter === false ? "all" : current.agentFilter);
    const agentSummary =
      activeAgent === "all"
        ? t("workboard.allAgents")
        : activeAgent === "default"
          ? (agentOptions.find((option) => option.id === "default")?.label ??
            t("workboard.defaultAgent"))
          : agentDisplayName(
              props.agentsList?.agents.find((agent) => agent.id === activeAgent),
              activeAgent,
            );
    const clearAgentFilter = props.scopeAgentId
      ? props.onClearAgentScope
      : props.showAgentFilter !== false
        ? () => {
            state().agentFilter = "all";
          }
        : undefined;
    if (activeAgent !== "all" && clearAgentFilter) {
      activeFilters.push({
        id: "agent",
        label: t("workboard.filterChipValue", {
          field: t("workboard.fieldAgent"),
          value: agentSummary,
        }),
        clear: clearAgentFilter,
        mobileOnly: true,
      });
    }
    return {
      boardOptions,
      activeBoardFilter,
      filtered,
      statusCards: cardsForFilters("status"),
      visibleError,
      selectedCards,
      byStatus,
      visibleStatuses,
      priorityOptions,
      attentionOptions,
      agentFilterOptions,
      activeFilters,
      activeFilterCount,
      hasActiveFilters,
      activeFiltering,
      hasAgentControl,
      writable: canMutate(props),
      refreshStatus: current.loading ? t("common.refreshing") : refreshStatusLabel(current),
      toastMessage:
        visibleError ??
        (current.bulkResult
          ? t("workboard.bulkResult", {
              completed: String(current.bulkResult.completed),
              total: String(current.bulkResult.total),
            })
          : dispatchSummaryMessage(current)),
      toastKey: visibleError ?? current.bulkResult ?? current.lastDispatchSummary,
      // The active dialog owns the error alert while the board is inert.
      dialogOpen:
        props.overlayOpen ||
        current.draftOpen ||
        Boolean(current.bulkDialog) ||
        Boolean(getVisibleDetailCard(current)),
    };
  });
  const clearFilters = () => {
    const current = state();
    current.query = "";
    current.searchOpen = false;
    current.statusFilter.clear();
    current.priorityFilter.clear();
    current.attentionFilter.clear();
    current.donePeriod = "all";
    current.showArchived = false;
    props.onRequestUpdate?.();
  };
  const filterPopover = workboardPopoverRef("end");
  return (
    <section class="workboard">
      <div
        class="workboard-main"
        inert={view().dialogOpen || state().bulkSaving}
        aria-hidden={view().dialogOpen ? "true" : undefined}
      >
        <header class="workboard-heading">
          {props.heading}
          <div class="workboard-heading__actions settings-section__actions">
            {view().writable && props.onNewBoard ? (
              <button
                class="btn workboard-new-board"
                type="button"
                onClick={() => props.onNewBoard?.()}
              >
                {icons.plus}
                {t("workboard.newBoard")}
              </button>
            ) : null}
            <span
              class="workboard-refresh-control"
              title={view().refreshStatus || t("common.refresh")}
            >
              <button
                class={[
                  "btn btn--icon btn--ghost workboard-refresh",
                  { "workboard-refresh--error": Boolean(state().lastRefreshError) },
                ]}
                type="button"
                aria-label={state().loading ? t("common.refreshing") : t("common.refresh")}
                aria-busy={state().loading ? "true" : "false"}
                disabled={
                  state().loading || state().dispatching || workboardHasActiveWrites(state())
                }
                onClick={() => props.onRefresh()}
              >
                {icons.refresh}
              </button>
            </span>
            {view().writable ? (
              <button
                class="btn workboard-dispatch"
                type="button"
                aria-label={t("workboard.dispatch")}
                title={t(
                  view().activeBoardFilter === WORKBOARD_ALL_BOARDS_FILTER
                    ? "workboard.dispatchHelpAll"
                    : "workboard.dispatchHelp",
                )}
                disabled={state().dispatching || workboardHasActiveWrites(state())}
                onClick={() => void dispatchWorkboard(workboardMutationContext(props))}
              >
                {icons.play}
                <span class="workboard-action-label">{t("workboard.dispatch")}</span>
              </button>
            ) : null}
            {view().writable ? (
              <button
                class="btn primary workboard-create"
                type="button"
                aria-label={t("workboard.newCard")}
                aria-haspopup="dialog"
                aria-expanded={state().draftOpen ? "true" : "false"}
                aria-controls={workboardCardModalId}
                disabled={state().dispatching}
                onClick={() => {
                  openCreateModal(state(), props);
                  props.onRequestUpdate?.();
                }}
              >
                {icons.plus}
                <span class="workboard-action-label">{t("workboard.newCard")}</span>
                <span class="workboard-create__short-label">{t("workboard.newCardShort")}</span>
              </button>
            ) : null}
          </div>
        </header>
        <div
          class={[
            "workboard-toolbar",
            { "workboard-toolbar--selection": view().selectedCards.length > 0 },
          ]}
        >
          {view().selectedCards.length ? (
            <SelectionActions workboard={props} />
          ) : (
            <div class="workboard-toolbar__filters">
              <div class="workboard-toolbar__navigation">
                <StatusTabs
                  state={state()}
                  requestUpdate={props.onRequestUpdate}
                  revision={props.revision}
                />
                <MobileStatusPicker
                  state={state()}
                  cards={view().statusCards}
                  requestUpdate={props.onRequestUpdate}
                  revision={props.revision}
                />
              </div>
            </div>
          )}
          <div class="workboard-toolbar__tools">
            <WorkboardSearch workboard={props} />
            {view().hasAgentControl ? (
              <div class="workboard-agent-filter">
                <AgentControl workboard={props} options={view().agentFilterOptions} />
              </div>
            ) : null}
            <button
              popovertarget={workboardFilterPopoverId}
              class={["btn workboard-filter-trigger", { active: view().activeFilterCount > 0 }]}
              type="button"
              aria-label={
                view().activeFilterCount > 0
                  ? t("workboard.filtersActive", { count: String(view().activeFilterCount) })
                  : t("workboard.filters")
              }
              aria-haspopup="dialog"
              aria-expanded="false"
            >
              {icons.listFilter}
              <span>{t("workboard.filters")}</span>
              {view().activeFilterCount > 0 ? (
                <span class="workboard-filter-trigger__count">{view().activeFilterCount}</span>
              ) : null}
            </button>
            <div
              class="workboard-filter-popover"
              ref={filterPopover}
              id={workboardFilterPopoverId}
              popover="auto"
              role="dialog"
              aria-label={t("workboard.filters")}
            >
              <div class="workboard-filter-popover__panel">
                <div class="workboard-filter-heading">
                  <strong>{t("workboard.filters")}</strong>
                  {view().hasActiveFilters ? (
                    <button class="workboard-filter-clear" type="button" onClick={clearFilters}>
                      {t("workboard.clearFilters")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    class="btn btn--icon"
                    aria-label={t("common.close")}
                    onClick={(event) =>
                      event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover()
                    }
                  >
                    {icons.x}
                  </button>
                </div>
                {view().hasAgentControl ? (
                  <div class="workboard-filter-agent workboard-filter-choice">
                    <span class="workboard-filter-section__label">{t("workboard.fieldAgent")}</span>
                    <AgentControl workboard={props} options={view().agentFilterOptions} />
                  </div>
                ) : null}
                <div class="workboard-filter-display">
                  <DisplayChoices
                    state={state()}
                    revision={props.revision}
                    requestUpdate={props.onRequestUpdate}
                  />
                </div>
                <MultiFilter
                  label={t("workboard.fieldPriority")}
                  values={state().priorityFilter}
                  options={view().priorityOptions}
                  onChange={() => props.onRequestUpdate?.()}
                />
                <MultiFilter
                  label={t("workboard.filterAttention")}
                  values={state().attentionFilter}
                  options={view().attentionOptions}
                  wide
                  onChange={() => props.onRequestUpdate?.()}
                />
                <div class="workboard-filter-fields">
                  <FilterSelect
                    value={state().donePeriod}
                    options={[
                      { value: "all", label: t("workboard.filterAllTime") },
                      { value: "week", label: t("workboard.filterLastWeek") },
                    ]}
                    label={t("workboard.filterDonePeriod")}
                    onChange={(value) => {
                      state().donePeriod = value;
                      props.onRequestUpdate?.();
                    }}
                  />
                  {view().boardOptions.length >= 3 ? (
                    <FilterSelect
                      value={view().activeBoardFilter}
                      options={view().boardOptions}
                      label={t("workboard.boardFilter")}
                      onChange={(value) => {
                        state().boardFilter = value;
                        props.onBoardFilterChange?.(value);
                        props.onRequestUpdate?.();
                      }}
                    />
                  ) : null}
                  <label class="workboard-filter-row workboard-filter-archived">
                    <span>{t("workboard.showArchived")}</span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={state().showArchived}
                      onChange={(event) => {
                        state().showArchived = event.currentTarget.checked;
                        props.onRequestUpdate?.();
                      }}
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>
          {!view().selectedCards.length ? (
            <ActiveFilters filters={view().activeFilters} requestUpdate={props.onRequestUpdate} />
          ) : null}
        </div>
        {(view().filtered.length === 0 && view().activeFiltering) ||
        view().visibleStatuses.length === 0 ? (
          <div class="workboard-empty-state" role="status">
            <strong>{t("workboard.emptyFilteredTitle")}</strong>
            <span>{t("workboard.emptyFilteredHint")}</span>
            {view().hasActiveFilters ? (
              <button class="btn" type="button" onClick={clearFilters}>
                {t("workboard.clearFilters")}
              </button>
            ) : null}
          </div>
        ) : (
          <WorkboardColumns
            workboard={props}
            statuses={view().visibleStatuses}
            byStatus={view().byStatus}
          />
        )}
      </div>
      <WorkboardToast
        owner={state()}
        outcomeSource
        message={view().toastMessage}
        hidden={view().dialogOpen}
        key={view().toastKey}
        tone={view().visibleError ? "error" : "info"}
      />
      <CardModal {...props} />
      <CardDetailsPanel {...props} />
      <SelectionDialog workboard={props} />
    </section>
  );
}
