import type { Page } from "playwright-core";
import { resolveBrowserNavigationTimeoutMs } from "./act-policy.js";
import {
  assertBrowserNavigationAllowed,
  type BrowserNavigationPolicyOptions,
} from "./navigation-guard.js";
import {
  observeNavigationTargetSessions,
  type NavigationTargetSession,
} from "./pw-session-navigation-targets.js";

type PausedRequest = {
  requestId: string;
  networkId?: string;
  frameId?: string;
  resourceType: string;
  request: { url: string };
};
type NetworkRequest = { requestId: string; type?: string; frameId?: string };
type TargetState = {
  documents: Map<string, string | undefined>;
  finishedDocuments: Set<string>;
  transferredFrames: Set<string>;
  intercepting: boolean;
  removeFetchListener: () => void;
  restoreFetchListener: () => void;
  removeListeners: () => void;
};

/** Fence every Chromium redirect hop, including separately hosted iframe targets. */
export async function installNavigationAuthorityFence(
  page: Page,
  policy: BrowserNavigationPolicyOptions,
  onError: (error: unknown) => void,
): Promise<() => Promise<unknown>> {
  const assertCurrent = policy.assertNavigationCurrent;
  if (!assertCurrent) {
    return async () => undefined;
  }
  const session = await page.context().newCDPSession(page);
  const states = new Map<NavigationTargetSession, TargetState>();
  const inFlight = new Set<Promise<void>>();
  let stateChanged = Promise.withResolvers<void>();
  let closing = false;
  let failed = false;
  const notify = () => {
    stateChanged.resolve();
    stateChanged = Promise.withResolvers<void>();
  };
  const fail = (error: unknown) => {
    failed = true;
    onError(error);
    notify();
  };
  const assertTargetCurrent = () => {
    assertCurrent();
    if (closing || failed) {
      throw new Error("Browser navigation authority fence is no longer admitting targets");
    }
  };
  const initialize = async (target: NavigationTargetSession) => {
    const documents = new Map<string, string | undefined>();
    const finishedDocuments = new Set<string>();
    const transferredFrames = new Set<string>();
    const started = (event: NetworkRequest) => {
      if (
        event.type === "Document" &&
        !finishedDocuments.has(event.requestId) &&
        !(event.frameId && transferredFrames.has(event.frameId))
      ) {
        documents.set(event.requestId, event.frameId);
        notify();
      }
    };
    const finished = (event: { requestId: string }) => {
      if (documents.delete(event.requestId)) {
        finishedDocuments.add(event.requestId);
        notify();
      }
    };
    const handle = async (event: PausedRequest) => {
      try {
        if (!closing && !failed) {
          if (event.resourceType === "Document") {
            await assertBrowserNavigationAllowed({ url: event.request.url, ...policy });
          }
          if (!states.has(target)) {
            return;
          }
          if (!closing && !failed) {
            assertCurrent();
            await target.send("Fetch.continueRequest", { requestId: event.requestId });
            return;
          }
        }
      } catch (error) {
        if (!states.has(target)) {
          return;
        }
        fail(error);
      }
      if (!states.has(target)) {
        return;
      }
      await target
        .send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Aborted",
        })
        .catch((error: unknown) => {
          if (states.has(target)) {
            fail(error);
          }
        });
    };
    const listener = (event: PausedRequest) => {
      if (event.networkId) {
        started({ requestId: event.networkId, type: event.resourceType, frameId: event.frameId });
      }
      const operation = handle(event);
      inFlight.add(operation);
      void operation.then(() => {
        inFlight.delete(operation);
        notify();
      });
    };
    const state: TargetState = {
      documents,
      finishedDocuments,
      transferredFrames,
      intercepting: false,
      removeFetchListener: () => target.events.off("Fetch.requestPaused", listener),
      restoreFetchListener: () => target.events.on("Fetch.requestPaused", listener),
      removeListeners: () => {
        target.events.off("Fetch.requestPaused", listener);
        target.events.off("Network.requestWillBeSent", started);
        target.events.off("Network.loadingFinished", finished);
        target.events.off("Network.loadingFailed", finished);
      },
    };
    states.set(target, state);
    target.events.on("Fetch.requestPaused", listener);
    target.events.on("Network.requestWillBeSent", started);
    target.events.on("Network.loadingFinished", finished);
    target.events.on("Network.loadingFailed", finished);
    if (target.parent && target.frameId) {
      // At OOPIF response handoff the parent no longer receives the document's
      // terminal Network event. The child initialization barrier owns the swap.
      const parent = states.get(target.parent);
      parent?.transferredFrames.add(target.frameId);
      for (const [requestId, frameId] of parent?.documents ?? []) {
        if (frameId === target.frameId) {
          parent?.documents.delete(requestId);
          parent?.finishedDocuments.add(requestId);
        }
      }
    }
    notify();
    assertTargetCurrent();
    await target.send("Network.enable");
    assertTargetCurrent();
    state.intercepting = true;
    await target.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    assertTargetCurrent();
  };
  const targets = observeNavigationTargetSessions(session, {
    initialize,
    assertCurrent: assertTargetCurrent,
    onError: fail,
    changed: notify,
    detached: (target) => {
      states.get(target)?.removeListeners();
      states.delete(target);
      if (target.parent && target.frameId) {
        states.get(target.parent)?.transferredFrames.delete(target.frameId);
      } else if (!closing && !page.isClosed()) {
        fail(new Error("Browser navigation authority target detached"));
      }
      notify();
    },
  });
  const closed = () => {
    for (const state of states.values()) {
      state.documents.clear();
    }
    notify();
  };
  page.on("close", closed);
  const removeListeners = () => {
    for (const state of states.values()) {
      state.removeListeners();
    }
    targets.removeListeners();
    states.clear();
    page.off("close", closed);
  };
  const dispose = async () => {
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      deadline.reject(new Error("Browser navigation did not settle before authority cleanup"));
    }, resolveBrowserNavigationTimeoutMs());
    // Bound each wait, not a detached cleanup coroutine that could later release
    // interception after the timeout path has retained it.
    const bounded = <T>(operation: Promise<T>) => Promise.race([operation, deadline.promise]);
    const retainUntilClose = () => {
      page.once("close", () => {
        removeListeners();
        void session.detach().catch(() => {});
      });
    };
    const checkCurrent = () => {
      try {
        assertCurrent();
      } catch (error) {
        fail(error);
      }
    };
    const stopLoading = async () => {
      // Chromium accepts this command only on the top-level target. It stops
      // the WebContents' entire frame tree, including out-of-process iframes.
      if (!page.isClosed()) {
        await bounded(session.send("Page.stopLoading"));
      }
    };
    const drain = async () => {
      while (!page.isClosed() && (inFlight.size > 0 || targets.pending.size > 0)) {
        await bounded(Promise.allSettled([...inFlight, ...targets.pending]));
      }
    };
    let fetchListenersRemoved = false;
    try {
      checkCurrent();
      for (;;) {
        const activeDocuments = [...states.values()].some((state) => state.documents.size > 0);
        if (
          failed ||
          page.isClosed() ||
          (!activeDocuments && inFlight.size === 0 && targets.pending.size === 0)
        ) {
          break;
        }
        await bounded(stateChanged.promise);
      }
      closing = true;
      checkCurrent();
      if (failed) {
        await stopLoading();
      }
      await drain();
      checkCurrent();
      // Include frames registered while cancellation awaited protocol replies.
      if (failed) {
        await stopLoading();
        await drain();
      }
      // Remove request listeners synchronously before detach can invalidate ids.
      for (const state of states.values()) {
        state.removeFetchListener();
      }
      fetchListenersRemoved = true;
      await bounded(session.detach());
      removeListeners();
      return undefined;
    } catch (error) {
      closing = true;
      fail(error);
      if (page.isClosed()) {
        removeListeners();
        void session.detach().catch(() => {});
      } else {
        if (fetchListenersRemoved) {
          for (const state of states.values()) {
            state.restoreFetchListener();
          }
        }
        // Unconfirmed cancellation must not release pending requests. Only this
        // genuinely failed cleanup requires closing the selected tab to recover.
        retainUntilClose();
      }
      return error;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await targets.ready;
  } catch (error) {
    fail(error);
    await dispose();
    throw error;
  }
  return dispose;
}
