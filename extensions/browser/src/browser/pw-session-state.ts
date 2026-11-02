import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  isFutureDateTimestampMs,
  parseFiniteNumber,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ConsoleMessage, Dialog, Frame, Page, Request, Response } from "playwright-core";
import { saveBrowserDownload } from "./pw-download-capture.js";
import {
  MAX_CONSOLE_MESSAGES,
  MAX_NETWORK_REQUESTS,
  MAX_PAGE_ERRORS,
  MAX_RECENT_DIALOGS,
  OBSERVED_DIALOG_TIMEOUT_MS,
  pageStates,
  type ArmedDialogResponse,
  type BrowserObservedDialogRecord,
  type BrowserObservedState,
  type BrowserConsoleMessage,
  type PageState,
  type PendingObservedDialog,
  type RoleRefs,
  type RoleRefsCacheEntry,
  BrowserObservedDialogBlockedError,
} from "./pw-session-contracts.js";

// Best-effort cache to make role refs stable even if Playwright returns a different Page object
// for the same CDP target across requests.
const roleRefsByTarget = new Map<string, RoleRefsCacheEntry>();
const MAX_ROLE_REFS_CACHE = 50;
const MAX_OBSERVED_PAGE_TEXT_CHARS = 2_048;

function truncateObservedPageText(value: string): string {
  return truncateUtf16Safe(value, MAX_OBSERVED_PAGE_TEXT_CHARS);
}

export function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

export function targetKey(cdpUrl: string, targetId: string) {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

export function bindRoleRefsTarget(page: Page, cdpUrl: string, targetId?: string | null): void {
  const normalizedTargetId = normalizeOptionalString(targetId);
  if (!normalizedTargetId) {
    return;
  }
  const state = ensurePageState(page);
  const key = targetKey(cdpUrl, normalizedTargetId);
  if (state.roleRefsInvalidated) {
    roleRefsByTarget.delete(key);
  }
  state.roleRefsInvalidated = false;
  state.roleRefsTargetKey = key;
}

export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  frame?: Frame;
  mode: NonNullable<PageState["roleRefsMode"]>;
}): void {
  if (opts.frameSelector && !opts.frame) {
    throw new Error("Frame-scoped role refs require their resolved frame.");
  }
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrame = opts.frame;
  state.roleRefsMode = opts.mode;
  const targetId = normalizeOptionalString(opts.targetId);
  if (!targetId) {
    state.roleRefsTargetKey = undefined;
    return;
  }
  bindRoleRefsTarget(opts.page, opts.cdpUrl, targetId);
  const key = targetKey(opts.cdpUrl, targetId);
  // A selector cannot preserve frame identity across replacement Page objects.
  // Frame-scoped refs remain local and require a fresh snapshot after reconnect.
  if (opts.frameSelector) {
    roleRefsByTarget.delete(key);
    return;
  }
  roleRefsByTarget.set(key, { refs: opts.refs, mode: opts.mode });
  pruneMapToMaxSize(roleRefsByTarget, MAX_ROLE_REFS_CACHE);
}

function clearRoleRefs(state: PageState): void {
  if (state.roleRefsTargetKey) {
    // A delayed event from an older wrapper may evict newer refs; a snapshot repairs it.
    roleRefsByTarget.delete(state.roleRefsTargetKey);
  }
  state.roleRefs = undefined;
  state.roleRefsMode = undefined;
  state.roleRefsFrame = undefined;
  state.roleRefsTargetKey = undefined;
}

function currentTargetRoleRefsMode(
  state: PageState,
): NonNullable<PageState["roleRefsMode"]> | undefined {
  if (!state.roleRefsTargetKey) {
    return undefined;
  }
  return roleRefsByTarget.get(state.roleRefsTargetKey)?.mode;
}

export function restoreRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
}): void {
  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  if (!targetId) {
    return;
  }
  const cacheKey = targetKey(opts.cdpUrl, targetId);
  bindRoleRefsTarget(opts.page, opts.cdpUrl, targetId);
  const cached = roleRefsByTarget.get(cacheKey);
  if (!cached) {
    return;
  }
  const state = ensurePageState(opts.page);
  if (state.roleRefs) {
    return;
  }
  state.roleRefs = cached.refs;
  state.roleRefsMode = cached.mode;
}

