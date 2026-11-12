import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import type { Frame, Page, Request } from "playwright-core";
import { getPageForTargetId } from "./pw-session.js";
import { runActionExecution } from "./pw-tools-core.interactions.execution.js";
import {
  assertInteractionCurrent,
  BrowserInteractionAuthorityError,
  createInteractionFrameListener,
  type GuardedInteractionOptions,
  interactionNavigationPolicy,
  runGuardedPageInteraction,
} from "./pw-tools-core.interactions.navigation.js";

/** One human input forwarded from the Control UI browser panel. */
export type BrowserOperatorInput =
  | { kind: "press"; key: string }
  | { kind: "insertText"; text: string }
  | { kind: "clickCoords"; x: number; y: number };

export type BrowserOperatorInputResult = {
  /** Inputs dispatched, in order. Inputs after `sent` were not delivered. */
  sent: number;
  /** A frame navigated, so later inputs were withheld from the new document. */
  navigated?: true;
  blockedByDialog?: true;
  browserState?: unknown;
  targetId?: string;
};

/**
 * An operator session keeps one navigation guard while inputs keep arriving, so a
 * burst of keys pays the guard's post-action window once instead of per key.
 */
const OPERATOR_SESSION_IDLE_MS = 1_000;
/**
 * After a burst, wait this long for a main-frame navigation request before
 * answering, so the burst that started a navigation reports its checked outcome.
 * Requests are fenced either way; this only attributes the result.
 */
const OPERATOR_BURST_SETTLE_MS = 50;

type Burst = {
  inputs: BrowserOperatorInput[];
  assertCurrent?: GuardedInteractionOptions["assertCurrent"];
  signal?: AbortSignal;
  sent: number;
  error?: unknown;
  resolve: (result: BrowserOperatorInputResult) => void;
  reject: (error: unknown) => void;
};

type SessionOptions = GuardedInteractionOptions;

const sessions = new WeakMap<Page, OperatorInputSession>();
// A policy failure found after every burst was answered goes to the page's next burst.
const lateFailures = new WeakMap<Page, unknown>();

class OperatorInputSession {
  private readonly queue: Burst[] = [];
  private wake: (() => void) | undefined;
  private accepting = true;
  private navigated = false;
  private navigationRequested = false;
  private retired = false;
  private readonly controller = new AbortController();
  readonly finished: Promise<void>;

  constructor(
    private readonly page: Page,
    readonly opts: SessionOptions,
  ) {
    this.finished = this.run();
  }

  /** Invocation-bound policy (loopback preview) must not outlive its request. */
  private get shareable(): boolean {
    return !interactionNavigationPolicy(this.opts).assertNavigationCurrent;
  }

  /** Same page, same policy owner: later bursts may join this session's guard. */
  canShare(opts: SessionOptions): boolean {
    const policy = interactionNavigationPolicy(opts);
    const own = interactionNavigationPolicy(this.opts);
    return (
      this.accepting &&
      this.shareable &&
      !policy.assertNavigationCurrent &&
      policy.ssrfPolicy === own.ssrfPolicy &&
      policy.browserProxyMode === own.browserProxyMode &&
      opts.cdpUrl === this.opts.cdpUrl
    );
  }

  enqueue(burst: Burst): boolean {
    if (!this.accepting) {
      return false;
    }
    this.queue.push(burst);
    this.wake?.();
    return true;
  }

  /** Finish queued bursts, then release the guard without waiting for more input. */
  retire(): void {
    this.retired = true;
    this.accepting = false;
    this.wake?.();
  }

  /** Later bursts find a registered session and wait for it to settle. */
  private release(): void {
    this.accepting = false;
    if (sessions.get(this.page) === this) {
      sessions.delete(this.page);
    }
  }

  private markNavigated = (): void => {
    this.navigated = true;
    this.wake?.();
  };

