/** @jsxImportSource @solidjs/web */
import { createMemo, For, Show } from "solid-js";
import { t } from "../i18n/index.ts";
import {
  workboardCardBoardId,
  matchesBoardFilter,
  WORKBOARD_ALL_BOARDS_FILTER,
} from "../lib/workboard/board-filter.ts";
import { groupWorkboardCardsByStatus } from "../lib/workboard/derived.ts";
import { WORKBOARD_STATUSES } from "../lib/workboard/types.ts";
import { workboardPageTarget } from "../pages/workboard/page-target.ts";
import { WorkboardColumn } from "../pages/workboard/view-column.tsx";
import type { WorkboardProps } from "../pages/workboard/view-helpers.tsx";
import type { WorkboardWidgetModel } from "./runtime.ts";

type WidgetProps = { model: WorkboardWidgetModel; revision: number };

function WidgetAvailability(props: WidgetProps) {
  return (
    <>
      {!props.model.connected ? (
        <p class="workboard-widget__state" role="status">
          {t("workboard.widget.disconnected")}
        </p>
      ) : !props.model.loaded && !props.model.error ? (
        <p class="workboard-widget__state">{t("workboard.widget.loading")}</p>
      ) : props.model.error ? (
        <div class="workboard-widget__state" role="alert">
          <span>{props.model.error}</span>
          <button class="btn btn--sm" type="button" onClick={() => props.model.retryLoad()}>
            {t("common.retry")}
          </button>
        </div>
      ) : null}
    </>
  );
}

function isAvailable(model: WorkboardWidgetModel) {
  return model.connected && model.loaded && !model.error;
}

