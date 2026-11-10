/** @jsxImportSource @solidjs/web */
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { workboardLocale } from "../../host.ts";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../../lib/format.ts";
import { listen } from "../../lib/listener.ts";
const subscribers = new Map<() => void, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let stopVisibility: (() => void) | undefined;
let scheduleQueued = false;
function schedule() {
  if (!subscribers.size || document.visibilityState === "hidden") {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    return;
  }
  if (scheduleQueued) {
    return;
  }
  scheduleQueued = true;
  // A render can add or remove hundreds of clocks; reconcile their timer once.
  queueMicrotask(() => {
    scheduleQueued = false;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!subscribers.size || document.visibilityState === "hidden") {
      return;
    }
    const now = Date.now();
    let delay = 60_000;
    for (const timestamp of subscribers.values()) {
      delay = Math.min(delay, 60_000 - (Math.max(0, now - timestamp) % 60_000));
    }
    timer = setTimeout(tick, delay);
  });
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
function formatAutomationTime(timestamp: number, now: number) {
  const remaining = timestamp - now;
  if (remaining <= 0) {
    return t("workboard.automationNextRunDue");
  }
  const unit = remaining >= 86_400_000 ? "day" : remaining >= 3_600_000 ? "hour" : "minute";
  const unitMs = unit === "day" ? 86_400_000 : unit === "hour" ? 3_600_000 : 60_000;
  return t("workboard.automationNextRun", {
    time: new Intl.RelativeTimeFormat(workboardLocale(), {
      numeric: "always",
    }).format(Math.ceil(remaining / unitMs), unit),
  });
}
export function RelativeTime(props: { timestamp: number; now: number; automation?: boolean }) {
  const timestamp = createMemo(() => props.timestamp);
  const [now, setNow] = createSignal(untrack(() => props.now));
  const update = () => setNow(Date.now());
  createEffect(timestamp, (value) => {
    if (!subscribers.size) {
      stopVisibility = listen(document, "visibilitychange", onVisibilityChange);
    }
    subscribers.set(update, value);
    update();
    schedule();
    return () => {
      subscribers.delete(update);
      if (!subscribers.size) {
        stopVisibility?.();
        stopVisibility = undefined;
      }
      schedule();
    };
  });
  return (
    <>
      {props.automation
        ? formatAutomationTime(timestamp(), now())
        : formatCardTime(timestamp(), now())}
    </>
  );
}
export function automationNextRunTime(timestamp: number, now: number) {
  return <RelativeTime timestamp={timestamp} now={now} automation />;
}
