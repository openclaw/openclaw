/**
 * Browser action request normalization.
 *
 * Converts loosely typed route bodies into the closed BrowserActRequest union
 * used by Playwright and Chrome MCP action executors.
 */
import { filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  ACT_MAX_BATCH_ACTIONS,
  ACT_MAX_BATCH_DEPTH,
  ACT_MAX_CLICK_DELAY_MS,
  ACT_MAX_VIEWPORT_DIMENSION,
  ACT_MAX_WAIT_TIME_MS,
  normalizeActBoundedNonNegativeMs,
} from "../act-policy.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import { normalizeBrowserFormFields } from "../form-fields.js";
import { resolveTargetIdFromTabs } from "../target-id.js";
import { isActKind, parseClickButton, parseClickModifiers } from "./agent.act.shared.js";
import {
  readRouteFiniteNumber,
  readRouteInteger,
  readRouteNonNegativeInteger,
  readRouteTimerTimeoutMs,
} from "./route-numeric.js";
import { toBoolean, toStringArray, toStringOrEmpty } from "./utils.js";

const KEY_ALIASES = new Map([
  ["esc", "Escape"],
  ["return", "Enter"],
  ["del", "Delete"],
  ["ctrl", "Control"],
  ["cmd", "Meta"],
  ["space", "Space"],
]);

/**
 * KeyboardEvent.key for Space is the literal " ". Map that exact whole value
 * before trim so Browser panel Space presses survive. Keep trim-first chord
 * splitting for every other input so whitespace-padded Plus (`" + "`, `"+ "`)
 * still normalizes to `"+"`; use named `Ctrl+Space` for Space chords.
 */
function normalizePressKeyChord(raw: unknown): string {
  if (raw === " ") {
    return "Space";
  }
  // Empty chord segments represent a literal plus key and must survive normalization.
  return toStringOrEmpty(raw)
    .split("+")
    .map((part) => KEY_ALIASES.get(part.toLowerCase()) ?? part)
    .join("+");
}

function countBatchActions(actions: BrowserActRequest[]): number {
  let count = 0;
  for (const action of actions) {
    count += 1;
    if (action.kind === "batch") {
      count += countBatchActions(action.actions);
    }
  }
  return count;
}

/** Keep nested action overrides inside the route-selected tab. */
export function canonicalizeActTargetIds(
  action: BrowserActRequest,
  tab: { targetId: string; suggestedTargetId?: string; tabId?: string; label?: string },
  tabs = [tab],
  batched = false,
): string | null {
  if (action.targetId) {
    const resolved = resolveTargetIdFromTabs(action.targetId, batched ? tabs : [tab]);
    if (!resolved.ok || resolved.targetId !== tab.targetId) {
      return batched
        ? "batched action targetId must match request targetId"
        : "action targetId must match request targetId";
    }
    // The Playwright executor treats action.targetId as an exact override.
    action.targetId = tab.targetId;
  }
  if (action.kind === "batch") {
    for (const subAction of action.actions) {
      const error = canonicalizeActTargetIds(subAction, tab, tabs, true);
      if (error) {
        return error;
      }
    }
  }
  return null;
}

function normalizeFields(rawFields: unknown) {
  return normalizeBrowserFormFields(Array.isArray(rawFields) ? rawFields : []);
}

function normalizeBatchAction(value: unknown, depth: number): BrowserActRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("batch actions must be objects");
  }
  return normalizeActRequest(value as Record<string, unknown>, { source: "batch", depth });
}

function readActionNonNegativeInteger(
  body: Record<string, unknown>,
  key: string,
): number | undefined {
  return readRouteNonNegativeInteger(body[key], key);
}

function readActionTimeoutMs(body: Record<string, unknown>): number | undefined {
  return readRouteTimerTimeoutMs(body.timeoutMs);
}

function readBoundedActionDurationMs(
  body: Record<string, unknown>,
  key: string,
  fieldName: string,
  maxMs: number,
): number | undefined {
  return normalizeActBoundedNonNegativeMs(
    readActionNonNegativeInteger(body, key),
    fieldName,
    maxMs,
  );
}

function readResizeDimension(body: Record<string, unknown>, key: "width" | "height") {
  const value = readRouteInteger(body[key], key, {
    invalidMessage: "resize requires positive width and height",
  });
  if (value === undefined && Object.hasOwn(body, key)) {
    throw new Error("resize requires positive width and height");
  }
  return value;
}