export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) {
    return existing;
  }

  const state: PageState = {
    console: [],
    errors: [],
    requests: new Map(),
    requestIds: new WeakMap(),
    nextRequestId: 0,
    armIdUpload: 0,
    armIdDownload: 0,
    downloadWaiterDepth: 0,
    nextObservedDialogId: 0,
    pendingDialogs: [],
    recentDialogs: [],
    dialogAbortControllers: new Set(),
  };
  pageStates.set(page, state);

  page.on("console", (msg: ConsoleMessage) => {
    const location = msg.location();
    const entry: BrowserConsoleMessage = {
      type: truncateObservedPageText(msg.type()),
      text: truncateObservedPageText(msg.text()),
      timestamp: new Date().toISOString(),
      location: { ...location, url: truncateObservedPageText(location.url) },
    };
    state.console.push(entry);
    if (state.console.length > MAX_CONSOLE_MESSAGES) {
      state.console.shift();
    }
  });
  page.on("pageerror", (err: Error) => {
    state.errors.push({
      message: truncateObservedPageText(err.message || String(err)),
      name: err.name ? truncateObservedPageText(err.name) : undefined,
      stack: err.stack ? truncateObservedPageText(err.stack) : undefined,
      timestamp: new Date().toISOString(),
    });
    if (state.errors.length > MAX_PAGE_ERRORS) {
      state.errors.shift();
    }
  });
  page.on("request", (req: Request) => {
    state.nextRequestId += 1;
    const id = `r${state.nextRequestId}`;
    state.requestIds.set(req, id);
    state.requests.set(id, {
      id,
      timestamp: new Date().toISOString(),
      method: req.method(),
      url: truncateObservedPageText(req.url()),
      resourceType: req.resourceType(),
    });
    pruneMapToMaxSize(state.requests, MAX_NETWORK_REQUESTS);
  });
  page.on("response", (resp: Response) => {
    const id = state.requestIds.get(resp.request());
    const rec = id ? state.requests.get(id) : undefined;
    if (!rec) {
      return;
    }
    rec.status = resp.status();
    rec.ok = resp.ok();
  });
  page.on("requestfailed", (req: Request) => {
    const id = state.requestIds.get(req);
    const rec = id ? state.requests.get(id) : undefined;
    if (!rec) {
      return;
    }
    const failureText = req.failure()?.errorText;
    rec.failureText = failureText ? truncateObservedPageText(failureText) : undefined;
    rec.ok = false;
  });
  page.on("dialog", (dialog: Dialog) => {
    state.nextObservedDialogId += 1;
    const type = dialog.type();
    const defaultValue = dialog.defaultValue();
    const pending: PendingObservedDialog = {
      id: `d${state.nextObservedDialogId}`,
      type,
      message: dialog.message(),
      openedAt: new Date().toISOString(),
      dialog,
      ...(type === "prompt" ? { defaultValue } : {}),
    };
    state.pendingDialogs.push(pending);

    const armed = state.armedDialogResponse;
    if (armed && isFutureDateTimestampMs(armed.expiresAt)) {
      clearArmedDialogResponse(state);
      void settleObservedDialog({
        state,
        pending,
        accept: armed.accept,
        ...(armed.promptText !== undefined ? { promptText: armed.promptText } : {}),
        closedBy: "armed",
      }).catch((err: unknown) => abortActionsBlockedByDialog(state, err));
      return;
    }
    if (armed) {
      clearArmedDialogResponse(state);
    }
    abortActionsBlockedByDialog(state);
  });
  page.on("download", (download) => {
    if (state.downloadWaiterDepth > 0) {
      return;
    }
    const actionCapture = state.actionDownloadCapture;
    const managedSave = saveBrowserDownload(download, actionCapture);
    managedSave.catch(() => {});
    download.path = async () => (await managedSave).path;
    if (actionCapture) {
      actionCapture.lastEventAtMs = performance.now();
    }
    actionCapture?.pending.push(managedSave);
    for (const finish of actionCapture?.waiters.splice(0) ?? []) {
      finish();
    }
  });
  const invalidateFrameRefs = (frame: Frame, navigated: boolean) => {
    const isMainFrame = frame === page.mainFrame();
    if (!state.roleRefsTargetKey) {
      state.roleRefsInvalidated = true;
    }
    const pageWideAriaRefs =
      state.roleRefsMode === "aria" || currentTargetRoleRefsMode(state) === "aria";
    if ((navigated && isMainFrame) || pageWideAriaRefs || frame === state.roleRefsFrame) {
      clearRoleRefs(state);
    }
  };
  page.on("framenavigated", (frame) => invalidateFrameRefs(frame, true));
  page.on("framedetached", (frame) => invalidateFrameRefs(frame, false));
  page.on("close", () => {
    const emulationSession = state.emulation?.session;
    state.emulation = undefined;
    void emulationSession?.then((session) => session.detach()).catch(() => {});
    clearArmedDialogResponse(state);
    for (const controller of state.dialogAbortControllers) {
      if (!controller.signal.aborted) {
        controller.abort(new Error("Page closed before browser action completed."));
      }
    }
    state.dialogAbortControllers.clear();
    state.pendingDialogs = [];
    pageStates.delete(page);
  });

  return state;
}

