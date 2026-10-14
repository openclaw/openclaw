/** @jsxImportSource @solidjs/web */
import { createSignal, For } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import { feedSnoozeOptions } from "../../lib/feed/feed-view.ts";
import { formatWakeTime } from "./feed-time.ts";

/** The value a datetime-local input expects, in local time. */
function toLocalInputValue(at: number): string {
  return new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The in-card snooze choices. The card clips overflow for its fold animation, so no popover. */
export function FeedSnoozePanel(props: {
  now: number;
  locked: boolean;
  onPick: (until: number) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = createSignal("");
  const customAt = () => (custom() ? new Date(custom()).getTime() : Number.NaN);
  return (
    <div
      class="wb-feed-snooze"
      role="group"
      aria-label={t("feed.snoozeTitle")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          props.onClose();
        }
      }}
    >
      <div class="wb-feed-snooze__head">
        <span>{t("feed.snoozeTitle")}</span>
        <button
          type="button"
          class="btn btn--ghost wb-feed-tool"
          aria-label={t("common.cancel")}
          title={t("common.cancel")}
          onClick={() => props.onClose()}
        >
          {icons.x}
        </button>
      </div>
      <div class="wb-feed-snooze__options">
        <For each={feedSnoozeOptions(props.now)} keyed={(option) => option.id}>
          {(option) => (
            <button
              type="button"
              class="wb-feed-snooze__option"
              disabled={props.locked}
              onClick={() => props.onPick(option().until)}
            >
              <span>{t(`feed.snoozeOption.${option().id}`)}</span>
              <span class="wb-feed-snooze__when">{formatWakeTime(option().until, props.now)}</span>
            </button>
          )}
        </For>
      </div>
      <div class="wb-feed-snooze__custom">
        <input
          type="datetime-local"
          class="wb-feed-snooze__input"
          aria-label={t("feed.snoozePick")}
          min={toLocalInputValue(props.now)}
          onInput={(event) => setCustom(event.currentTarget.value)}
        />
        <button
          type="button"
          class="btn"
          disabled={props.locked || !(customAt() > props.now)}
          onClick={() => props.onPick(customAt())}
        >
          {t("feed.snooze")}
        </button>
      </div>
    </div>
  );
}
