import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CaptureSavedView } from "./ui-render.js";

const MAX_SAVED_VIEWS = 12;
const MAX_FILTER_ITEMS = 64;
const MAX_FILTER_VALUE_LENGTH = 256;
const MAX_NAME_LENGTH = 80;
const MAX_SEARCH_TEXT_LENGTH = 500;

function readBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? truncateUtf16Safe(trimmed, maxLength) : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => truncateUtf16Safe(item.trim(), MAX_FILTER_VALUE_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_FILTER_ITEMS);
}

function readEnum<T extends string | number | null>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

export function normalizeCaptureSavedView(value: unknown): CaptureSavedView | null {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  if (!record) {
    return null;
  }
  const id = readBoundedString(record.id, MAX_FILTER_VALUE_LENGTH);
  const name = readBoundedString(record.name, MAX_NAME_LENGTH);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    sessionIds: readStringArray(record.sessionIds),
    kindFilter: readStringArray(record.kindFilter),
    providerFilter: readStringArray(record.providerFilter),
    hostFilter: readStringArray(record.hostFilter),
    searchText:
      typeof record.searchText === "string"
        ? truncateUtf16Safe(record.searchText, MAX_SEARCH_TEXT_LENGTH)
        : "",
    headerMode: readEnum(record.headerMode, ["key", "all", "hidden"], "key"),
    viewMode: readEnum(record.viewMode, ["list", "timeline"], "list"),
    groupMode: readEnum(record.groupMode, ["none", "flow", "host-path", "burst"], "none"),
    timelineLaneMode: readEnum(record.timelineLaneMode, ["domain", "provider", "flow"], "domain"),
    timelineLaneSort: readEnum(
      record.timelineLaneSort,
      ["most-events", "most-errors", "severity", "alphabetical"],
      "most-events",
    ),
    timelineZoom: readEnum(record.timelineZoom, [75, 100, 150, 200, 300], 100),
    timelineSparklineMode: readEnum(
      record.timelineSparklineMode,
      ["session-relative", "lane-relative"],
      "session-relative",
    ),
    errorsOnly: record.errorsOnly === true,
    detailPlacement: readEnum(record.detailPlacement, ["right", "bottom"], "right"),
    payloadLayout: readEnum(record.payloadLayout, ["formatted", "raw"], null),
    payloadExtent: readEnum(record.payloadExtent, ["preview", "full"], "preview"),
  };
}

export function normalizeCaptureSavedViews(value: unknown): CaptureSavedView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const views: CaptureSavedView[] = [];
  for (const item of value) {
    const view = normalizeCaptureSavedView(item);
    if (view) {
      views.push(view);
    }
    if (views.length >= MAX_SAVED_VIEWS) {
      break;
    }
  }
  return views;
}
