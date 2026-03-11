/**
 * Cron expression utilities — human-readable formatting and next-run calculation.
 * Pure TypeScript, no external dependencies.
 */

// Convert a cron expression to a human-readable string.
// Handles common patterns; falls back to raw expression for exotic ones.
//
// Examples:
//   cronToHuman("0 9 * * MON")   => "Mon 9:00 AM"
//   cronToHuman("0 */6 * * *")   => "Every 6h"
//   cronToHuman("*/15 * * * *")  => "Every 15m"
export function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;

  const [minute, hour, dayOfMonth, _month, dayOfWeek] = parts;

  // Every N minutes: */N * * * *
  if (minute.startsWith("*/") && hour === "*" && dayOfMonth === "*") {
    return `Every ${minute.slice(2)}m`;
  }

  // Every N hours: 0 */N * * *
  if (minute === "0" && hour.startsWith("*/") && dayOfMonth === "*") {
    return `Every ${hour.slice(2)}h`;
  }

  // Format the time portion
  const formatTime = (h: string, m: string): string => {
    const hNum = parseInt(h, 10);
    const mNum = parseInt(m, 10);
    if (isNaN(hNum)) return "";
    const ampm = hNum >= 12 ? "PM" : "AM";
    const h12 = hNum === 0 ? 12 : hNum > 12 ? hNum - 12 : hNum;
    return mNum === 0 ? `${h12} ${ampm}` : `${h12}:${String(mNum).padStart(2, "0")} ${ampm}`;
  };

  // Parse day of week names
  const parseDays = (dow: string): string => {
    if (dow === "*") return "";
    return dow
      .split(",")
      .map((d) => {
        // Handle ranges like MON-FRI
        if (d.includes("-")) {
          const [start, end] = d.split("-");
          return `${normDay(start)}-${normDay(end)}`;
        }
        return normDay(d);
      })
      .join(",");
  };

  const timeStr = formatTime(hour, minute);
  const dayStr = parseDays(dayOfWeek);

  // Specific day of month: 0 9 1 * *
  if (dayOfMonth !== "*" && dayOfWeek === "*") {
    const dom = dayOfMonth.includes("-") ? `days ${dayOfMonth}` : `day ${dayOfMonth}`;
    return timeStr ? `${dom} ${timeStr}` : `${dom}`;
  }

  // Daily at specific time: 0 9 * * *
  if (dayOfMonth === "*" && dayOfWeek === "*" && timeStr) {
    return `Daily ${timeStr}`;
  }

  // Specific days + time: 0 9 * * MON,WED,FRI
  if (dayStr && timeStr) {
    return `${dayStr} ${timeStr}`;
  }

  if (dayStr) return dayStr;
  if (timeStr) return timeStr;

  return expr;
}

function normDay(d: string): string {
  const upper = d.toUpperCase();
  const dayMap: Record<string, string> = {
    "0": "Sun",
    "1": "Mon",
    "2": "Tue",
    "3": "Wed",
    "4": "Thu",
    "5": "Fri",
    "6": "Sat",
    "7": "Sun",
    SUN: "Sun",
    MON: "Mon",
    TUE: "Tue",
    WED: "Wed",
    THU: "Thu",
    FRI: "Fri",
    SAT: "Sat",
  };
  return dayMap[upper] || d;
}

/**
 * Estimate next run from now as a relative time string.
 * This is an approximation — for exact scheduling use the backend cron service.
 *
 * @example nextRunFromNow("0 9 * * MON") => "in 2h" or "in 3d"
 */
export function nextRunFromNow(expr: string, _tz?: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return "";

  const [minute, hour] = parts;
  const now = new Date();

  // Every N minutes
  if (minute.startsWith("*/")) {
    const interval = parseInt(minute.slice(2), 10);
    if (interval > 0) {
      const minutesUntil = interval - (now.getMinutes() % interval);
      return minutesUntil <= 1 ? "in <1m" : `in ${minutesUntil}m`;
    }
  }

  // Every N hours
  if (minute === "0" && hour.startsWith("*/")) {
    const interval = parseInt(hour.slice(2), 10);
    if (interval > 0) {
      const hoursUntil = interval - (now.getHours() % interval);
      return `in ${hoursUntil}h`;
    }
  }

  // Specific hour: calculate hours until next occurrence
  const targetHour = parseInt(hour, 10);
  const targetMinute = parseInt(minute, 10);
  if (!isNaN(targetHour) && !isNaN(targetMinute)) {
    const target = new Date(now);
    target.setHours(targetHour, targetMinute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const diffMs = target.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / 60000);
    if (diffMins < 60) return `in ${diffMins}m`;
    const diffHours = Math.round(diffMins / 60);
    if (diffHours < 24) return `in ${diffHours}h`;
    return `in ${Math.round(diffHours / 24)}d`;
  }

  return "";
}