export function getObservedBrowserStateForPage(page: Page): BrowserObservedState {
  const state = ensurePageState(page);
  return serializeObservedBrowserState(state);
}

export async function respondToObservedDialogOnPage(opts: {
  page: Page;
  dialogId?: string;
  accept: boolean;
  promptText?: string;
  closedBy?: "agent" | "armed";
}): Promise<BrowserObservedDialogRecord> {
  const state = ensurePageState(opts.page);
  const pending = resolvePendingDialogForResponse({
    state,
    ...(opts.dialogId !== undefined ? { dialogId: opts.dialogId } : {}),
  });
  return await settleObservedDialog({
    state,
    pending,
    accept: opts.accept,
    ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
    closedBy: opts.closedBy ?? "agent",
  });
}

export function markObservedDialogsHandledRemotelyForPage(
  page: Page,
  dialogs: readonly BrowserObservedDialogRecord[],
): BrowserObservedState {
  const state = ensurePageState(page);
  // A late action completion owns only the dialogs that interrupted it. A newer
  // dialog may already be pending while the earlier action's guard settles.
  const ids = new Set(dialogs.map((dialog) => dialog.id));
  const pending = state.pendingDialogs.filter((dialog) => ids.has(dialog.id));
  state.pendingDialogs = state.pendingDialogs.filter((dialog) => !ids.has(dialog.id));
  for (const dialog of pending) {
    recordClosedDialog(state, dialog, "remote");
  }
  return serializeObservedBrowserState(state);
}

export function armObservedDialogResponseOnPage(opts: {
  page: Page;
  accept: boolean;
  promptText?: string;
  timeoutMs?: number;
}): void {
  const state = ensurePageState(opts.page);
  clearArmedDialogResponse(state);
  const parsed = parseFiniteNumber(opts.timeoutMs);
  const timeoutMs = Math.max(1, Math.floor(parsed ?? OBSERVED_DIALOG_TIMEOUT_MS));
  const expiresAt = resolveExpiresAtMsFromDurationMs(timeoutMs);
  if (expiresAt === undefined) {
    return;
  }
  const response: ArmedDialogResponse = {
    accept: opts.accept,
    expiresAt,
    ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
  };
  response.timer = setTimeout(() => {
    state.armedDialogResponse = undefined;
  }, timeoutMs);
  state.armedDialogResponse = response;
}

