import type {
  BrowserAnnotationCommand,
  BrowserAnnotationState,
} from "openclaw/plugin-sdk/browser-annotations";
import {
  browserAnnotationBootstrapSource,
  installBrowserAnnotationsOnPage,
} from "./annotation-bootstrap.js";
import { getPageForTargetId } from "./pw-session-connection.js";
import {
  assertInteractionCurrent,
  runCancellablePageInteraction,
  type GuardedInteractionOptions,
} from "./pw-tools-core.interactions.navigation.js";

/** The route owns admission; these operations retain its action and navigation guards. */
export async function annotationsViaPlaywright(
  opts: GuardedInteractionOptions & { command: BrowserAnnotationCommand },
): Promise<BrowserAnnotationState> {
  const page = await getPageForTargetId(opts);
  return await runCancellablePageInteraction(page, opts, async (signal) => {
    signal.throwIfAborted();
    const beforeInstall = assertInteractionCurrent(opts);
    if (beforeInstall) {
      await beforeInstall;
    }
    await installBrowserAnnotationsOnPage(page);
    signal.throwIfAborted();
    const beforeDispatch = assertInteractionCurrent(opts);
    if (beforeDispatch) {
      await beforeDispatch;
    }
    // Install on the already-loaded document too. No automatic reload: it could
    // discard user work. New documents execute the same bootstrap before scripts.
    const result = await page.evaluate<BrowserAnnotationState>(
      `${browserAnnotationBootstrapSource}\ndocument.__openclawAnnotationHost(${JSON.stringify(opts.command)})`,
    );
    signal.throwIfAborted();
    const beforePublish = assertInteractionCurrent(opts);
    if (beforePublish) {
      await beforePublish;
    }
    return result;
  });
}
