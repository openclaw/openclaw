import { workboardLocale } from "../../host.ts";
import { t } from "../../i18n/index.ts";

/** A past time: "15:30", "Yesterday", or "Oct 3". */
export function formatTime(at: number, now: number): string {
  const date = new Date(at);
  if (date.toDateString() === new Date(now).toDateString()) {
    return date.toLocaleTimeString(workboardLocale(), { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return date.toDateString() === yesterday.toDateString()
    ? t("feed.yesterday")
    : date.toLocaleDateString(workboardLocale(), { month: "short", day: "numeric" });
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(workboardLocale(), { hour: "numeric", minute: "2-digit" });
}

/** A wake time: "15:30", "Tomorrow 9:00", "Mon 9:00", or "Nov 3, 9:00". */
export function formatWakeTime(at: number, now: number): string {
  const date = new Date(at);
  if (date.toDateString() === new Date(now).toDateString()) {
    return formatClock(at);
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) {
    return t("feed.tomorrowAt", { time: formatClock(at) });
  }
  const options: Intl.DateTimeFormatOptions =
    at - now < 6 * 24 * 60 * 60 * 1000
      ? { weekday: "short", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return date.toLocaleString(workboardLocale(), options);
}
