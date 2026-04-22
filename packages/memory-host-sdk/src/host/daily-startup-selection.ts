import path from "node:path";
import {
  type DailyMemoryFileEntry,
  listRecentDailyMemoryFiles,
  rememberRecentDailyMemoryFile,
} from "./daily-files.js";
import { isSessionSummaryDailyMemory } from "./daily-session-summary.js";

const STARTUP_SELECTION_DAILY_DAYS_CAP = 14;

function formatDateStamp(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

function shiftDateStampByCalendarDays(stamp: string, offsetDays: number): string {
  const [yearRaw, monthRaw, dayRaw] = stamp.split("-").map((part) => Number.parseInt(part, 10));
  if (!yearRaw || !monthRaw || !dayRaw) {
    return stamp;
  }
  const shifted = new Date(Date.UTC(yearRaw, monthRaw - 1, dayRaw + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function buildStartupLocalDayCandidates(params: {
  nowMs: number;
  timezone: string;
  dailyMemoryDays: number;
}): string[] {
  const orderedDays: string[] = [];
  const localToday = formatDateStamp(params.nowMs, params.timezone);
  const daysToScan = Math.min(
    STARTUP_SELECTION_DAILY_DAYS_CAP,
    Math.max(1, Math.trunc(params.dailyMemoryDays)),
  );
  for (let offset = 0; offset < daysToScan; offset += 1) {
    orderedDays.push(shiftDateStampByCalendarDays(localToday, -offset));
  }
  return orderedDays;
}

function groupStartupPathsByDay(params: {
  entries: DailyMemoryFileEntry[];
  prioritizedPaths?: ReadonlySet<string>;
}): Map<string, string[]> {
  const prioritizedPaths = params.prioritizedPaths ?? new Set<string>();
  const entriesByDay = new Map<string, Array<{ entry: DailyMemoryFileEntry; index: number }>>();
  for (const [index, entry] of params.entries.entries()) {
    const dayEntries = entriesByDay.get(entry.day);
    if (dayEntries) {
      dayEntries.push({ entry, index });
      continue;
    }
    entriesByDay.set(entry.day, [{ entry, index }]);
  }
  return new Map(
    [...entriesByDay.entries()].map(([day, entries]) => [
      day,
      entries
        .toSorted((left, right) => {
          const leftPriority = prioritizedPaths.has(left.entry.relativePath)
            ? 0
            : left.entry.canonical
              ? 1
              : 2;
          const rightPriority = prioritizedPaths.has(right.entry.relativePath)
            ? 0
            : right.entry.canonical
              ? 1
              : 2;
          if (leftPriority !== rightPriority) {
            return leftPriority - rightPriority;
          }
          if (leftPriority === 0 && left.entry.mtimeMs !== right.entry.mtimeMs) {
            return right.entry.mtimeMs - left.entry.mtimeMs;
          }
          if (leftPriority === 0 && left.entry.canonical !== right.entry.canonical) {
            return left.entry.canonical ? 1 : -1;
          }
          if (leftPriority === 0 && left.entry.relativePath !== right.entry.relativePath) {
            return right.entry.relativePath.localeCompare(left.entry.relativePath);
          }
          return left.index - right.index;
        })
        .map(({ entry }) => entry.relativePath),
    ]),
  );
}

async function seedStartupSessionSummaryProvenance(params: {
  memoryDir: string;
  entries: DailyMemoryFileEntry[];
  sessionSummaryPaths: ReadonlySet<string>;
}): Promise<void> {
  await Promise.allSettled(
    params.entries
      .filter((entry) => params.sessionSummaryPaths.has(entry.relativePath))
      .map(async (entry) => {
        await rememberRecentDailyMemoryFile({
          memoryDir: params.memoryDir,
          fileName: entry.fileName,
          mtimeMs: entry.mtimeMs,
          sessionSummary: true,
        });
      }),
  );
}

function interleaveStartupPathsByDay(params: {
  orderedDays: string[];
  pathsByDay: Map<string, string[]>;
}): string[] {
  const relativePaths: string[] = [];
  for (let offset = 0; params.orderedDays.length > 0; offset += 1) {
    let addedAtOffset = false;
    for (const day of params.orderedDays) {
      const dayPaths = params.pathsByDay.get(day);
      const nextPath = dayPaths?.[offset];
      if (!nextPath) {
        continue;
      }
      relativePaths.push(nextPath);
      addedAtOffset = true;
    }
    if (!addedAtOffset) {
      break;
    }
  }
  return relativePaths;
}

async function resolveStartupSessionSummaryPaths(params: {
  entries: DailyMemoryFileEntry[];
  day?: string;
  readDailyMemory: (relativePath: string) => Promise<string | null>;
}): Promise<Set<string>> {
  const sessionSummaryPaths = new Set<string>();
  for (const entry of params.entries) {
    if (params.day && entry.day !== params.day) {
      continue;
    }
    const content = await params.readDailyMemory(entry.relativePath);
    if (content && isSessionSummaryDailyMemory(content)) {
      sessionSummaryPaths.add(entry.relativePath);
    }
  }
  return sessionSummaryPaths;
}

async function hasReadableStartupMemoryPathForDay(params: {
  relativePaths: string[];
  readDailyMemory: (relativePath: string) => Promise<string | null>;
}): Promise<boolean> {
  for (const relativePath of params.relativePaths) {
    const content = await params.readDailyMemory(relativePath);
    if (content?.trim()) {
      return true;
    }
  }
  return false;
}

export async function selectStartupDailyMemoryPaths(params: {
  workspaceDir: string;
  dailyMemoryDays: number;
  nowMs: number;
  timezone: string;
  readDailyMemory: (relativePath: string) => Promise<string | null>;
}): Promise<string[]> {
  const localDayCandidates = buildStartupLocalDayCandidates({
    nowMs: params.nowMs,
    timezone: params.timezone,
    dailyMemoryDays: params.dailyMemoryDays,
  });
  const localToday = formatDateStamp(params.nowMs, params.timezone);
  const localYesterday = shiftDateStampByCalendarDays(localToday, -1);
  const utcToday = formatDateStamp(params.nowMs, "UTC");
  const targetDays = [...localDayCandidates];
  if (params.dailyMemoryDays === 1 && !targetDays.includes(localYesterday)) {
    targetDays.push(localYesterday);
  }
  if (utcToday !== localToday && !targetDays.includes(utcToday)) {
    targetDays.push(utcToday);
  }
  const currentLocalDay = localDayCandidates[0];
  const entries = await listRecentDailyMemoryFiles({
    memoryDir: path.join(params.workspaceDir, "memory"),
    days: targetDays,
    persistIndex: false,
  });
  const memoryDir = path.join(params.workspaceDir, "memory");
  const summaryPriorityDays = [...new Set(targetDays)].filter(Boolean);
  const sessionSummaryPaths = new Set<string>();
  for (const day of summaryPriorityDays) {
    const daySummaryPaths = await resolveStartupSessionSummaryPaths({
      entries,
      day,
      readDailyMemory: params.readDailyMemory,
    });
    for (const relativePath of daySummaryPaths) {
      sessionSummaryPaths.add(relativePath);
    }
  }
  await seedStartupSessionSummaryProvenance({
    memoryDir,
    entries,
    sessionSummaryPaths,
  });
  const pathsByDay = groupStartupPathsByDay({
    entries,
    prioritizedPaths: sessionSummaryPaths,
  });
  const selectedDays: string[] = [];
  const existingLocalDays = localDayCandidates.filter(
    (day) => (pathsByDay.get(day)?.length ?? 0) > 0,
  );
  const boundaryDay =
    utcToday !== localToday &&
    (utcToday > localToday ||
      entries.some(
        (entry) => entry.day === utcToday && sessionSummaryPaths.has(entry.relativePath),
      ))
      ? utcToday
      : null;

  if (
    currentLocalDay &&
    (pathsByDay.get(currentLocalDay)?.length ?? 0) > 0 &&
    (await hasReadableStartupMemoryPathForDay({
      relativePaths: pathsByDay.get(currentLocalDay) ?? [],
      readDailyMemory: params.readDailyMemory,
    }))
  ) {
    selectedDays.push(currentLocalDay);
  }
  if (
    boundaryDay &&
    !selectedDays.includes(boundaryDay) &&
    (await hasReadableStartupMemoryPathForDay({
      relativePaths: pathsByDay.get(boundaryDay) ?? [],
      readDailyMemory: params.readDailyMemory,
    }))
  ) {
    selectedDays.push(boundaryDay);
  }
  if (
    params.dailyMemoryDays === 1 &&
    !selectedDays.includes(localYesterday) &&
    selectedDays.length === 0 &&
    (await hasReadableStartupMemoryPathForDay({
      relativePaths: (pathsByDay.get(localYesterday) ?? []).filter((relativePath) =>
        sessionSummaryPaths.has(relativePath),
      ),
      readDailyMemory: params.readDailyMemory,
    }))
  ) {
    selectedDays.push(localYesterday);
  }
  for (const day of existingLocalDays) {
    if (selectedDays.length >= params.dailyMemoryDays) {
      break;
    }
    if (
      !selectedDays.includes(day) &&
      (await hasReadableStartupMemoryPathForDay({
        relativePaths: pathsByDay.get(day) ?? [],
        readDailyMemory: params.readDailyMemory,
      }))
    ) {
      selectedDays.push(day);
    }
  }

  // Read the first file for each selected day before extra same-day variants so
  // UTC-boundary summaries are not starved by local-day variant fan-out.
  return interleaveStartupPathsByDay({
    orderedDays: selectedDays,
    pathsByDay,
  });
}
