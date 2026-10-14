/** @jsxImportSource @solidjs/web */
import { createSignal, For, Show } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import type { FeedItem } from "../../lib/feed/feed-view.ts";
import { formatTime, formatWakeTime } from "./feed-time.ts";

const FEED_HANDLED_PREVIEW = 5;

/** The folded "Snoozed" list under the open cards, with each wake time and Unsnooze. */
export function FeedSnoozedSection(props: {
  items: readonly FeedItem[];
  now: number;
  onUnsnooze: (item: FeedItem) => void;
}) {
  const [expanded, setExpanded] = createSignal(false);
  return (
    <Show when={props.items.length}>
      <section class="wb-feed-handled wb-feed-snoozed" aria-label={t("feed.snoozed")}>
        <h2 class="wb-feed-handled__title">
          <button
            type="button"
            class="wb-feed-snoozed__toggle"
            aria-expanded={expanded() ? "true" : "false"}
            onClick={() => setExpanded(!expanded())}
          >
            {expanded() ? icons.chevronDown : icons.chevronRight}
            {t("feed.snoozed")}
            <span>{props.items.length}</span>
          </button>
        </h2>
        <Show when={expanded()}>
          <ul class="wb-feed-handled__list">
            <For each={props.items} keyed={(item) => item.card.id}>
              {(item) => (
                <li class="wb-feed-handled__row">
                  <span class="wb-feed-snoozed__icon" aria-hidden="true">
                    {icons.clock}
                  </span>
                  <span class="wb-feed-handled__label">{item().title}</span>
                  <span class="wb-feed-handled__time">
                    {t("feed.until", {
                      time: formatWakeTime(item().snoozedUntil ?? props.now, props.now),
                    })}
                  </span>
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm"
                    onClick={() => props.onUnsnooze(item())}
                  >
                    {t("feed.unsnooze")}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  );
}

/** What the owner handled today, newest first, with a button to put a card back. */
export function FeedHandledSection(props: {
  items: readonly FeedItem[];
  now: number;
  onReopen: (item: FeedItem) => void;
}) {
  const [expanded, setExpanded] = createSignal(false);
  return (
    <Show when={props.items.length}>
      <section class="wb-feed-handled" aria-label={t("feed.handledToday")}>
        <h2 class="wb-feed-handled__title">
          {t("feed.handledToday")}
          <span>{props.items.length}</span>
        </h2>
        <ul class="wb-feed-handled__list">
          <For
            each={expanded() ? props.items : props.items.slice(0, FEED_HANDLED_PREVIEW)}
            keyed={(item) => item.card.id}
          >
            {(item) => (
              <li class="wb-feed-handled__row">
                <span class="wb-feed-handled__check" aria-hidden="true">
                  {icons.check}
                </span>
                <span class="wb-feed-handled__label">{item().doneLabel}</span>
                <span class="wb-feed-handled__time">
                  {formatTime(item().handledAt ?? props.now, props.now)}
                </span>
                <Show when={item().card.status !== "done"}>
                  <button
                    type="button"
                    class="btn btn--ghost wb-feed-tool wb-feed-handled__reopen"
                    aria-label={t("feed.reopen")}
                    title={t("feed.reopen")}
                    onClick={() => props.onReopen(item())}
                  >
                    {icons.undo}
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.items.length > FEED_HANDLED_PREVIEW}>
          <button
            type="button"
            class="wb-feed-link-button"
            onClick={() => setExpanded(!expanded())}
          >
            {expanded() ? t("feed.less") : t("feed.showAll", { count: String(props.items.length) })}
          </button>
        </Show>
      </section>
    </Show>
  );
}
