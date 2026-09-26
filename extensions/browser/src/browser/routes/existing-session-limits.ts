import type { BrowserActRequest } from "../client-actions.types.js";

/**
 * Existing-session browser capability-limit messages.
 *
 * Centralizes unsupported-operation text so route responses and tests stay
 * stable while Chrome MCP support grows incrementally.
 */
/** User-facing messages for existing-session route limitations. */
export const EXISTING_SESSION_LIMITS = {
  act: {
    clickSelector: "existing-session click does not support selector targeting yet; use ref.",
    clickButtonOrModifiers:
      "existing-session click currently supports left-click only (no button overrides/modifiers).",
    coordinateButtonOrDelay:
      "existing-session coordinate clicks support left-click only and no delayMs; use a managed browser profile for other buttons or click delays.",
    typeSelector: "existing-session type does not support selector targeting yet; use ref.",
    typeSlowly: "existing-session type does not support slowly=true; use fill/press instead.",
    typeTimeout: "existing-session type does not support timeoutMs overrides.",
    insertText:
      "Paste is not supported for existing-session browser profiles. Use a managed browser profile.",
    pressDelay: "existing-session press does not support delayMs.",
    hoverSelector: "existing-session hover does not support selector targeting yet; use ref.",
    hoverTimeout: "existing-session hover does not support timeoutMs overrides.",
    scrollSelector:
      "existing-session scrollIntoView does not support selector targeting yet; use ref.",
    scrollTimeout: "existing-session scrollIntoView does not support timeoutMs overrides.",
    dragSelector:
      "existing-session drag does not support selector targeting yet; use startRef/endRef.",
    dragTimeout: "existing-session drag does not support timeoutMs overrides.",
    selectSelector: "existing-session select does not support selector targeting yet; use ref.",
    selectSingleValue: "existing-session select currently supports a single value only.",
    selectTimeout: "existing-session select does not support timeoutMs overrides.",
    fillTimeout: "existing-session fill does not support timeoutMs overrides.",
    waitNetworkIdle: "existing-session wait does not support loadState=networkidle yet.",
    batch: "existing-session batch is not supported yet; send actions individually.",
  },
  hooks: {
    uploadElement:
      "existing-session file uploads do not support element selectors; use ref/inputRef.",
    uploadRefRequired: "existing-session file uploads require ref or inputRef.",
    dialogId: "existing-session dialog handling does not support dialogId.",
    dialogTimeout: "existing-session dialog handling does not support timeoutMs.",
  },
  download: {
    waitUnsupported: "download waiting is not supported for existing-session profiles yet.",
    downloadUnsupported: "downloads are not supported for existing-session profiles yet.",
  },
  snapshot: {
    pdfUnsupported:
      "pdf is not supported for existing-session profiles yet; use screenshot/snapshot instead.",
    screenshotElement:
      "element screenshots are not supported for existing-session profiles; use ref from snapshot.",
    snapshotSelector:
      "selector/frame snapshots are not supported for existing-session profiles; snapshot the whole page and use refs.",
  },
  responseBody: "response body is not supported for existing-session profiles yet.",
  errors:
    "errors is not supported for existing-session profiles; use a managed browser profile to collect page errors, or snapshot to inspect the current page.",
  requests:
    "requests is not supported for existing-session profiles; use a managed browser profile to collect network requests, or snapshot to inspect the current page.",
  text: "text is not supported for existing-session profiles; use snapshot to read the page, or switch to a managed browser profile for text extraction.",
  emulation:
    "emulate is not supported for existing-session profiles; use a managed browser profile for device, media, timezone, or locale settings.",
} as const;

type ExistingSessionAction = Exclude<BrowserActRequest, { kind: "batch" | "insertText" }>;

type ExistingSessionActionAdmission =
  | { ok: true; action: ExistingSessionAction }
  | { ok: false; error: string };

/** Validate existing-session support before admitting a narrowed action to dispatch. */
export function admitExistingSessionAction(
  action: BrowserActRequest,
): ExistingSessionActionAdmission {
  let error: string | undefined;
  switch (action.kind) {
    case "click":
      if (action.selector) {
        return { ok: false, error: EXISTING_SESSION_LIMITS.act.clickSelector };
      }
      if (
        (action.button && action.button !== "left") ||
        (Array.isArray(action.modifiers) && action.modifiers.length > 0)
      ) {
        return { ok: false, error: EXISTING_SESSION_LIMITS.act.clickButtonOrModifiers };
      }
      break;
    case "clickCoords":
      error =
        (action.button && action.button !== "left") || action.delayMs
          ? EXISTING_SESSION_LIMITS.act.coordinateButtonOrDelay
          : undefined;
      break;
    case "type":
      if (action.selector) {
        return { ok: false, error: EXISTING_SESSION_LIMITS.act.typeSelector };
      }
      if (action.slowly) {
        return { ok: false, error: EXISTING_SESSION_LIMITS.act.typeSlowly };
      }
      error = action.timeoutMs ? EXISTING_SESSION_LIMITS.act.typeTimeout : undefined;
      break;
    case "insertText":
      return { ok: false, error: EXISTING_SESSION_LIMITS.act.insertText };
    case "press":
      error = action.delayMs ? EXISTING_SESSION_LIMITS.act.pressDelay : undefined;
      break;
    case "hover":
      if (action.selector) {
        return { ok: false, error: EXISTING_SESSION_LIMITS.act.hoverSelector };
      }
      error = action.timeoutMs ? EXISTING_SESSION_LIMITS.act.hoverTimeout : undefined;
      break;
    case "scrollIntoView":
      if (action.selector) {
        return { ok: false, error: EXISTING_SESSION_LIMITS.act.scrollSelector };
      }
      error = action.timeoutMs ? EXISTING_SESSION_LIMITS.act.scrollTimeout : undefined;
      break;
    case "drag":
      if (action.startSelector || action.endSelector) {
        return { ok: false, error: EXISTING_SESSION_LIMITS.act.dragSelector };
      }
      error = action.timeoutMs ? EXISTING_SESSION_LIMITS.act.dragTimeout : undefined;
      break;
    case "select":
      if (action.selector) {
        return { ok: false, error: EXISTING_SESSION_LIMITS.act.selectSelector };
      }
      if (action.values.length !== 1) {
        return { ok: false, error: EXISTING_SESSION_LIMITS.act.selectSingleValue };
      }
      error = action.timeoutMs ? EXISTING_SESSION_LIMITS.act.selectTimeout : undefined;
      break;
    case "fill":
      error = action.timeoutMs ? EXISTING_SESSION_LIMITS.act.fillTimeout : undefined;
      break;
    case "wait":
      error =
        action.loadState === "networkidle"
          ? EXISTING_SESSION_LIMITS.act.waitNetworkIdle
          : undefined;
      break;
    case "batch":
      return { ok: false, error: EXISTING_SESSION_LIMITS.act.batch };
    case "evaluate":
    case "resize":
    case "close":
      break;
    default:
      throw new Error("Unsupported browser act kind");
  }
  return error ? { ok: false, error } : { ok: true, action };
}
