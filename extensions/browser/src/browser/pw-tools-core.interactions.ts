/**
 * Playwright-backed browser interaction tools, including clicks, form input,
 * screenshots, batch actions, and SSRF-aware post-interaction navigation checks.
 */
import {
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Page } from "playwright-core";
import { formatErrorMessage } from "../infra/errors.js";
import {
  ACT_MAX_BATCH_ACTIONS,
  ACT_MAX_BATCH_DEPTH,
  ACT_MAX_CLICK_DELAY_MS,
  ACT_MAX_VIEWPORT_DIMENSION,
  ACT_MAX_WAIT_TIME_MS,
  resolveActInteractionTimeoutMs,
  resolveActWaitTimeoutMs,
} from "./act-policy.js";
import type { BrowserActRequest, BrowserFormField } from "./client-actions.types.js";
import type { BrowserDownloadResult } from "./download-types.js";
import { normalizeBrowserEvaluateFunctionSource } from "./evaluate-source.js";
import { DEFAULT_FILL_FIELD_TYPE } from "./form-fields.js";
import {
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { resolveStrictExistingUploadPaths } from "./paths.js";
import {
  assertBrowserDownloadSaveAllowed,
  assertInteractionNavigationCompletedSafely,
  awaitActionWithAbort,
  createAbortPromise,
  createAbortPromiseWithListener,
  hasBrowserNavigationPolicy,
  INTERACTION_NAVIGATION_GRACE_MS,
  isBrowserInteractionNavigationSecurityError,
  runGuardedPlaywrightPageAction,
} from "./pw-interaction-navigation-guard.js";
import {
  assertPageNavigationCompletedSafely,
  beginActionDownloadCaptureOnPage,
  createObservedDialogAbortSignalForPage,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId as getPageForTargetIdBase,
  isBrowserObservedDialogBlockedError,
  markObservedDialogsHandledRemotelyForPage,
  quarantineBlockedNavigationTargetForError,
  refLocator,
  restoreRoleRefsForTarget,
  wasBrowserNavigationRequestBlockedBeforeDispatch,
} from "./pw-session.js";
import {
  normalizeTimeoutMs,
  requireRef,
  requireRefOrSelector,
  toAIFriendlyError,
} from "./pw-tools-core.shared.js";
import {
  snapshotRoleOnPageViaPlaywright,
  type RoleSnapshotOnPageOptions,
  type RoleSnapshotResult,
} from "./pw-tools-core.snapshot-page.js";
import { closePageViaPlaywright } from "./pw-tools-core.snapshot.js";
import {
  ANNOTATION_MAX_LABELS_DEFAULT,
  type AnnotationItem,
  buildOverlayClearScript,
  buildOverlayInjectionScript,
  type CoordinateSpace,
  planAnnotations,
  type RawAnnotationInput,
} from "./screenshot-annotate.js";

type TargetOpts = {
  cdpUrl: string;
  targetId?: string;
} & BrowserNavigationPolicyOptions;

const ACT_DOWNLOAD_MAX_DRAIN_MS = 1_000;
// Playwright's highlight owns a live DOM overlay and RAF loop. Keep its whole
// visible lifetime, including disposal, inside the navigation guard.
const HIGHLIGHT_DURATION_MS = 2_000;

function resolveBoundedDelayMs(value: number | undefined, label: string, maxMs: number): number {
  const normalized = Math.floor(value ?? 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${label} must be >= 0`);
  }
  if (normalized > maxMs) {
    throw new Error(`${label} exceeds maximum of ${maxMs}ms`);
  }
  return normalized;
}

function resolveViewportDimension(value: unknown, label: "width" | "height"): number {
  const dimension = resolveIntegerOption(value, 1, { min: 1 });
  if (dimension > ACT_MAX_VIEWPORT_DIMENSION) {
    throw new Error(`viewport ${label} exceeds maximum of ${ACT_MAX_VIEWPORT_DIMENSION}`);
  }
  return dimension;
}

function getPageForTargetId(opts: TargetOpts) {
  return getPageForTargetIdBase({
    ...opts,
    pageNavigationPolicy: withBrowserNavigationPolicy(opts.ssrfPolicy, {
      browserProxyMode: opts.browserProxyMode,
    }),
  });
}

async function getRestoredPageForTarget(opts: TargetOpts) {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  return page;
}

function toFriendlyInteractionError(err: unknown, label: string): Error {
  return isBrowserObservedDialogBlockedError(err) ? err : toAIFriendlyError(err, label);
}

function reconcileRemoteDialogAfterActionSettled(page: Page, signal?: AbortSignal): void {
  if (isBrowserObservedDialogBlockedError(signal?.reason)) {
    markObservedDialogsHandledRemotelyForPage(page);
  }
}

const resolveInteractionTimeoutMs = resolveActInteractionTimeoutMs;

/** Highlights a role ref in the target page for visual inspection. */
export async function highlightViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  opts.signal?.throwIfAborted();
  const page = await getRestoredPageForTarget(opts);
  const ref = requireRef(opts.ref);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        opts.signal?.throwIfAborted();
        const highlightPromise = refLocator(page, ref)
          .highlight()
          .then(async (highlight) => {
            if (opts.signal?.aborted) {
              await highlight.dispose();
              opts.signal.throwIfAborted();
            }
            return highlight;
          });
        const highlight = await awaitActionWithAbort(highlightPromise, abortPromise);
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const duration = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, HIGHLIGHT_DURATION_MS);
          });
          try {
            await (abortPromise ? Promise.race([duration, abortPromise]) : duration);
          } finally {
            if (timer) {
              clearTimeout(timer);
            }
          }
        } finally {
          await highlight.dispose();
        }
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl: hasBrowserNavigationPolicy(opts) ? page.url() : "",
      signal: opts.signal,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
    });
  } catch (err) {
    throw toFriendlyInteractionError(err, ref);
  } finally {
    cleanup();
  }
}

/** Clicks or double-clicks a role ref or selector with dialog and navigation guards. */
export async function clickViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  delayMs?: number;
  timeoutMs?: number;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const previousUrl = page.url();
  const signal = opts.signal;
  let abortListener: (() => void) | undefined;
  let abortReject: ((reason: unknown) => void) | undefined;
  let abortPromise: Promise<never> | undefined;
  if (signal) {
    abortPromise = new Promise((_, reject) => {
      abortReject = reject;
    });
    void abortPromise.catch(() => {});
    const disconnect = () => {
      if (isBrowserObservedDialogBlockedError(signal.reason)) {
        return;
      }
      void forceDisconnectPlaywrightForTarget({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        ssrfPolicy: opts.ssrfPolicy,
        reason: "click aborted",
      }).catch(() => {});
    };
    if (signal.aborted) {
      disconnect();
      throw signal.reason ?? new Error("aborted");
    }
    abortListener = () => {
      disconnect();
      abortReject?.(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
      throw signal.reason ?? new Error("aborted");
    }
  }
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        const delayMs = resolveBoundedDelayMs(
          opts.delayMs,
          "click delayMs",
          ACT_MAX_CLICK_DELAY_MS,
        );
        if (delayMs > 0) {
          await awaitActionWithAbort(
            locator.hover({ timeout }),
            abortPromise,
            reconcileRemoteDialog,
          );
          await new Promise((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        if (opts.doubleClick) {
          await awaitActionWithAbort(
            locator.dblclick({
              timeout,
              button: opts.button,
              modifiers: opts.modifiers,
            }),
            abortPromise,
            reconcileRemoteDialog,
          );
          return;
        }
        await awaitActionWithAbort(
          locator.click({
            timeout,
            button: opts.button,
            modifiers: opts.modifiers,
          }),
          abortPromise,
          reconcileRemoteDialog,
        );
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      signal: opts.signal,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toFriendlyInteractionError(err, label);
  } finally {
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

/** Clicks absolute page coordinates with optional double-click and navigation guard. */
export async function clickCoordsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  x: number;
  y: number;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  delayMs?: number;
  timeoutMs?: number;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  await assertInteractionNavigationCompletedSafely({
    action: async () => {
      await awaitActionWithAbort(
        page.mouse.click(opts.x, opts.y, {
          button: opts.button,
          clickCount: opts.doubleClick ? 2 : 1,
          delay: resolveBoundedDelayMs(opts.delayMs, "clickCoords delayMs", ACT_MAX_CLICK_DELAY_MS),
        }),
        abortPromise,
        reconcileRemoteDialog,
      );
    },
    cdpUrl: opts.cdpUrl,
    page,
    previousUrl,
    signal: opts.signal,
    ssrfPolicy: opts.ssrfPolicy,
    browserProxyMode: opts.browserProxyMode,
    targetId: opts.targetId,
  }).finally(cleanup);
}

/** Hovers a role ref or selector on the target page. */
export async function hoverViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  timeoutMs?: number;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: () =>
        awaitActionWithAbort(
          locator.hover({
            timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
          }),
          abortPromise,
          reconcileRemoteDialog,
        ),
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      signal: opts.signal,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toFriendlyInteractionError(err, label);
  } finally {
    cleanup();
  }
}

/** Drags from one role ref or selector to another. */
export async function dragViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  startRef?: string;
  startSelector?: string;
  endRef?: string;
  endSelector?: string;
  timeoutMs?: number;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<void> {
  const resolvedStart = requireRefOrSelector(opts.startRef, opts.startSelector);
  const resolvedEnd = requireRefOrSelector(opts.endRef, opts.endSelector);
  const page = await getRestoredPageForTarget(opts);
  const startLocator = resolvedStart.ref
    ? refLocator(page, requireRef(resolvedStart.ref))
    : page.locator(resolvedStart.selector!);
  const endLocator = resolvedEnd.ref
    ? refLocator(page, requireRef(resolvedEnd.ref))
    : page.locator(resolvedEnd.selector!);
  const startLabel = resolvedStart.ref ?? resolvedStart.selector!;
  const endLabel = resolvedEnd.ref ?? resolvedEnd.selector!;
  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: () =>
        awaitActionWithAbort(
          startLocator.dragTo(endLocator, {
            timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
          }),
          abortPromise,
          reconcileRemoteDialog,
        ),
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      signal: opts.signal,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toFriendlyInteractionError(err, `${startLabel} -> ${endLabel}`);
  } finally {
    cleanup();
  }
}

/** Selects one or more option values on a select-like element. */
export async function selectOptionViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  values: string[];
  timeoutMs?: number;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  if (!opts.values?.length) {
    throw new Error("values are required");
  }
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        await awaitActionWithAbort(
          locator.selectOption(opts.values, {
            timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
          }),
          abortPromise,
          reconcileRemoteDialog,
        );
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      signal: opts.signal,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toFriendlyInteractionError(err, label);
  } finally {
    cleanup();
  }
}

/** Presses a keyboard key against a ref, selector, or focused page. */
export async function pressKeyViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  key: string;
  delayMs?: number;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<void> {
  const key = normalizeOptionalString(opts.key) ?? "";
  if (!key) {
    throw new Error("key is required");
  }
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        await awaitActionWithAbort(
          page.keyboard.press(key, {
            delay: resolveNonNegativeIntegerOption(opts.delayMs, 0),
          }),
          abortPromise,
          reconcileRemoteDialog,
        );
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      signal: opts.signal,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } finally {
    cleanup();
  }
}

/** Types text into a ref, selector, or focused page. */
export async function typeViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  text: string;
  submit?: boolean;
  slowly?: boolean;
  timeoutMs?: number;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const text = opts.text ?? "";
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    const previousUrl = page.url();
    if (opts.slowly) {
      await assertInteractionNavigationCompletedSafely({
        action: async () => {
          await awaitActionWithAbort(
            locator.click({ timeout }),
            abortPromise,
            reconcileRemoteDialog,
          );
          await awaitActionWithAbort(
            locator.type(text, { timeout, delay: 75 }),
            abortPromise,
            reconcileRemoteDialog,
          );
          if (opts.submit) {
            await awaitActionWithAbort(
              locator.press("Enter", { timeout }),
              abortPromise,
              reconcileRemoteDialog,
            );
          }
        },
        cdpUrl: opts.cdpUrl,
        page,
        previousUrl,
        signal: opts.signal,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: opts.targetId,
      });
    } else {
      await assertInteractionNavigationCompletedSafely({
        action: async () => {
          await awaitActionWithAbort(
            locator.fill(text, { timeout }),
            abortPromise,
            reconcileRemoteDialog,
          );
          if (opts.submit) {
            await awaitActionWithAbort(
              locator.press("Enter", { timeout }),
              abortPromise,
              reconcileRemoteDialog,
            );
          }
        },
        cdpUrl: opts.cdpUrl,
        page,
        previousUrl,
        signal: opts.signal,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: opts.targetId,
      });
    }
  } catch (err) {
    throw toFriendlyInteractionError(err, label);
  } finally {
    cleanup();
  }
}

/** Fills multiple form fields with per-field selector/ref/type support. */
export async function fillFormViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fields: BrowserFormField[];
  timeoutMs?: number;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    for (const field of opts.fields) {
      const ref = field.ref.trim();
      const type = (field.type || DEFAULT_FILL_FIELD_TYPE).trim() || DEFAULT_FILL_FIELD_TYPE;
      const rawValue = field.value;
      const value =
        typeof rawValue === "string"
          ? rawValue
          : typeof rawValue === "number" || typeof rawValue === "boolean"
            ? String(rawValue)
            : "";
      if (!ref) {
        continue;
      }
      const locator = refLocator(page, ref);
      if (type === "checkbox" || type === "radio") {
        const checked =
          rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true";
        try {
          const previousUrl = page.url();
          await assertInteractionNavigationCompletedSafely({
            action: async () => {
              await awaitActionWithAbort(
                locator.setChecked(checked, { timeout }),
                abortPromise,
                reconcileRemoteDialog,
              );
            },
            cdpUrl: opts.cdpUrl,
            page,
            previousUrl,
            signal: opts.signal,
            ssrfPolicy: opts.ssrfPolicy,
            browserProxyMode: opts.browserProxyMode,
            targetId: opts.targetId,
          });
        } catch (err) {
          throw toFriendlyInteractionError(err, ref);
        }
        continue;
      }
      try {
        const previousUrl = page.url();
        await assertInteractionNavigationCompletedSafely({
          action: async () => {
            await awaitActionWithAbort(
              locator.fill(value, { timeout }),
              abortPromise,
              reconcileRemoteDialog,
            );
          },
          cdpUrl: opts.cdpUrl,
          page,
          previousUrl,
          signal: opts.signal,
          ssrfPolicy: opts.ssrfPolicy,
          browserProxyMode: opts.browserProxyMode,
          targetId: opts.targetId,
        });
      } catch (err) {
        throw toFriendlyInteractionError(err, ref);
      }
    }
  } finally {
    cleanup();
  }
}

/** Evaluates JavaScript in the page after browser action policy validation. */
export async function evaluateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fn: string;
  ref?: string;
  timeoutMs?: number;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<unknown> {
  const fnText = normalizeOptionalString(opts.fn) ?? "";
  if (!fnText) {
    throw new Error("function is required");
  }
  const fnSource = normalizeBrowserEvaluateFunctionSource(
    fnText,
    opts.ref ? { argumentName: "el" } : undefined,
  );
  const page = await getRestoredPageForTarget(opts);
  // Clamp evaluate timeout to prevent permanently blocking Playwright's command queue.
  // Without this, a long-running async evaluate blocks all subsequent page operations
  // because Playwright serializes CDP commands per page.
  //
  // NOTE: Playwright's { timeout } on evaluate only applies to installing the function,
  // NOT to its execution time. We must inject a Promise.race timeout into the browser
  // context itself so async functions are bounded.
  const outerTimeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);
  // Leave headroom for routing/serialization overhead so the outer request timeout
  // doesn't fire first and strand a long-running evaluate.
  let evaluateTimeout = Math.max(1000, Math.min(120_000, outerTimeout - 500));
  evaluateTimeout = Math.min(evaluateTimeout, outerTimeout);

  const signal = opts.signal;
  const { abortPromise, cleanup } = createAbortPromiseWithListener(signal, (reason) => {
    if (isBrowserObservedDialogBlockedError(reason)) {
      return;
    }
    void forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      reason: "evaluate aborted",
    }).catch(() => {});
  });
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  try {
    const previousUrl = page.url();
    if (hasBrowserNavigationPolicy(opts)) {
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response: null,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: opts.targetId,
      });
    }

    if (opts.ref) {
      const locator = refLocator(page, opts.ref);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- required for browser-context eval
      const elementEvaluator = new Function(
        "el",
        "args",
        `
        "use strict";
        var fnSource = args.fnSource, timeoutMs = args.timeoutMs;
        try {
          var candidate = eval("(" + fnSource + ")");
          if (typeof candidate !== "function") {
            throw new Error("evaluate source did not produce a function");
          }
          var result = candidate(el);
          if (result && typeof result.then === "function") {
            return Promise.race([
              result,
              new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
              })
            ]);
          }
          return result;
        } catch (err) {
          throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
        }
        `,
      ) as (el: Element, args: { fnSource: string; timeoutMs: number }) => unknown;
      const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, signal);
      const result = await assertInteractionNavigationCompletedSafely({
        action: () =>
          awaitActionWithAbort(
            locator.evaluate(elementEvaluator, {
              fnSource,
              timeoutMs: evaluateTimeout,
            }),
            abortPromise,
            reconcileRemoteDialog,
          ),
        cdpUrl: opts.cdpUrl,
        page,
        previousUrl,
        signal: opts.signal,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: opts.targetId,
      });
      return result;
    }

    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- required for browser-context eval
    const browserEvaluator = new Function(
      "args",
      `
        "use strict";
        var fnSource = args.fnSource, timeoutMs = args.timeoutMs;
        try {
          var candidate = eval("(" + fnSource + ")");
          if (typeof candidate !== "function") {
            throw new Error("evaluate source did not produce a function");
          }
          var result = candidate();
          if (result && typeof result.then === "function") {
            return Promise.race([
              result,
              new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
              })
            ]);
          }
          return result;
        } catch (err) {
          throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
        }
      `,
    ) as (args: { fnSource: string; timeoutMs: number }) => unknown;
    const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, signal);
    const result = await assertInteractionNavigationCompletedSafely({
      action: () =>
        awaitActionWithAbort(
          page.evaluate(browserEvaluator, {
            fnSource,
            timeoutMs: evaluateTimeout,
          }),
          abortPromise,
          reconcileRemoteDialog,
        ),
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      signal: opts.signal,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
    return result;
  } finally {
    cleanup();
  }
}

/** Scrolls a role ref or selector into view. */
export async function scrollIntoViewViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  timeoutMs?: number;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 20_000);

  const label = resolved.ref ?? resolved.selector!;
  const locator = resolved.ref
    ? refLocator(page, requireRef(resolved.ref))
    : page.locator(resolved.selector!);
  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: () =>
        awaitActionWithAbort(
          locator.scrollIntoViewIfNeeded({ timeout }),
          abortPromise,
          reconcileRemoteDialog,
        ),
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      signal: opts.signal,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toFriendlyInteractionError(err, label);
  } finally {
    cleanup();
  }
}

/** Resizes the target viewport while guarding resize-handler navigation. */
export async function resizeViewportViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    width: number;
    height: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: () =>
        awaitActionWithAbort(
          page.setViewportSize({
            width: resolveViewportDimension(opts.width, "width"),
            height: resolveViewportDimension(opts.height, "height"),
          }),
          abortPromise,
          reconcileRemoteDialog,
        ),
      allowUnchangedCurrentPageUrlForResize: true,
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      signal: opts.signal,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } finally {
    cleanup();
  }
}

/** Waits for load state, timeout, URL, text, ref, or selector conditions. */
export async function waitForViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    timeMs?: number;
    text?: string;
    textGone?: string;
    selector?: string;
    url?: string;
    loadState?: "load" | "domcontentloaded" | "networkidle";
    fn?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const timeout = resolveActWaitTimeoutMs(opts.timeoutMs);
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  const waitForStep = async <T>(stepPromise: Promise<T>) => {
    await awaitActionWithAbort(stepPromise, abortPromise, reconcileRemoteDialog);
  };

  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        if (typeof opts.timeMs === "number" && Number.isFinite(opts.timeMs)) {
          await waitForStep(
            page.waitForTimeout(
              resolveBoundedDelayMs(opts.timeMs, "wait timeMs", ACT_MAX_WAIT_TIME_MS),
            ),
          );
        }
        if (opts.text) {
          await waitForStep(
            page.getByText(opts.text).first().waitFor({
              state: "visible",
              timeout,
            }),
          );
        }
        if (opts.textGone) {
          await waitForStep(
            page.getByText(opts.textGone).first().waitFor({
              state: "hidden",
              timeout,
            }),
          );
        }
        if (opts.selector) {
          const selector = normalizeOptionalString(opts.selector) ?? "";
          if (selector) {
            await waitForStep(
              page.locator(selector).first().waitFor({ state: "visible", timeout }),
            );
          }
        }
        if (opts.url) {
          const url = normalizeOptionalString(opts.url) ?? "";
          if (url) {
            await waitForStep(page.waitForURL(url, { timeout }));
          }
        }
        if (opts.loadState) {
          await waitForStep(page.waitForLoadState(opts.loadState, { timeout }));
        }
        if (opts.fn) {
          const fn = normalizeOptionalString(opts.fn) ?? "";
          if (fn) {
            await waitForStep(page.waitForFunction(fn, { timeout }));
          }
        }
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl: hasBrowserNavigationPolicy(opts) ? page.url() : "",
      signal: opts.signal,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } finally {
    cleanup();
  }
}

/** Captures a screenshot from the target page or element. */
export async function takeScreenshotViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    ref?: string;
    element?: string;
    fullPage?: boolean;
    type?: "png" | "jpeg";
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  return await runGuardedPlaywrightPageAction({
    ...opts,
    page,
    action: async () => {
      const type = opts.type ?? "png";
      if (opts.ref) {
        if (opts.fullPage) {
          throw new Error("fullPage is not supported for element screenshots");
        }
        const buffer = await refLocator(page, opts.ref).screenshot({
          type,
          timeout: opts.timeoutMs,
        });
        return { buffer };
      }
      if (opts.element) {
        if (opts.fullPage) {
          throw new Error("fullPage is not supported for element screenshots");
        }
        const buffer = await page.locator(opts.element).first().screenshot({
          type,
          timeout: opts.timeoutMs,
        });
        return { buffer };
      }
      const buffer = await page.screenshot({
        type,
        fullPage: Boolean(opts.fullPage),
        timeout: opts.timeoutMs,
      });
      return { buffer };
    },
  });
}

type LabeledScreenshotResult = {
  buffer: Buffer;
  labels: number;
  skipped: number;
  annotations: AnnotationItem[];
};

async function screenshotWithLabelsOnPage(opts: {
  page: Page;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  maxLabels?: number;
  type?: "png" | "jpeg";
  timeoutMs?: number;
  fullPage?: boolean;
  ref?: string;
  element?: string;
}): Promise<LabeledScreenshotResult> {
  const page = opts.page;
  const type = opts.type ?? "png";
  const maxLabels =
    typeof opts.maxLabels === "number" && Number.isFinite(opts.maxLabels)
      ? Math.max(1, Math.floor(opts.maxLabels))
      : ANNOTATION_MAX_LABELS_DEFAULT;

  const refKey = normalizeOptionalString(opts.ref) ?? undefined;
  const elementSelector = normalizeOptionalString(opts.element) ?? undefined;
  const space: CoordinateSpace = opts.fullPage
    ? "fullpage"
    : refKey || elementSelector
      ? "element"
      : "viewport";

  // Read scroll + viewport size. Scroll converts Playwright's viewport-space
  // boundingBoxes into document-space inputs; the viewport size lets the helper
  // restore the shipped `labelsSkipped` semantics by counting off-viewport refs
  // as skipped (in viewport capture mode).
  const view = await page.evaluate(() => ({
    x: window.scrollX || 0,
    y: window.scrollY || 0,
    width: window.innerWidth || 0,
    height: window.innerHeight || 0,
  }));
  const scroll = { x: view.x, y: view.y };

  let elementRect: { x: number; y: number; width: number; height: number } | undefined;
  if (space === "element") {
    const box = await resolveElementBoundingBoxForLabels(page, refKey, elementSelector);
    if (!box) {
      throw new Error(
        `screenshotWithLabelsViaPlaywright: element not found for ${
          refKey ? `ref="${refKey}"` : `selector="${elementSelector ?? ""}"`
        }`,
      );
    }
    // Convert viewport-space bbox to document space.
    elementRect = {
      x: box.x + scroll.x,
      y: box.y + scroll.y,
      width: box.width,
      height: box.height,
    };
  }

  const refKeys = Object.keys(opts.refs ?? {});
  const inputs: RawAnnotationInput[] = [];
  let bboxFailures = 0;
  for (const ref of refKeys) {
    const box = await refLocator(page, ref)
      .boundingBox()
      .catch(() => null);
    if (!box) {
      bboxFailures += 1;
      continue;
    }
    inputs.push({
      ref,
      role: opts.refs[ref].role,
      name: opts.refs[ref].name,
      doc: {
        x: box.x + scroll.x,
        y: box.y + scroll.y,
        width: box.width,
        height: box.height,
      },
    });
  }

  const plan = planAnnotations({
    inputs,
    space,
    scroll,
    viewport: { width: view.width, height: view.height },
    elementRect,
    maxLabels,
  });

  try {
    if (plan.overlayItems.length > 0) {
      const captureY = space === "element" ? elementRect?.y : space === "viewport" ? scroll.y : 0;
      await page.evaluate(buildOverlayInjectionScript({ items: plan.overlayItems, captureY }));
    }
    const buffer =
      space === "element"
        ? await captureElementScreenshotForLabels(
            page,
            refKey,
            elementSelector,
            type,
            opts.timeoutMs,
          )
        : await page.screenshot({
            type,
            fullPage: Boolean(opts.fullPage),
            timeout: opts.timeoutMs,
          });
    return {
      // `labels` reports overlay boxes actually drawn on the captured image
      // (in-viewport, within budget); off-viewport refs are surfaced via
      // `annotations` but not drawn, and are reflected in `skipped`.
      buffer,
      labels: plan.overlayItems.length,
      skipped: plan.skipped + bboxFailures,
      annotations: plan.annotations,
    };
  } finally {
    await page.evaluate(buildOverlayClearScript()).catch(() => {});
  }
}

type LabeledScreenshotOptions = {
  cdpUrl: string;
  targetId?: string;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  maxLabels?: number;
  type?: "png" | "jpeg";
  timeoutMs?: number;
  fullPage?: boolean;
  ref?: string;
  element?: string;
  signal?: AbortSignal;
} & BrowserNavigationPolicyOptions;

/** Captures a screenshot with Browser plugin labels over interactive elements. */
export async function screenshotWithLabelsViaPlaywright(
  opts: LabeledScreenshotOptions,
): Promise<LabeledScreenshotResult> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  return await runGuardedPlaywrightPageAction({
    ...opts,
    page,
    action: async () => await screenshotWithLabelsOnPage({ ...opts, page }),
  });
}

/** Captures a role snapshot and its labeled screenshot in one guarded page lifecycle. */
export async function snapshotRoleWithLabelsViaPlaywright(
  opts: Omit<RoleSnapshotOnPageOptions, "page"> & Omit<LabeledScreenshotOptions, "refs">,
): Promise<RoleSnapshotResult & LabeledScreenshotResult> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  return await runGuardedPlaywrightPageAction({
    ...opts,
    page,
    action: async () => {
      const snapshot = await snapshotRoleOnPageViaPlaywright({ ...opts, page });
      const screenshot = await screenshotWithLabelsOnPage({
        ...opts,
        page,
        refs: snapshot.refs,
      });
      return { ...snapshot, ...screenshot };
    },
  });
}

async function resolveElementBoundingBoxForLabels(
  page: Page,
  refKey: string | undefined,
  cssSelector: string | undefined,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (refKey) {
    try {
      return await refLocator(page, refKey).boundingBox();
    } catch {
      return null;
    }
  }
  if (cssSelector) {
    try {
      return await page.locator(cssSelector).first().boundingBox();
    } catch {
      return null;
    }
  }
  return null;
}

async function captureElementScreenshotForLabels(
  page: Page,
  refKey: string | undefined,
  cssSelector: string | undefined,
  type: "png" | "jpeg",
  timeoutMs: number | undefined,
): Promise<Buffer> {
  if (refKey) {
    return await refLocator(page, refKey).screenshot({ type, timeout: timeoutMs });
  }
  if (cssSelector) {
    return await page.locator(cssSelector).first().screenshot({ type, timeout: timeoutMs });
  }
  throw new Error("captureElementScreenshotForLabels: requires refKey or cssSelector");
}

/** Sets file inputs for a role ref or selector with strict existing-path checks. */
export async function setInputFilesViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    inputRef?: string;
    element?: string;
    paths: string[];
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  if (!opts.paths.length) {
    throw new Error("paths are required");
  }
  const inputRef = normalizeOptionalString(opts.inputRef) ?? "";
  const element = normalizeOptionalString(opts.element) ?? "";
  if (inputRef && element) {
    throw new Error("inputRef and element are mutually exclusive");
  }
  if (!inputRef && !element) {
    throw new Error("inputRef or element is required");
  }

  const locator = inputRef ? refLocator(page, inputRef) : page.locator(element).first();
  const resolvedResult = await resolveStrictExistingUploadPaths({ requestedPaths: opts.paths });
  if (!resolvedResult.ok) {
    throw new Error(resolvedResult.error);
  }
  const resolvedPaths = resolvedResult.paths;

  const previousUrl = page.url();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  const reconcileRemoteDialog = () => reconcileRemoteDialogAfterActionSettled(page, opts.signal);
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        opts.signal?.throwIfAborted();
        await awaitActionWithAbort(
          locator.setInputFiles(resolvedPaths),
          abortPromise,
          reconcileRemoteDialog,
        );
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      signal: opts.signal,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toFriendlyInteractionError(err, inputRef || element);
  } finally {
    cleanup();
  }
}

async function executeSingleAction(
  action: BrowserActRequest,
  cdpUrl: string,
  targetId?: string,
  evaluateEnabled?: boolean,
  navigationPolicy: BrowserNavigationPolicyOptions = {},
  depth = 0,
  signal?: AbortSignal,
): Promise<unknown> {
  if (depth > ACT_MAX_BATCH_DEPTH) {
    throw new Error(`Batch nesting depth exceeds maximum of ${ACT_MAX_BATCH_DEPTH}`);
  }
  const effectiveTargetId = action.targetId ?? targetId;
  switch (action.kind) {
    case "click":
      await clickViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        doubleClick: action.doubleClick,
        button: action.button as "left" | "right" | "middle" | undefined,
        modifiers: action.modifiers as Array<
          "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift"
        >,
        delayMs: action.delayMs,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "clickCoords":
      await clickCoordsViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        x: action.x,
        y: action.y,
        doubleClick: action.doubleClick,
        button: action.button as "left" | "right" | "middle" | undefined,
        delayMs: action.delayMs,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "type":
      await typeViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        text: action.text,
        submit: action.submit,
        slowly: action.slowly,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "press":
      await pressKeyViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        key: action.key,
        delayMs: action.delayMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "hover":
      await hoverViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "scrollIntoView":
      await scrollIntoViewViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "drag":
      await dragViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        startRef: action.startRef,
        startSelector: action.startSelector,
        endRef: action.endRef,
        endSelector: action.endSelector,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "select":
      await selectOptionViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        values: action.values,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "fill":
      await fillFormViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        fields: action.fields,
        timeoutMs: action.timeoutMs,
        ...navigationPolicy,
        signal,
      });
      break;
    case "resize":
      await resizeViewportViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        width: action.width,
        height: action.height,
        ...navigationPolicy,
        ...(signal ? { signal } : {}),
      });
      break;
    case "wait":
      if (action.fn && !evaluateEnabled) {
        throw new Error("wait --fn is disabled by config (browser.evaluateEnabled=false)");
      }
      await waitForViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ...navigationPolicy,
        timeMs: action.timeMs,
        text: action.text,
        textGone: action.textGone,
        selector: action.selector,
        url: action.url,
        loadState: action.loadState,
        fn: action.fn,
        timeoutMs: action.timeoutMs,
        signal,
      });
      break;
    case "evaluate":
      if (!evaluateEnabled) {
        throw new Error("act:evaluate is disabled by config (browser.evaluateEnabled=false)");
      }
      return await evaluateViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ...navigationPolicy,
        fn: action.fn,
        ref: action.ref,
        timeoutMs: action.timeoutMs,
        signal,
      });
    case "close":
      await closePageViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
      });
      break;
    case "batch":
      await batchViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ...navigationPolicy,
        actions: action.actions,
        stopOnError: action.stopOnError,
        evaluateEnabled,
        depth: depth + 1,
        signal,
      });
      break;
    default:
      throw new Error(`Unsupported batch action kind: ${(action as { kind: string }).kind}`);
  }
  return undefined;
}

function actionNeedsStandaloneDownloadGrace(
  action: BrowserActRequest,
  navigationPolicy: BrowserNavigationPolicyOptions,
): boolean {
  switch (action.kind) {
    case "close":
    case "wait":
      return false;
    case "batch":
      return action.actions.some((nested) =>
        actionNeedsStandaloneDownloadGrace(nested, navigationPolicy),
      );
    default:
      // Navigation-aware interactions already hold a 250 ms event window when
      // policy is active. Policy-free internal callers need that window here.
      return !hasBrowserNavigationPolicy(navigationPolicy);
  }
}

/** Executes one high-level browser act request with bounded recursive actions. */
export async function executeActViaPlaywright(opts: {
  cdpUrl: string;
  action: BrowserActRequest;
  targetId?: string;
  evaluateEnabled?: boolean;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  signal?: AbortSignal;
}): Promise<{
  result?: unknown;
  results?: Array<{ ok: boolean; error?: string }>;
  blockedByDialog?: boolean;
  browserState?: unknown;
  downloads?: BrowserDownloadResult[];
}> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
    browserProxyMode: opts.browserProxyMode,
  });
  // Any DOM action can synchronously trigger a download. Capturing all actions
  // keeps reporting and final-URL policy aligned with the actual file write.
  const downloadCapture = beginActionDownloadCaptureOnPage(page, {
    beforeSave: async (download) => {
      if (!download.url) {
        throw new Error("Action download URL is unavailable");
      }
      await assertBrowserDownloadSaveAllowed({
        downloadUrl: download.url,
        page,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
      });
    },
  });
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
  const downloadGraceMs = actionNeedsStandaloneDownloadGrace(opts.action, navigationPolicy)
    ? INTERACTION_NAVIGATION_GRACE_MS
    : 0;
  const drainDownloads = async () =>
    await downloadCapture.drain({
      firstEventGraceMs: downloadGraceMs,
      maxWaitMs: ACT_DOWNLOAD_MAX_DRAIN_MS,
      quietMs: INTERACTION_NAVIGATION_GRACE_MS,
    });
  const dialogAbort = createObservedDialogAbortSignalForPage({
    page,
    parentSignal: opts.signal,
  });
  try {
    if (opts.action.kind === "batch") {
      const batch = await batchViaPlaywright({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        ...navigationPolicy,
        actions: opts.action.actions,
        stopOnError: opts.action.stopOnError,
        evaluateEnabled: opts.evaluateEnabled,
        signal: dialogAbort.signal,
      });
      const newDownloads = await drainDownloads();
      return {
        results: batch.results,
        ...(newDownloads ? { downloads: newDownloads } : {}),
      };
    }
    const result = await executeSingleAction(
      opts.action,
      opts.cdpUrl,
      opts.targetId,
      opts.evaluateEnabled,
      navigationPolicy,
      0,
      dialogAbort.signal,
    );
    const newDownloads = await drainDownloads();
    if (opts.action.kind === "evaluate") {
      return { result, ...(newDownloads ? { downloads: newDownloads } : {}) };
    }
    return newDownloads ? { downloads: newDownloads } : {};
  } catch (err) {
    let failure = err;
    try {
      await drainDownloads();
    } catch (downloadErr) {
      // A download policy/save failure is the action's network-to-file result;
      // preserve it even when the initiating interaction also failed.
      failure = downloadErr;
    }
    if (isBrowserObservedDialogBlockedError(failure)) {
      return { blockedByDialog: true, browserState: failure.browserState };
    }
    if (
      isBrowserInteractionNavigationSecurityError(failure) &&
      !wasBrowserNavigationRequestBlockedBeforeDispatch(failure)
    ) {
      await quarantineBlockedNavigationTargetForError({
        cdpUrl: opts.cdpUrl,
        error: failure,
        page,
        targetId: opts.targetId,
      });
    }
    throw failure;
  } finally {
    downloadCapture.dispose();
    dialogAbort.cleanup();
  }
}

/** Executes a bounded sequence of browser actions and returns per-step results. */
export async function batchViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  actions: BrowserActRequest[];
  stopOnError?: boolean;
  evaluateEnabled?: boolean;
  ssrfPolicy?: BrowserNavigationPolicyOptions["ssrfPolicy"];
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
  depth?: number;
  signal?: AbortSignal;
}): Promise<{ results: Array<{ ok: boolean; error?: string }> }> {
  const depth = opts.depth ?? 0;
  if (depth > ACT_MAX_BATCH_DEPTH) {
    throw new Error(`Batch nesting depth exceeds maximum of ${ACT_MAX_BATCH_DEPTH}`);
  }
  if (opts.actions.length > ACT_MAX_BATCH_ACTIONS) {
    throw new Error(`Batch exceeds maximum of ${ACT_MAX_BATCH_ACTIONS} actions`);
  }
  const results: Array<{ ok: boolean; error?: string }> = [];
  for (const action of opts.actions) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new Error("aborted");
    }
    try {
      await executeSingleAction(
        action,
        opts.cdpUrl,
        opts.targetId,
        opts.evaluateEnabled,
        withBrowserNavigationPolicy(opts.ssrfPolicy, {
          browserProxyMode: opts.browserProxyMode,
        }),
        depth,
        opts.signal,
      );
      results.push({ ok: true });
    } catch (err) {
      if (
        isBrowserObservedDialogBlockedError(err) ||
        isBrowserInteractionNavigationSecurityError(err)
      ) {
        throw err;
      }
      const message = formatErrorMessage(err);
      results.push({ ok: false, error: message });
      if (opts.stopOnError !== false) {
        break;
      }
    }
  }
  return { results };
}
