import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../../lib/format.ts";

const subscribers = new Map<() => void, number>();
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (!subscribers.size || document.visibilityState === "hidden") {
    return;
  }
  const now = Date.now();
  let delay = 60_000;
  for (const timestamp of subscribers.values()) {
    delay = Math.min(delay, 60_000 - (Math.max(0, now - timestamp) % 60_000));
  }
  timer = setTimeout(tick, delay);
}

function tick() {
  for (const update of subscribers.keys()) {
    update();
  }
  schedule();
}

function onVisibilityChange() {
  if (document.visibilityState !== "hidden") {
    tick();
  } else {
    schedule();
  }
}

function formatCardTime(value: number, now: number) {
  const minutes = Math.floor(Math.max(0, now - value) / 60_000);
  if (!minutes) {
    return t("workboard.cardUpdatedNow");
  }
  const unit = minutes >= 1440 ? 1440 : minutes >= 60 ? 60 : 1;
  return t("workboard.cardUpdatedAgo", {
    time: formatDurationCompact(Math.floor(minutes / unit) * unit * 60_000) ?? "",
  });
}

class CardRelativeTimeDirective extends AsyncDirective {
  private timestamp = 0;
  private readonly updateTime = () => this.setValue(formatCardTime(this.timestamp, Date.now()));

  render(timestamp: number, now: number) {
    this.timestamp = timestamp;
    if (this.isConnected) {
      this.subscribe();
    }
    return formatCardTime(timestamp, now);
  }

  protected override disconnected() {
    subscribers.delete(this.updateTime);
    if (!subscribers.size) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    schedule();
  }

  protected override reconnected() {
    this.updateTime();
    this.subscribe();
  }

  private subscribe() {
    if (!subscribers.size) {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    // Columns, list rows, and widgets share one clock; only their text parts update.
    subscribers.set(this.updateTime, this.timestamp);
    schedule();
  }
}

export const cardRelativeTime = directive(CardRelativeTimeDirective);
