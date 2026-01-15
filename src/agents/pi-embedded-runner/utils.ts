import { execSync } from "child_process";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { ExecToolDefaults } from "../bash-tools.js";

export function mapThinkingLevel(level?: ThinkLevel): ThinkingLevel {
  // pi-agent-core supports "xhigh"; Clawdbot enables it for specific models.
  if (!level) return "off";
  return level;
}

export function resolveExecToolDefaults(config?: ClawdbotConfig): ExecToolDefaults | undefined {
  const tools = config?.tools;
  if (!tools) return undefined;
  if (!tools.exec) return tools.bash;
  if (!tools.bash) return tools.exec;
  return { ...tools.bash, ...tools.exec };
}

export function resolveUserTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
      return trimmed;
    } catch {
      // ignore invalid timezone
    }
  }
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return host?.trim() || "UTC";
}

/** Auto-detect if system uses 24-hour time. Checks OS-specific prefs, then falls back to locale. */
export function detectUse24Hour(): boolean {
  // macOS: check system preference
  if (process.platform === "darwin") {
    try {
      const result = execSync("defaults read -g AppleICUForce24HourTime 2>/dev/null", {
        encoding: "utf8",
        timeout: 500,
      }).trim();
      if (result === "1") return true;
      if (result === "0") return false;
    } catch {
      // Not set, fall through
    }
  }

  // Windows: check registry time format
  if (process.platform === "win32") {
    try {
      const result = execSync(
        'powershell -Command "(Get-Culture).DateTimeFormat.ShortTimePattern"',
        { encoding: "utf8", timeout: 1000 },
      ).trim();
      if (result.startsWith("H")) return true;
      if (result.startsWith("h")) return false;
    } catch {
      // Fall through
    }
  }

  // Fallback: check locale formatting (works well on Linux)
  try {
    const sample = new Date(2000, 0, 1, 13, 0);
    const formatted = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(sample);
    return formatted.includes("13");
  } catch {
    return false;
  }
}

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

export function formatUserTime(
  date: Date,
  timeZone: string,
  use24Hour = false,
): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: use24Hour ? "2-digit" : "numeric",
      minute: "2-digit",
      hourCycle: use24Hour ? "h23" : "h12",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    if (!map.weekday || !map.year || !map.month || !map.day || !map.hour || !map.minute) {
      return undefined;
    }
    const dayNum = parseInt(map.day, 10);
    const suffix = ordinalSuffix(dayNum);
    const timePart = use24Hour
      ? `${map.hour}:${map.minute}`
      : `${map.hour}:${map.minute} ${map.dayPeriod ?? ""}`.trim();
    // "Thursday, January 15th, 2026 — 14:38" or "Thursday, January 15th, 2026 — 2:38 PM"
    return `${map.weekday}, ${map.month} ${dayNum}${suffix}, ${map.year} — ${timePart}`;
  } catch {
    return undefined;
  }
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

export type { ReasoningLevel, ThinkLevel };
