import type { Frame, Page, Request } from "playwright-core";
import { assertBrowserNavigationResultAllowed } from "./navigation-guard.js";
import { runActionExecution } from "./pw-tools-core.interactions.execution.js";
import {
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
  /** The main frame navigated, so later inputs were withheld from the new document. */
  navigated?: true;
  blockedByDialog?: true;
  browserState?: unknown;
  targetId?: string;
};

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
 * Deliver one burst of operator input in order under one navigation guard, so
 * the burst pays the guard's post-action window once instead of per input. A
 * main-frame navigation request or commit stops the burst before any later
 * input; a subframe navigation stops it only when its URL is denied.
 */
export async function sendOperatorInputViaPlaywright(
  opts: GuardedInteractionOptions & { inputs: BrowserOperatorInput[] },
): Promise<BrowserOperatorInputResult> {
  const { inputs, ...executionOpts } = opts;
  let sent = 0;
  let navigated = false;
  let subframeDenied = false;
  const outcome = await runActionExecution(executionOpts, true, async (page, execution) => {
    const markNavigated = () => {
      navigated = true;
    };
    const subframes: string[] = [];
    const frameListener = createInteractionFrameListener(
      page,
      page.url(),
      subframes,
      markNavigated,
    );
    const policy = interactionNavigationPolicy(execution);
    const onFrameNavigated = (frame: Frame) => {
      const checked = subframes.length;
      frameListener(frame);
      // An iframe reload does not change where input goes; only a denied one stops
      // the burst. The guard rechecks every subframe and rejects with the denial.
      for (const url of subframes.slice(checked)) {
        assertBrowserNavigationResultAllowed({ url, ...policy }).catch(() => {
          subframeDenied = true;
        });
      }
    };
    const onRequest = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        markNavigated();
      }
    };
    page.on("framenavigated", onFrameNavigated);
    page.on("request", onRequest);
    try {
      await runGuardedPageInteraction(page, execution, async () => {
        for (const input of inputs) {
          if (navigated || subframeDenied || execution.signal?.aborted) {
            return;
          }
          await dispatchOperatorInput(page, input);
          sent += 1;
        }
      });
    } finally {
      page.off("framenavigated", onFrameNavigated);
      page.off("request", onRequest);
    }
    return {};
  });
  if ("blockedByDialog" in outcome) {
    return {
      sent,
      blockedByDialog: true,
      browserState: outcome.browserState,
      ...(outcome.targetId ? { targetId: outcome.targetId } : {}),
    };
  }
  return {
    sent,
    ...(navigated ? { navigated: true as const } : {}),
    ...(outcome.targetId ? { targetId: outcome.targetId } : {}),
  };
}
