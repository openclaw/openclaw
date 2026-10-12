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
import { isActKind } from "./agent.act.shared.js";
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

const ALLOWED_CLICK_MODIFIERS = new Set(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]);

function readClickButton(value: unknown, kind: "click" | "clickCoords") {
  const button = toStringOrEmpty(value);
  if (button && button !== "left" && button !== "right" && button !== "middle") {
    throw new Error(`${kind} button must be left|right|middle`);
  }
  return button || undefined;
}

function readRequiredElementTarget(body: Record<string, unknown>, kind: string) {
  const ref = toStringOrEmpty(body.ref) || undefined;
  const selector = toStringOrEmpty(body.selector) || undefined;
  if (!ref && !selector) {
    throw new Error(`${kind} requires ref or selector`);
  }
  return { ref, selector };
}

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

function normalizeBatchAction(value: unknown, depth: number): BrowserActRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("batch actions must be objects");
  }
  return normalizeActRequest(value as Record<string, unknown>, depth);
}

function readBoundedActionDurationMs(
  body: Record<string, unknown>,
  key: string,
  fieldName: string,
  maxMs: number,
): number | undefined {
  return normalizeActBoundedNonNegativeMs(
    readRouteNonNegativeInteger(body[key], key),
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

export function normalizeActRequest(body: Record<string, unknown>, depth = 0): BrowserActRequest {
  const kind = toStringOrEmpty(body.kind);
  if (!isActKind(kind)) {
    throw new Error("kind is required");
  }
  const targetId = toStringOrEmpty(body.targetId) || undefined;
  const finish = <T extends BrowserActRequest>(action: T): T => {
    action.targetId = targetId;
    switch (action.kind) {
      case "press":
      case "insertText":
      case "resize":
      case "close":
      case "batch":
        break;
      default:
        action.timeoutMs = readRouteTimerTimeoutMs(body.timeoutMs);
    }
    for (const key in action) {
      if (action[key] === undefined) {
        delete action[key];
      }
    }
    return action;
  };
  switch (kind) {
    case "click": {
      const { ref, selector } = readRequiredElementTarget(body, kind);
      const button = readClickButton(body.button, kind);
      const modifiers = toStringArray(body.modifiers);
      if (modifiers?.some((modifier) => !ALLOWED_CLICK_MODIFIERS.has(modifier))) {
        throw new Error("modifiers must be Alt|Control|ControlOrMeta|Meta|Shift");
      }
      const doubleClick = toBoolean(body.doubleClick);
      const delayMs = readBoundedActionDurationMs(
        body,
        "delayMs",
        "click delayMs",
        ACT_MAX_CLICK_DELAY_MS,
      );
      return finish({
        kind,
        ref,
        selector,
        doubleClick,
        button,
        modifiers,
        delayMs,
      });
    }
    case "clickCoords": {
      const x = readRouteFiniteNumber(body.x, "x");
      const y = readRouteFiniteNumber(body.y, "y");
      if (x === undefined || y === undefined || x < 0 || y < 0) {
        throw new Error("clickCoords requires non-negative x and y");
      }
      const button = readClickButton(body.button, kind);
      const doubleClick = toBoolean(body.doubleClick);
      const delayMs = readBoundedActionDurationMs(
        body,
        "delayMs",
        "clickCoords delayMs",
        ACT_MAX_CLICK_DELAY_MS,
      );
      return finish({ kind, x, y, doubleClick, button, delayMs });
    }
    case "type": {
      const { ref, selector } = readRequiredElementTarget(body, kind);
      const text = body.text;
      if (typeof text !== "string") {
        throw new Error("type requires text");
      }
      const submit = toBoolean(body.submit);
      const slowly = toBoolean(body.slowly);
      return finish({ kind, ref, selector, text, submit, slowly });
    }
    case "insertText": {
      if (typeof body.text !== "string") {
        throw new Error("insertText requires text");
      }
      return finish({ kind, text: body.text });
    }
    case "press": {
      const key = normalizePressKeyChord(body.key);
      if (!key) {
        throw new Error("press requires key");
      }
      const delayMs = readRouteNonNegativeInteger(body.delayMs, "delayMs");
      return finish({ kind, key, delayMs });
    }
    case "hover":
    case "scrollIntoView": {
      const { ref, selector } = readRequiredElementTarget(body, kind);
      return finish({ kind, ref, selector });
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
      return finish({
        kind,
        startRef,
        startSelector,
        endRef,
        endSelector,
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
      return finish({ kind, ref, selector, values });
    }
    case "fill": {
      const fields = normalizeBrowserFormFields(Array.isArray(body.fields) ? body.fields : []);
      if (!fields.length) {
        throw new Error("fill requires fields");
      }
      return finish({ kind, fields });
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
      return finish({ kind, width, height });
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
      return finish({
        kind,
        timeMs,
        text,
        textGone,
        selector,
        url,
        loadState,
        fn,
      });
    }
    case "evaluate": {
      const fn = toStringOrEmpty(body.fn);
      if (!fn) {
        throw new Error("evaluate requires fn");
      }
      const ref = toStringOrEmpty(body.ref) || undefined;
      return finish({ kind, fn, ref });
    }
    case "close": {
      return finish({ kind });
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
        throw new Error(depth > 0 ? "batch requires actions" : "actions are required");
      }
      if (countBatchActions(actions) > ACT_MAX_BATCH_ACTIONS) {
        throw new Error(`batch exceeds maximum of ${ACT_MAX_BATCH_ACTIONS} actions`);
      }
      const stopOnError = toBoolean(body.stopOnError);
      return finish({ kind, actions, stopOnError });
    }
  }
  throw new Error("Unsupported browser act kind");
}
