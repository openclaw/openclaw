import type { PluginLogger } from "../api.js";

export type ReportPeriod = "日报" | "周报" | "月报";

export interface ReportTriggerResult {
  isReportRequest: boolean;
  period: ReportPeriod | null;
  dateScope: { start: string; end: string } | null;
  requirement: string;
}

/**
 * Keywords that trigger report generation, mapped to their period.
 */
const REPORT_KEYWORDS: Array<{ patterns: RegExp[]; period: ReportPeriod }> = [
  {
    patterns: [/日报/gi, /今日舆情/gi],
    period: "日报",
  },
  {
    patterns: [/周报/gi, /本周舆情/gi],
    period: "周报",
  },
  {
    patterns: [/月报/gi, /本月舆情/gi],
    period: "月报",
  },
];

/**
 * Detect if a message is a report generation request.
 * Returns the report period and computed dateScope if it is.
 */
export function detectReportRequest(message: string, logger: PluginLogger): ReportTriggerResult {
  const trimmed = message.trim();

  for (const { patterns, period } of REPORT_KEYWORDS) {
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        logger.info(`[REPORT_TRIGGER] Detected ${period} report request: "${trimmed}"`);

        return {
          isReportRequest: true,
          period,
          dateScope: computeDateScope(period),
          requirement: trimmed,
        };
      }
    }
  }

  return {
    isReportRequest: false,
    period: null,
    dateScope: null,
    requirement: trimmed,
  };
}

/**
 * Compute dateScope based on period and current time.
 * All times are in UTC+8 (Asia/Shanghai).
 */
export function computeDateScope(period: ReportPeriod): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  const dayOfWeek = now.getDay(); // 0 = Sunday

  switch (period) {
    case "日报": {
      // yesterday 00:00 ~ today 00:00
      const yesterday = new Date(year, month, date - 1);
      const today = new Date(year, month, date);
      return {
        start: formatDateTime(yesterday),
        end: formatDateTime(today),
      };
    }

    case "周报": {
      // last Monday 00:00 ~ this Sunday 00:00
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const lastMonday = new Date(year, month, date - daysFromMonday - 7);
      const thisSunday = new Date(year, month, date - daysFromMonday);
      return {
        start: formatDateTime(lastMonday),
        end: formatDateTime(thisSunday),
      };
    }

    case "月报": {
      // last month 1st 00:00 ~ this month 1st 00:00
      const lastMonth = month === 0 ? 11 : month - 1;
      const lastMonthYear = month === 0 ? year - 1 : year;
      const thisMonthYear = year;

      const lastMonthStart = new Date(lastMonthYear, lastMonth, 1);
      const thisMonthStart = new Date(thisMonthYear, month, 1);

      return {
        start: formatDateTime(lastMonthStart),
        end: formatDateTime(thisMonthStart),
      };
    }

    default: {
      // Unreachable: ReportPeriod is a closed union. Satisfies consistent-return.
      throw new Error(`Unknown report period: ${String(period)}`);
    }
  }
}

/**
 * Format date as YYYY-MM-DD HH:mm:ss in UTC+8 (Asia/Shanghai).
 */
function formatDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}