export function createObservedDialogAbortSignalForPage(opts: {
  page: Page;
  parentSignal?: AbortSignal;
}): { signal: AbortSignal; cleanup: () => void } {
  const state = ensurePageState(opts.page);
  const controller = new AbortController();
  const abortForCurrentDialog = () => {
    if (!controller.signal.aborted) {
      controller.abort(new BrowserObservedDialogBlockedError(serializeObservedBrowserState(state)));
    }
  };
  if (state.pendingDialogs.length > 0) {
    abortForCurrentDialog();
  } else {
    state.dialogAbortControllers.add(controller);
  }
  return {
    signal: opts.parentSignal
      ? AbortSignal.any([controller.signal, opts.parentSignal])
      : controller.signal,
    cleanup: () => {
      state.dialogAbortControllers.delete(controller);
    },
  };
}

function recordClosedDialog(
  state: PageState,
  dialog: BrowserObservedDialogRecord,
  closedBy: NonNullable<BrowserObservedDialogRecord["closedBy"]>,
): BrowserObservedDialogRecord {
  const record = { ...serializeDialogRecord(dialog), closedAt: new Date().toISOString(), closedBy };
  state.recentDialogs.push(record);
  while (state.recentDialogs.length > MAX_RECENT_DIALOGS) {
    state.recentDialogs.shift();
  }
  return record;
}

function serializeDialogRecord(dialog: BrowserObservedDialogRecord): BrowserObservedDialogRecord {
  return {
    id: dialog.id,
    type: dialog.type,
    message: dialog.message,
    ...(dialog.defaultValue !== undefined ? { defaultValue: dialog.defaultValue } : {}),
    openedAt: dialog.openedAt,
    ...(dialog.closedAt !== undefined ? { closedAt: dialog.closedAt } : {}),
    ...(dialog.closedBy !== undefined ? { closedBy: dialog.closedBy } : {}),
  };
}

function serializeObservedBrowserState(state: PageState): BrowserObservedState {
  return {
    dialogs: {
      pending: state.pendingDialogs.map(serializeDialogRecord),
      recent: state.recentDialogs.map(serializeDialogRecord),
    },
  };
}

function clearArmedDialogResponse(state: PageState): void {
  if (state.armedDialogResponse?.timer) {
    clearTimeout(state.armedDialogResponse.timer);
  }
  state.armedDialogResponse = undefined;
}

function abortActionsBlockedByDialog(state: PageState, reason?: unknown): void {
  if (state.dialogAbortControllers.size === 0) {
    return;
  }
  const err = reason ?? new BrowserObservedDialogBlockedError(serializeObservedBrowserState(state));
  for (const controller of state.dialogAbortControllers) {
    controller.abort(err);
  }
  state.dialogAbortControllers.clear();
}

async function settleObservedDialog(params: {
  state: PageState;
  pending: PendingObservedDialog;
  accept: boolean;
  promptText?: string;
  closedBy: NonNullable<BrowserObservedDialogRecord["closedBy"]>;
}): Promise<BrowserObservedDialogRecord> {
  const { state, pending } = params;
  state.pendingDialogs = state.pendingDialogs.filter((dialog) => dialog.id !== pending.id);

  let closedBy = params.closedBy;
  try {
    if (params.accept) {
      await pending.dialog.accept(params.promptText);
    } else {
      await pending.dialog.dismiss();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.toLowerCase().includes("no dialog is showing")) {
      throw err;
    }
    closedBy = "remote";
  }

  return recordClosedDialog(state, pending, closedBy);
}

function resolvePendingDialogForResponse(params: {
  state: PageState;
  dialogId?: string;
}): PendingObservedDialog {
  const dialogId = normalizeOptionalString(params.dialogId);
  if (dialogId) {
    const found = params.state.pendingDialogs.find((dialog) => dialog.id === dialogId);
    if (found) {
      return found;
    }
    throw new Error(`Dialog "${dialogId}" is not pending.`);
  }
  if (params.state.pendingDialogs.length === 1) {
    return expectDefined(params.state.pendingDialogs.at(0), "single pending browser dialog");
  }
  if (params.state.pendingDialogs.length > 1) {
    throw new Error("Multiple dialogs are pending; pass dialogId.");
  }
  throw new Error("No dialog is pending.");
}
