import { addAbortListener } from "node:events";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import type { Locator, Page } from "playwright-core";
import { resolveActInteractionTimeoutMs } from "./act-policy.js";
import type { BrowserFormField } from "./client-actions.types.js";
import { normalizeBrowserEvaluateFunctionSource } from "./evaluate-source.js";
import { evaluateBrowserFunction } from "./page-function-runtime.js";
import {
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  refLocator,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import {
  assertInteractionCurrent,
  type ElementInteractionOptions,
  getRestoredPageForTarget,
  type GuardedInteractionOptions,
  type InteractionTargetOptions,
  runCancellablePageInteraction,
  runGuardedPageInteraction,
  throwIfInteractionAborted,
  toFriendlyInteractionError,
} from "./pw-tools-core.interactions.navigation.js";
import { normalizeTimeoutMs, requireRef } from "./pw-tools-core.shared.js";

export async function highlightViaPlaywright(
  opts: InteractionTargetOptions & {
    ref: string;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const ref = requireRef(opts.ref);
  try {
    await refLocator(page, ref).highlight();
  } catch (err) {
    throw toFriendlyInteractionError(err, ref);
  }
}

export async function clickViaPlaywright(
  opts: ElementInteractionOptions & {
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
    delayMs?: number;
    resolvedPage?: Page;
  },
): Promise<void> {
  await runElementInteraction(
    opts,
    async (locator, { timeout, signal }) => {
      const delayMs = opts.delayMs ?? 0;
      if (delayMs > 0) {
        await locator.hover({ timeout, signal });
        throwIfInteractionAborted(opts.signal);
        await sleepWithAbort(delayMs, opts.signal);
        const assertion = assertInteractionCurrent(opts);
        if (assertion) {
          await assertion;
        }
        throwIfInteractionAborted(opts.signal);
      }
      const clickOptions = { timeout, signal, button: opts.button, modifiers: opts.modifiers };
      await (opts.doubleClick ? locator.dblclick(clickOptions) : locator.click(clickOptions));
    },
    opts.resolvedPage,
  );
}

export async function clickCoordsViaPlaywright(
  opts: GuardedInteractionOptions & {
    x: number;
    y: number;
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    delayMs?: number;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  await runGuardedPageInteraction(page, opts, async () => {
    await page.mouse.click(opts.x, opts.y, {
      button: opts.button,
      clickCount: opts.doubleClick ? 2 : 1,
      delay: opts.delayMs ?? 0,
    });
  });
}

function resolveInteractionElement(
  page: Page,
  resolved: Pick<ElementInteractionOptions, "ref" | "selector">,
) {
  return {
    label: resolved.ref ?? resolved.selector!,
    locator: resolved.ref
      ? refLocator(page, requireRef(resolved.ref))
      : page.locator(resolved.selector!),
  };
}

async function runElementInteraction(
  opts: ElementInteractionOptions,
  action: (locator: Locator, options: { timeout: number; signal: AbortSignal }) => Promise<unknown>,
  resolvedPage?: Page,
  resolveTimeout = resolveActInteractionTimeoutMs,
): Promise<void> {
  const page = resolvedPage ?? (await getRestoredPageForTarget(opts));
  if (resolvedPage) {
    ensurePageState(page);
    restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  }
  const { label, locator } = resolveInteractionElement(page, opts);
  const timeout = resolveTimeout(opts.timeoutMs);
  await runCancellablePageInteraction(
    page,
    opts,
    (signal) => action(locator, { timeout, signal }),
    label,
  );
}

export async function hoverViaPlaywright(opts: ElementInteractionOptions): Promise<void> {
  await runElementInteraction(opts, (locator, options) => locator.hover(options));
}

export async function dragViaPlaywright(
  opts: GuardedInteractionOptions & {
    startRef?: string;
    startSelector?: string;
    endRef?: string;
    endSelector?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const { label: startLabel, locator: startLocator } = resolveInteractionElement(page, {
    ref: opts.startRef,
    selector: opts.startSelector,
  });
  const { label: endLabel, locator: endLocator } = resolveInteractionElement(page, {
    ref: opts.endRef,
    selector: opts.endSelector,
  });
  await runCancellablePageInteraction(
    page,
    opts,
    async (signal) =>
      await startLocator.dragTo(endLocator, {
        timeout: resolveActInteractionTimeoutMs(opts.timeoutMs),
        signal,
      }),
    `${startLabel} -> ${endLabel}`,
  );
}

export async function selectOptionViaPlaywright(
  opts: ElementInteractionOptions & {
    values: string[];
  },
): Promise<void> {
  await runElementInteraction(opts, (locator, options) =>
    locator.selectOption(opts.values, options),
  );
}

export async function pressKeyViaPlaywright(
  opts: GuardedInteractionOptions & {
    key: string;
    delayMs?: number;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  await runGuardedPageInteraction(page, opts, async () => {
    await page.keyboard.press(opts.key, {
      delay: opts.delayMs ?? 0,
    });
  });
}

export async function insertTextViaPlaywright(
  opts: GuardedInteractionOptions & { text: string },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  await runGuardedPageInteraction(page, opts, async () => {
    try {
      // Native insertion preserves the focused frame and selection without reading the clipboard.
      await page.keyboard.insertText(opts.text);
    } catch {
      // Playwright errors can contain the inserted text, including pasted passwords.
      throw new Error(
        "Unable to paste text into the browser. Focus an editable field and try again.",
      );
    }
  });
}

export async function typeViaPlaywright(
  opts: ElementInteractionOptions & {
    text: string;
    submit?: boolean;
    slowly?: boolean;
  },
): Promise<void> {
  await runElementInteraction(opts, async (locator, { timeout, signal }) => {
    if (opts.slowly) {
      await locator.click({ timeout, signal });
      const assertion = assertInteractionCurrent(opts);
      if (assertion) {
        await assertion;
      }
      throwIfInteractionAborted(opts.signal);
      await locator.type(opts.text, { timeout, signal, delay: 75 });
    } else {
      await locator.fill(opts.text, { timeout, signal });
    }
    if (opts.submit) {
      const assertion = assertInteractionCurrent(opts);
      if (assertion) {
        await assertion;
      }
      throwIfInteractionAborted(opts.signal);
      await locator.press("Enter", { timeout, signal });
    }
  });
}

export async function fillFormViaPlaywright(
  opts: GuardedInteractionOptions & {
    fields: BrowserFormField[];
    timeoutMs?: number;
  },
): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveActInteractionTimeoutMs(opts.timeoutMs);
  for (const field of opts.fields) {
    const { ref, type, value: rawValue } = field;
    const value = String(rawValue ?? "");
    const locator = refLocator(page, ref);
    await runCancellablePageInteraction(
      page,
      opts,
      async (signal) => {
        if (type === "checkbox" || type === "radio") {
          const checked =
            rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true";
          await locator.setChecked(checked, { timeout, signal });
        } else {
          await locator.fill(value, { timeout, signal });
        }
      },
      ref,
    );
  }
}

export async function evaluateViaPlaywright(
  opts: GuardedInteractionOptions & {
    fn: string;
    ref?: string;
    timeoutMs?: number;
  },
): Promise<unknown> {
  const fnSource = normalizeBrowserEvaluateFunctionSource(
    opts.fn,
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
  const onAbort = () => {
    if (isBrowserObservedDialogBlockedError(signal?.reason)) {
      return;
    }
    void forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      page,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
    }).catch(() => {});
  };
  if (signal?.aborted) {
    onAbort();
    throw signal.reason ?? new Error("aborted");
  }
  const abortListener = signal && addAbortListener(signal, onAbort);

  try {
    const args = { fnSource, timeoutMs: evaluateTimeout };
    const ref = opts.ref;
    const action = ref
      ? async () => await refLocator(page, ref).evaluate(evaluateBrowserFunction, args)
      : async () => await page.evaluate(evaluateBrowserFunction, args);
    return await runGuardedPageInteraction(page, opts, action);
  } finally {
    abortListener?.[Symbol.dispose]();
  }
}

export async function scrollIntoViewViaPlaywright(opts: ElementInteractionOptions): Promise<void> {
  await runElementInteraction(
    opts,
    (locator, options) => locator.scrollIntoViewIfNeeded(options),
    undefined,
    (timeoutMs) => normalizeTimeoutMs(timeoutMs, 20_000),
  );
}