function definedAction<T extends BrowserActRequest>(action: T): T {
  for (const key in action) {
    if (action[key] === undefined) {
      delete action[key];
    }
  }
  return action;
}

/** Normalize one model/client action payload into a BrowserActRequest. */
export function normalizeActRequest(
  body: Record<string, unknown>,
  options?: { source?: "request" | "batch"; depth?: number },
): BrowserActRequest {
  const source = options?.source ?? "request";
  const depth = options?.depth ?? 0;
  const kind = toStringOrEmpty(body.kind);
  if (!isActKind(kind)) {
    throw new Error("kind is required");
  }
  const targetId = toStringOrEmpty(body.targetId) || undefined;

  switch (kind) {
    case "click": {
      const ref = toStringOrEmpty(body.ref) || undefined;
      const selector = toStringOrEmpty(body.selector) || undefined;
      if (!ref && !selector) {
        throw new Error("click requires ref or selector");
      }
      const buttonRaw = toStringOrEmpty(body.button);
      const button = buttonRaw ? parseClickButton(buttonRaw) : undefined;
      if (buttonRaw && !button) {
        throw new Error("click button must be left|right|middle");
      }
      const modifiersRaw = toStringArray(body.modifiers) ?? [];
      const parsedModifiers = parseClickModifiers(modifiersRaw);
      if (parsedModifiers.error) {
        throw new Error(parsedModifiers.error);
      }
      const doubleClick = toBoolean(body.doubleClick);
      const delayMs = readBoundedActionDurationMs(
        body,
        "delayMs",
        "click delayMs",
        ACT_MAX_CLICK_DELAY_MS,
      );
      const timeoutMs = readActionTimeoutMs(body);
      return definedAction({
        kind,
        ref,
        selector,
        targetId,
        doubleClick,
        button,
        modifiers: parsedModifiers.modifiers,
        delayMs,
        timeoutMs,
      });
    }
    case "clickCoords": {
      const x = readRouteFiniteNumber(body.x, "x");
      const y = readRouteFiniteNumber(body.y, "y");
      if (x === undefined || y === undefined || x < 0 || y < 0) {
        throw new Error("clickCoords requires non-negative x and y");
      }
      const buttonRaw = toStringOrEmpty(body.button);
      const button = buttonRaw ? parseClickButton(buttonRaw) : undefined;
      if (buttonRaw && !button) {
        throw new Error("clickCoords button must be left|right|middle");
      }
      const doubleClick = toBoolean(body.doubleClick);
      const delayMs = readBoundedActionDurationMs(
        body,
        "delayMs",
        "clickCoords delayMs",
        ACT_MAX_CLICK_DELAY_MS,
      );
      const timeoutMs = readActionTimeoutMs(body);
      return definedAction({ kind, x, y, targetId, doubleClick, button, delayMs, timeoutMs });
    }
    case "type": {
      const ref = toStringOrEmpty(body.ref) || undefined;
      const selector = toStringOrEmpty(body.selector) || undefined;
      const text = body.text;
      if (!ref && !selector) {
        throw new Error("type requires ref or selector");
      }
      if (typeof text !== "string") {
        throw new Error("type requires text");
      }
      const submit = toBoolean(body.submit);
      const slowly = toBoolean(body.slowly);
      const timeoutMs = readActionTimeoutMs(body);
      return definedAction({ kind, ref, selector, text, targetId, submit, slowly, timeoutMs });
    }
    case "insertText": {
      if (typeof body.text !== "string") {
        throw new Error("insertText requires text");
      }
      return definedAction({ kind, text: body.text, targetId });
    }
    case "press": {
      const key = normalizePressKeyChord(body.key);
      if (!key) {
        throw new Error("press requires key");
      }
      const delayMs = readActionNonNegativeInteger(body, "delayMs");
      return definedAction({ kind, key, targetId, delayMs });
    }
    case "hover":
    case "scrollIntoView": {
      const ref = toStringOrEmpty(body.ref) || undefined;
      const selector = toStringOrEmpty(body.selector) || undefined;
      if (!ref && !selector) {
        throw new Error(`${kind} requires ref or selector`);
      }
      const timeoutMs = readActionTimeoutMs(body);
      return definedAction({ kind, ref, selector, targetId, timeoutMs });
    }
    case "drag": {
      const startRef = toStringOrEmpty(body.startRef) || undefined;
      const startSelector = toStringOrEmpty(body.startSelector) || undefined;
      const endRef = toStringOrEmpty(body.endRef) || undefined;
      const endSelector = toStringOrEmpty(body.endSelector) || undefined;
      if (!startRef && !startSelector) {
        throw new Error("drag requires startRef or startSelector");
      }
      if (!endRef && !endSelector) {
        throw new Error("drag requires endRef or endSelector");
      }
      const timeoutMs = readActionTimeoutMs(body);
      return definedAction({
        kind,
        startRef,
        startSelector,
        endRef,
        endSelector,
        targetId,
        timeoutMs,
      });
    }
    case "select": {
      const ref = toStringOrEmpty(body.ref) || undefined;
      const selector = toStringOrEmpty(body.selector) || undefined;
      // Option values are content: empty strings and surrounding whitespace can identify a choice.
      const values = filterStringEntries(body.values);
      if ((!ref && !selector) || !values.length) {
        throw new Error("select requires ref/selector and values");
      }
      const timeoutMs = readActionTimeoutMs(body);
      return definedAction({ kind, ref, selector, values, targetId, timeoutMs });
    }
    case "fill": {
      const fields = normalizeFields(body.fields);
      if (!fields.length) {
        throw new Error("fill requires fields");
      }
      const timeoutMs = readActionTimeoutMs(body);
      return definedAction({ kind, fields, targetId, timeoutMs });
    }
    case "resize": {
      const width = readResizeDimension(body, "width");
      const height = readResizeDimension(body, "height");
      if (width === undefined || height === undefined || width <= 0 || height <= 0) {
        throw new Error("resize requires positive width and height");
      }
      if (width > ACT_MAX_VIEWPORT_DIMENSION || height > ACT_MAX_VIEWPORT_DIMENSION) {
        throw new Error(`resize width and height must not exceed ${ACT_MAX_VIEWPORT_DIMENSION}`);
      }
      return definedAction({ kind, width, height, targetId });
    }
    case "wait": {
      const loadStateRaw = toStringOrEmpty(body.loadState);
      const loadState =
        loadStateRaw === "load" ||
        loadStateRaw === "domcontentloaded" ||
        loadStateRaw === "networkidle"
          ? loadStateRaw
          : undefined;
      const timeMs = readBoundedActionDurationMs(
        body,
        "timeMs",
        "wait timeMs",
        ACT_MAX_WAIT_TIME_MS,
      );
      const text = toStringOrEmpty(body.text) || undefined;
      const textGone = toStringOrEmpty(body.textGone) || undefined;
      const selector = toStringOrEmpty(body.selector) || undefined;
      const url = toStringOrEmpty(body.url) || undefined;
      const fn = toStringOrEmpty(body.fn) || undefined;
      if (timeMs === undefined && !text && !textGone && !selector && !url && !loadState && !fn) {
        throw new Error(
          "wait requires at least one of: timeMs, text, textGone, selector, url, loadState, fn",
        );
      }
      const timeoutMs = readActionTimeoutMs(body);
      return definedAction({
        kind,
        timeMs,
        text,
        textGone,
        selector,
        url,
        loadState,
        fn,
        targetId,
        timeoutMs,
      });
    }
    case "evaluate": {
      const fn = toStringOrEmpty(body.fn);
      if (!fn) {
        throw new Error("evaluate requires fn");
      }
      const ref = toStringOrEmpty(body.ref) || undefined;
      const timeoutMs = readActionTimeoutMs(body);
      return definedAction({ kind, fn, ref, targetId, timeoutMs });
    }
    case "close": {
      return definedAction({ kind, targetId });
    }
    case "batch": {
      // Bound nesting before recursing: oversized bodies parse fine, but
      // unbounded recursion overflows the stack before the count check runs.
      // Matches the executor's ACT_MAX_BATCH_DEPTH enforcement.
      if (depth > ACT_MAX_BATCH_DEPTH) {
        throw new Error(`batch nesting exceeds maximum depth of ${ACT_MAX_BATCH_DEPTH}`);
      }
      const actions = Array.isArray(body.actions)
        ? body.actions.map((action) => normalizeBatchAction(action, depth + 1))
        : [];
      if (!actions.length) {
        throw new Error(source === "batch" ? "batch requires actions" : "actions are required");
      }
      if (countBatchActions(actions) > ACT_MAX_BATCH_ACTIONS) {
        throw new Error(`batch exceeds maximum of ${ACT_MAX_BATCH_ACTIONS} actions`);
      }
      const stopOnError = toBoolean(body.stopOnError);
      return definedAction({ kind, actions, targetId, stopOnError });
    }
  }
  throw new Error("Unsupported browser act kind");
}
