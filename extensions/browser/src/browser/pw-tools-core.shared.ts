/**
 * Shared validation and normalization helpers for Playwright-backed browser
 * tool implementations.
 */
import { stripVTControlCharacters } from "node:util";
import { parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatErrorMessage } from "../infra/errors.js";
import { BrowserActionError, BrowserError } from "./errors.js";
import { parseRoleRef } from "./pw-role-snapshot.js";

let nextUploadArmId = 0;
let nextDownloadArmId = 0;

/** Returns a new monotonic id for the currently armed file upload waiter. */
export function bumpUploadArmId(): number {
  nextUploadArmId += 1;
  return nextUploadArmId;
}

/** Returns a new monotonic id for the currently armed download waiter. */
export function bumpDownloadArmId(): number {
  nextDownloadArmId += 1;
  return nextDownloadArmId;
}

/** Normalizes role refs and raw element refs into the locator id format. */
export function requireRef(value: unknown): string {
  const raw = normalizeOptionalString(value) ?? "";
  const roleRef = raw ? parseRoleRef(raw) : null;
  const ref = roleRef ?? (raw.startsWith("@") ? raw.slice(1) : raw);
  if (!ref) {
    throw new Error("ref is required");
  }
  return ref;
}

/** Requires either a role ref or CSS selector and returns the trimmed selector mode. */
export function requireRefOrSelector(
  ref: string | undefined,
  selector: string | undefined,
): { ref?: string; selector?: string } {
  const trimmedRef = normalizeOptionalString(ref) ?? "";
  const trimmedSelector = normalizeOptionalString(selector) ?? "";
  if (!trimmedRef && !trimmedSelector) {
    throw new Error("ref or selector is required");
  }
  return {
    ref: trimmedRef || undefined,
    selector: trimmedSelector || undefined,
  };
}

/** Bounds user-facing timeout options to Playwright-safe limits. */
export function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
  const parsed = parseFiniteNumber(timeoutMs);
  return Math.max(500, Math.min(120_000, Math.floor(parsed ?? fallback)));
}

/** Converts common Playwright locator failures into model-actionable messages. */
export function toAIFriendlyError(error: unknown, selector: string): Error {
  if (error instanceof BrowserError) {
    return error;
  }
  const message = stripVTControlCharacters(formatErrorMessage(error));
  const headline = (message.split("\n", 1)[0] ?? message).replace(
    /^(?:Error:\s*)?(?:locator\.\w+:\s*)?(?:Error:\s*)?/,
    "",
  );
  const locatorTimeout = /^Timeout \d+ms exceeded\./.test(headline);
  const label = truncateUtf16Safe(selector, 200);
  const failure = (detail: string) => new BrowserActionError(detail, 500, { cause: error });

  if (headline.startsWith("strict mode violation")) {
    const countMatch = headline.match(/resolved to (\d+) elements/);
    const count = countMatch ? countMatch[1] : "multiple";
    return failure(
      `Selector "${label}" matched ${count} elements. ` +
        `Run a new snapshot to get updated refs, or use a different ref.`,
    );
  }

  const fillFailures: Array<[RegExp, string]> = [
    [
      /^Element is not an <input>/i,
      "is not editable: this control does not support text input. Use an editable input, textarea, or contenteditable element.",
    ],
    [
      /^Cannot type text into input\[type=number\]/i,
      "requires a numeric value. Use a valid number instead of text.",
    ],
    [
      /^Input of type "[^"]+" cannot be filled/i,
      "has an input type that cannot be filled. Use the interaction appropriate for this control.",
    ],
    [/^Malformed value/i, "rejected the value format. Use a value supported by this input type."],
  ];
  for (const [pattern, detail] of fillFailures) {
    if (pattern.test(headline)) {
      return failure(`Element "${label}" ${detail}`);
    }
  }

  // Playwright logs its waiting checklist before the actual failed state.
  // Only timeout failures use the last logged state; a later transport failure must win.
  for (const line of locatorTimeout ? message.split("\n").toReversed() : [headline]) {
    const diagnostic = line.trim().replace(/^(?:-\s*|\d+\s*×\s*)/, "");
    const state = diagnostic
      .match(/^element is not (editable|enabled|visible|stable)$/i)?.[1]
      ?.toLowerCase();
    if (state === "editable") {
      return failure(
        `Element "${label}" is not editable (for example, read-only). Use an editable control.`,
      );
    }
    if (state === "enabled") {
      return failure(
        `Element "${label}" is not enabled. Complete any prerequisites that enable the control.`,
      );
    }
    if (state === "stable") {
      return failure(
        `Element "${label}" is not stable. Wait for movement or animation to finish before interacting.`,
      );
    }
    if (
      state === "visible" ||
      /^<.*>.*intercepts pointer events$/.test(diagnostic) ||
      /^Element is not (?:receiving|receive) pointer events/i.test(diagnostic)
    ) {
      return failure(
        `Element "${label}" is not interactable (${state === "visible" ? "not visible" : "covered; another element intercepts pointer events"}). ` +
          `Try scrolling it into view, closing overlays, or re-snapshotting.`,
      );
    }
  }

  if (
    locatorTimeout &&
    !message.includes("locator resolved to") &&
    (message.includes("to be visible") ||
      message.includes("waiting for locator(") ||
      message.includes("waiting for getByRole("))
  ) {
    return failure(
      `Element "${label}" not found or not visible. ` +
        `Run a new snapshot to see current page elements.`,
    );
  }

  return error instanceof Error ? error : new Error(message);
}