export function WorkboardMiniWidget(props: WidgetProps) {
  const boardId = () => props.model.readStringProp("boardId");
  const cards = createMemo(() => {
    void props.revision;
    return boardId()
      ? props.model.cards.filter((card) => workboardCardBoardId(card) === boardId())
      : props.model.cards;
  });
  const topCards = createMemo(() =>
    cards()
      .filter((card) => card.status === "ready" || card.status === "running")
      .toSorted(
        (left, right) =>
          Number(right.status === "running") - Number(left.status === "running") ||
          left.position - right.position ||
          left.title.localeCompare(right.title),
      )
      .slice(0, Math.min(10, props.model.readPositiveIntegerProp("limit", 5))),
  );
  return (
    <Show when={isAvailable(props.model)} fallback={<WidgetAvailability {...props} />}>
      <section class="workboard-widget-mini" data-test-id="workboard-mini-widget">
        <header>
          <strong>{boardId() ?? t("workboard.allBoards")}</strong>
          <a href={props.model.host.navigation.pageHref(workboardPageTarget(boardId()))}>
            {t("workboard.widget.openBoard")}
          </a>
        </header>
        <div class="workboard-widget-mini__counts" aria-label={t("workboard.widget.statusCounts")}>
          <For each={WORKBOARD_STATUSES} keyed={(status) => status}>
            {(status) => (
              <span title={t(`workboard.status.${status()}`)}>
                <b>{cards().filter((card) => card.status === status()).length}</b>{" "}
                {t(`workboard.status.${status()}`)}
              </span>
            )}
          </For>
        </div>
        <div class="workboard-widget-mini__cards">
          <For
            each={topCards()}
            keyed={(card) => card.id}
            fallback={<p class="workboard-widget__state">{t("workboard.widget.noActiveCards")}</p>}
          >
            {(card) => (
              <div class="workboard-widget-mini__card">
                <span class={`workboard-widget__status workboard-widget__status--${card().status}`}>
                  {t(`workboard.status.${card().status}`)}
                </span>
                <strong>{card().title}</strong>
              </div>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}

export function WorkboardCardWidget(props: WidgetProps) {
  const cardId = () => props.model.readStringProp("cardId");
  const card = createMemo(() => {
    void props.revision;
    return props.model.cards.find((candidate) => candidate.id === cardId());
  });
  const statuses = () => {
    const status = card()?.status;
    return status && !props.model.statuses.includes(status)
      ? [status, ...props.model.statuses]
      : props.model.statuses;
  };
  const canMutate = () => {
    void props.revision;
    return props.model.canMutate;
  };
  return (
    <Show
      when={cardId()}
      fallback={
        <p class="workboard-widget__state" role="alert">
          {t("workboard.widget.cardIdRequired")}
        </p>
      }
    >
      <Show when={isAvailable(props.model)} fallback={<WidgetAvailability {...props} />}>
        <Show
          when={card()}
          fallback={<p class="workboard-widget__state">{t("workboard.widget.cardMissing")}</p>}
        >
          {(current) => (
            <article class="workboard-widget-card" data-test-id="workboard-card-widget">
              <div class="workboard-widget-card__heading">
                <strong>{current().title}</strong>
                <span
                  class={`workboard-widget__status workboard-widget__status--${current().status}`}
                >
                  {t(`workboard.status.${current().status}`)}
                </span>
              </div>
              <dl class="workboard-widget-card__meta">
                <div>
                  <dt>{t("workboard.fieldPriority")}</dt>
                  <dd>
                    {current().priority.charAt(0).toUpperCase() + current().priority.slice(1)}
                  </dd>
                </div>
                <div>
                  <dt>{t("workboard.fieldAgent")}</dt>
                  <dd>{current().agentId ?? t("workboard.widget.unassigned")}</dd>
                </div>
              </dl>
              <Show when={statuses().length > 1}>
                <label class="workboard-widget-card__move">
                  <span>{t("workboard.fieldStatus")}</span>
                  <select
                    aria-label={`${t("workboard.fieldStatus")}: ${current().title}`}
                    value={current().status}
                    disabled={!canMutate()}
                    onChange={(event: Event) => void props.model.handleStatusChange(event)}
                  >
                    <For each={statuses()} keyed={(status) => status}>
                      {(status) => (
                        <option value={status()} selected={status() === current().status}>
                          {t(`workboard.status.${status()}`)}
                        </option>
                      )}
                    </For>
                  </select>
                </label>
              </Show>
            </article>
          )}
        </Show>
      </Show>
    </Show>
  );
}

export function WorkboardBoardWidget(props: WidgetProps) {
  // Absent boardId includes every board, matching the summary widget.
  const boardId = () => props.model.readStringProp("boardId");
  const filter = () => boardId() ?? WORKBOARD_ALL_BOARDS_FILTER;
  const cards = createMemo(() => {
    void props.revision;
    return props.model.cards.filter((card) => matchesBoardFilter(card, filter()));
  });
  const byStatus = createMemo(() => groupWorkboardCardsByStatus(cards(), props.model.statuses));
  const workboard: WorkboardProps = {
    get host() {
      return props.model.workboardStateHost;
    },
    get revision() {
      return props.revision;
    },
    get client() {
      return props.model.workboardClient;
    },
    get connected() {
      return props.model.connected;
    },
    get canWrite() {
      void props.revision;
      return props.model.canMutate;
    },
    agentsList: null,
    sessions: [],
    onOpenSession: (target) => props.model.host.sessions.open(target),
    onRequestUpdate: () => props.model.runtime.notify(),
  };
  return (
    <Show when={isAvailable(props.model)} fallback={<WidgetAvailability {...props} />}>
      <section class="workboard-widget-board" data-test-id="workboard-board-widget">
        <header class="workboard-widget-board__header">
          <strong>{boardId() ?? t("workboard.allBoards")}</strong>
          <span>{t("workboard.widget.cardCount", { count: String(cards().length) })}</span>
          <a href={props.model.host.navigation.pageHref(workboardPageTarget(boardId()))}>
            {t("workboard.widget.openBoard")}
          </a>
        </header>
        <div class="workboard-board workboard-board--compact workboard-widget-board__columns">
          <For each={props.model.statuses} keyed={(status) => status}>
            {(status) => (
              <WorkboardColumn
                workboard={workboard}
                status={status()}
                cards={byStatus().get(status()) ?? []}
                options={{ surface: "widget", boardFilter: filter() }}
              />
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
