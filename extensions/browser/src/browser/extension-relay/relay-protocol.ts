/**
 * Wire protocol between the extension relay server and the OpenClaw Chrome
 * extension. The extension owns tab eligibility/access, attaches chrome.debugger,
 * and forwards CDP traffic. All CDP target semantics (Target.* synthesis for
 * Playwright) live server-side in the bridge.
 */

/** Tab snapshot reported by the extension for tabs currently accessible to OpenClaw. */
export type RelayTabInfo = {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
};

export type ExtensionToRelayMessage =
  /** First message the extension sends after the WebSocket opens. */
  | {
      type: "hello";
      userAgent: string;
      /** Full browser product string, e.g. "Chrome/144.0.7204.49". */
      browserVersion: string;
      extensionVersion: string;
      tabs: RelayTabInfo[];
    }
  /** Full refresh of accessible tabs; sent on any access-policy or tab change. */
  | { type: "tabs"; tabs: RelayTabInfo[] }
  /** CDP event emitted by an attached tab (child sessions carry sessionId). */
  | {
      type: "cdpEvent";
      tabId: number;
      sessionId?: string;
      method: string;
      params?: unknown;
    }
  /** Successful response to a relay command (cdp/attach/createTab/...). */
  | { type: "result"; seq: number; result?: unknown }
  /** Failed response to a relay command. */
  | { type: "error"; seq: number; message: string }
  /** chrome.debugger detached outside relay control (infobar cancel, tab gone). */
  | { type: "detached"; tabId: number; reason: string }
  /** Keepalive reply; message traffic keeps the MV3 worker alive. */
  | { type: "pong" };

/**
 * Command bodies sent to the extension. The bridge assigns the `seq` used to
 * correlate the extension's result/error reply.
 */
export type RelayCommandBody =
  /** Forward a CDP command into an attached tab (or one of its child sessions). */
  | { type: "cdp"; tabId: number; sessionId?: string; method: string; params?: unknown }
  /** Attach chrome.debugger to an accessible tab. Result: { targetId: string }. */
  | { type: "attach"; tabId: number }
  /** Detach chrome.debugger from a tab (access revoked or client detached). */
  | { type: "detach"; tabId: number }
  /** Create and attach a grouped tab. Result: { tabId, targetId }; Store 2.2.0 returns tabId only. */
  | { type: "createTab"; url: string; background?: boolean; focus?: boolean }
  /** Close an accessible tab. Result: {}. */
  | { type: "closeTab"; tabId: number }
  /** Focus an accessible tab (window + tab activation). Result: {}. */
  | { type: "activateTab"; tabId: number };

export type RelayToExtensionMessage =
  | (RelayCommandBody & { seq: number })
  /** Keepalive probe; the extension answers with pong. */
  | { type: "ping" };

function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRelayTabInfo(value: unknown): value is RelayTabInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!hasExactOwnKeys(value, ["tabId", "url", "title", "active"])) {
    return false;
  }
  const tab = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(tab.tabId) &&
    (tab.tabId as number) >= 0 &&
    typeof tab.url === "string" &&
    tab.url.length <= 16_384 &&
    typeof tab.title === "string" &&
    tab.title.length <= 4_096 &&
    typeof tab.active === "boolean"
  );
}

function isRelayTabInfoArray(value: unknown): value is RelayTabInfo[] {
  if (!Array.isArray(value) || value.length > 1_000 || !value.every(isRelayTabInfo)) {
    return false;
  }
  const tabIds = new Set(value.map((tab) => tab.tabId));
  return tabIds.size === value.length;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isExtensionMessage(value: unknown): value is ExtensionToRelayMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const msg = value as Record<string, unknown>;
  // Validate the fields the bridge dereferences before its synchronous dispatch.
  switch (msg.type) {
    case "hello":
      return (
        hasExactOwnKeys(msg, ["type", "userAgent", "browserVersion", "extensionVersion", "tabs"]) &&
        typeof msg.userAgent === "string" &&
        msg.userAgent.length > 0 &&
        msg.userAgent.length <= 2_048 &&
        typeof msg.browserVersion === "string" &&
        msg.browserVersion.length > 0 &&
        msg.browserVersion.length <= 512 &&
        typeof msg.extensionVersion === "string" &&
        msg.extensionVersion.length > 0 &&
        msg.extensionVersion.length <= 128 &&
        isRelayTabInfoArray(msg.tabs)
      );
    case "tabs":
      return isRelayTabInfoArray(msg.tabs);
    case "cdpEvent":
      return (
        isNonNegativeSafeInteger(msg.tabId) &&
        (msg.sessionId === undefined || typeof msg.sessionId === "string") &&
        typeof msg.method === "string"
      );
    case "result":
      return isNonNegativeSafeInteger(msg.seq);
    case "error":
      return isNonNegativeSafeInteger(msg.seq) && typeof msg.message === "string";
    case "detached":
      return isNonNegativeSafeInteger(msg.tabId) && typeof msg.reason === "string";
    case "pong":
      return true;
    default:
      return false;
  }
}

/** Parse one extension frame; returns null for malformed input. */
export function parseExtensionMessage(raw: string): ExtensionToRelayMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isExtensionMessage(parsed) ? parsed : null;
}
