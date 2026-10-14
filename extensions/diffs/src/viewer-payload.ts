import { DIFF_INDICATORS, DIFF_LAYOUTS, DIFF_THEMES } from "./types.js";
import type { DiffViewerPayload } from "./types.js";

const OVERFLOW_VALUES = ["scroll", "wrap"] as const;

function isViewerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseViewerPayloadJson(raw: string): DiffViewerPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Diff payload is not valid JSON.");
  }

  if (!isDiffViewerPayload(parsed)) {
    throw new Error("Diff payload has invalid shape.");
  }

  return parsed;
}

function isDiffViewerPayload(value: unknown): value is DiffViewerPayload {
  return (
    isViewerRecord(value) &&
    typeof value.prerenderedHTML === "string" &&
    Array.isArray(value.langs) &&
    value.langs.every((lang) => typeof lang === "string") &&
    isViewerOptions(value.options) &&
    (isViewerRecord(value.fileDiff) ||
      (isViewerRecord(value.oldFile) && isViewerRecord(value.newFile)))
  );
}

function isViewerOptions(value: unknown): boolean {
  return (
    isViewerRecord(value) &&
    isViewerRecord(value.theme) &&
    value.theme.light === "pierre-light" &&
    value.theme.dark === "pierre-dark" &&
    includesValue(DIFF_LAYOUTS, value.diffStyle) &&
    includesValue(DIFF_INDICATORS, value.diffIndicators) &&
    includesValue(DIFF_THEMES, value.themeType) &&
    includesValue(OVERFLOW_VALUES, value.overflow) &&
    typeof value.disableLineNumbers === "boolean" &&
    typeof value.expandUnchanged === "boolean" &&
    typeof value.backgroundEnabled === "boolean" &&
    typeof value.unsafeCSS === "string"
  );
}

function includesValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}