  private onRequest = (request: Request): void => {
    if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) {
      this.navigationRequested = true;
      this.wake?.();
    }
  };

  private onPageClose = (): void => {
    this.controller.abort(new Error("Browser tab closed"));
    this.wake?.();
  };

  private async run(): Promise<void> {
    let outcome: Awaited<ReturnType<typeof runActionExecution>> | undefined;
    let failure: unknown;
    let failed = false;
    this.page.once("close", this.onPageClose);
    try {
      outcome = await runActionExecution(
        { ...this.opts, signal: this.controller.signal },
        true,
        async (page, execution) => {
          const subframes: string[] = [];
          const frameListener = createInteractionFrameListener(
            page,
            page.url(),
            subframes,
            this.markNavigated,
          );
          const onFrameNavigated = (frame: Frame) => {
            frameListener(frame);
            if (subframes.length > 0) {
              this.markNavigated();
            }
          };
          page.on("framenavigated", onFrameNavigated);
          page.on("request", this.onRequest);
          try {
            // One guard spans the session; its post-action window and final
            // navigation checks run once, after the last input.
            await runGuardedPageInteraction(page, execution, () =>
              this.drain(page, execution.signal),
            );
          } finally {
            page.off("framenavigated", onFrameNavigated);
            page.off("request", this.onRequest);
          }
          return {};
        },
      );
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      this.release();
      this.page.off("close", this.onPageClose);
    }
    if (failed && this.queue.length === 0) {
      lateFailures.set(this.page, failure);
    }
    // Remaining bursts settle only after the guard has checked any navigation.
    for (const burst of this.queue.splice(0)) {
      if (failed) {
        burst.reject(failure);
      } else if (outcome && "blockedByDialog" in outcome) {
        burst.resolve({
          sent: burst.sent,
          blockedByDialog: true,
          browserState: outcome.browserState,
          ...(outcome.targetId ? { targetId: outcome.targetId } : {}),
        });
      } else if (burst.error !== undefined) {
        burst.reject(burst.error);
      } else {
        burst.resolve({
          sent: burst.sent,
          ...(this.navigated || this.navigationRequested ? { navigated: true as const } : {}),
          ...(outcome?.targetId ? { targetId: outcome.targetId } : {}),
        });
      }
    }
  }

  private stopped(signal?: AbortSignal): boolean {
    return (
      this.navigated ||
      this.navigationRequested ||
      Boolean(signal?.aborted) ||
      this.controller.signal.aborted
    );
  }

  private async drain(page: Page, signal?: AbortSignal): Promise<void> {
    try {
      while (!this.stopped(signal)) {
        const burst = this.queue[0];
        if (!burst) {
          if (
            this.retired ||
            !this.shareable ||
            !(await this.waitFor(OPERATOR_SESSION_IDLE_MS, signal))
          ) {
            return;
          }
          continue;
        }
        try {
          burst.signal?.throwIfAborted();
          // Revalidate the requester right before its first effect.
          const assertion = assertInteractionCurrent(burst);
          if (assertion) {
            await assertion;
          }
          for (const input of burst.inputs) {
            if (this.stopped(signal) || burst.signal?.aborted) {
              break;
            }
            await dispatchOperatorInput(page, input);
            burst.sent += 1;
          }
        } catch (error) {
          if (error instanceof BrowserInteractionAuthorityError) {
            throw error;
          }
          burst.error = error;
        }
        if (!this.stopped(signal)) {
          await this.waitFor(OPERATOR_BURST_SETTLE_MS, signal);
        }
        if (this.stopped(signal)) {
          // A navigation or dialog ended the session; settle after the guard checks it.
          return;
        }
        this.queue.shift();
        if (burst.error !== undefined) {
          burst.reject(burst.error);
        } else {
          burst.resolve({ sent: burst.sent });
        }
      }
    } finally {
      // Settled synchronously with the loop exit so no burst joins a finishing guard.
      this.accepting = false;
      if (!this.stopped(signal)) {
        // Idle end: the guard's tail checks nothing this session started, so new
        // input need not wait for it. A navigation, dialog or abort keeps the
        // session registered until its guard has checked and settled.
        this.release();
      }
    }
  }

  /** Resolves true when new work arrives, false on timeout, navigation or abort. */
  private waitFor(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (hasWork: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.wake = undefined;
        resolve(hasWork);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(false), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.wake = () => finish(!this.retired && !this.stopped(signal) && this.queue.length > 0);
    });
  }
}

async function dispatchOperatorInput(page: Page, input: BrowserOperatorInput): Promise<void> {
  switch (input.kind) {
    case "press":
      await page.keyboard.press(input.key);
      return;
    case "insertText":
      try {
        await page.keyboard.insertText(input.text);
      } catch {
        // Playwright errors can contain the inserted text, including pasted passwords.
        throw new Error(
          "Unable to paste text into the browser. Focus an editable field and try again.",
        );
      }
      return;
    case "clickCoords":
      await page.mouse.click(input.x, input.y);
  }
}

/**
 * Deliver one burst of operator input in order. Bursts share a page's navigation
 * guard while they keep arriving; a navigation ends the session before any later
 * input, so keys typed for one document never reach the next one unchecked.
 */
export async function sendOperatorInputViaPlaywright(
  opts: GuardedInteractionOptions & { inputs: BrowserOperatorInput[] },
): Promise<BrowserOperatorInputResult> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  const { inputs, signal, assertCurrent, ...sessionOpts } = opts;
  return await new Promise<BrowserOperatorInputResult>((resolve, reject) => {
    const burst: Burst = {
      inputs,
      ...(assertCurrent ? { assertCurrent } : {}),
      ...(signal ? { signal } : {}),
      sent: 0,
      resolve,
      reject,
    };
    const admit = async () => {
      for (;;) {
        if (lateFailures.has(page)) {
          const failure = lateFailures.get(page);
          lateFailures.delete(page);
          reject(toErrorObject(failure, "Browser operator input failed"));
          return;
        }
        const current = sessions.get(page);
        if (current?.canShare(sessionOpts) && current.enqueue(burst)) {
          return;
        }
        if (current) {
          // A finishing or differently scoped session settles its guard first.
          current.retire();
          await current.finished;
          continue;
        }
        const session = new OperatorInputSession(page, {
          ...sessionOpts,
          ...(assertCurrent ? { assertCurrent } : {}),
        });
        sessions.set(page, session);
        session.enqueue(burst);
        return;
      }
    };
    admit().catch((error: unknown) => reject(new Error(formatErrorMessage(error))));
  });
}
