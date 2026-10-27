import { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CDPSession, Page } from "playwright-core";
import { resolveBrowserNavigationTimeoutMs } from "./act-policy.js";
import {
  assertBrowserNavigationAllowed,
  type BrowserNavigationPolicyOptions,
} from "./navigation-guard.js";

type Command = Parameters<CDPSession["send"]>[0];
type CommandParameters = Parameters<CDPSession["send"]>[1];
type ProtocolMessage = {
  id?: number;
  method?: string;
  params?: object;
  error?: { message: string };
  result?: unknown;
};
type AttachedTarget = {
  sessionId: string;
  targetInfo: { type: string; targetId: string };
};

/** A page target or its own independently attached OOPIF protocol session. */
type NavigationTargetSession = {
  events: EventEmitter;
  parent?: NavigationTargetSession;
  frameId?: string;
  send: (method: Command, params?: CommandParameters) => Promise<unknown>;
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

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
  let stateChanged = createDeferred<void>();
  let closing = false;
  let failed = false;
  const notify = () => {
    stateChanged.resolve();
    stateChanged = createDeferred<void>();
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
    await target.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    assertTargetCurrent();
  };
  const detachedTarget = (target: NavigationTargetSession) => {
    states.get(target)?.removeListeners();
    states.delete(target);
    if (target.parent && target.frameId) {
      states.get(target.parent)?.transferredFrames.delete(target.frameId);
    } else if (!closing && !page.isClosed()) {
      fail(new Error("Browser navigation authority target detached"));
    }
    notify();
  };
  /**
   * Public CDPSession has no child-session factory. Non-flat Target protocol keeps
   * child sessions under this operation's independently attached page session;
   * Playwright continues managing its own frame sessions and debugger resumes.
   */
  const initialization = new Set<Promise<void>>();
  const removers = new Set<() => void>();
  const rootEvents = new EventEmitter();
  const rootTarget: NavigationTargetSession = {
    events: rootEvents,
    send: session.send.bind(session),
  };
  for (const method of [
    "Network.requestWillBeSent",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Fetch.requestPaused",
    "Target.attachedToTarget",
    "Target.receivedMessageFromTarget",
    "Target.detachedFromTarget",
  ] as const) {
    const forward = (params: object) => rootEvents.emit(method, params);
    session.on(method, forward);
    removers.add(() => session.off(method, forward));
  }
  const rootClosed = () => {
    rootEvents.emit("navigationDetached");
    detachedTarget(rootTarget);
  };
  session.on("close", rootClosed);
  removers.add(() => session.off("close", rootClosed));

  const prepare = async (target: NavigationTargetSession, child = false) => {
    const children = new Map<
      string,
      { target: NavigationTargetSession; reject: (error: unknown) => void }
    >();
    const attached = (event: AttachedTarget) => {
      const events = new EventEmitter();
      const pending = new Map<number, PendingCommand>();
      let nextId = 0;
      let detached = false;
      const reject = (error: unknown) => {
        if (detached) {
          return;
        }
        detached = true;
        for (const callback of pending.values()) {
          callback.reject(error);
        }
        pending.clear();
        events.emit("navigationDetached");
        detachedTarget(attachedSession);
      };
      events.on("protocol", (message: ProtocolMessage) => {
        if (message.id === undefined) {
          return;
        }
        const callback = pending.get(message.id);
        if (!callback) {
          return;
        }
        pending.delete(message.id);
        if (message.error) {
          callback.reject(new Error(message.error.message));
        } else {
          callback.resolve(message.result);
        }
      });
      const attachedSession: NavigationTargetSession = {
        events,
        parent: target,
        frameId: event.targetInfo.targetId,
        send: (method, params) => {
          if (detached) {
            return Promise.reject(new Error("Navigation frame target detached"));
          }
          const id = ++nextId;
          const result = new Promise<unknown>((resolve, rejectCommand) => {
            pending.set(id, { resolve, reject: rejectCommand });
          });
          void target
            .send("Target.sendMessageToTarget", {
              sessionId: event.sessionId,
              message: JSON.stringify({ id, method, params }),
            })
            .catch((error: unknown) => {
              pending.get(id)?.reject(error);
              pending.delete(id);
            });
          return result;
        },
      };
      // Register before any await so detach and nested protocol events always
      // resolve against the same operation-owned target identity.
      children.set(event.sessionId, { target: attachedSession, reject });
      const operation = prepare(attachedSession, true).catch((error: unknown) => {
        if (!detached) {
          fail(error);
        }
      });
      initialization.add(operation);
      notify();
      void operation.then(() => {
        initialization.delete(operation);
        notify();
      });
    };
    const received = (event: { sessionId: string; message: string }) => {
      const childSession = children.get(event.sessionId);
      if (!childSession) {
        return;
      }
      // Browser-owned CDP JSON is the transport boundary; no page values become
      // methods or command identifiers here.
      try {
        const decoded: unknown = JSON.parse(event.message);
        if (!isRecord(decoded)) {
          throw new Error("Invalid navigation target protocol message");
        }
        const message: ProtocolMessage = {
          id: typeof decoded.id === "number" ? decoded.id : undefined,
          method: typeof decoded.method === "string" ? decoded.method : undefined,
          params: isRecord(decoded.params) ? decoded.params : undefined,
          result: decoded.result,
          error: isRecord(decoded.error)
            ? {
                message:
                  typeof decoded.error.message === "string"
                    ? decoded.error.message
                    : "Navigation target command failed",
              }
            : undefined,
        };
        childSession.target.events.emit("protocol", message);
        if (message.method) {
          childSession.target.events.emit(message.method, message.params);
        }
      } catch (error) {
        fail(error);
      }
    };
    const detached = (event: { sessionId: string }) => {
      const childSession = children.get(event.sessionId);
      if (!childSession) {
        return;
      }
      children.delete(event.sessionId);
      childSession.reject(new Error("Navigation frame target detached"));
    };
    const closeChildren = () => {
      for (const childSession of children.values()) {
        childSession.reject(new Error("Navigation frame ancestor detached"));
      }
      children.clear();
    };
    target.events.on("navigationDetached", closeChildren);
    target.events.on("Target.attachedToTarget", attached);
    target.events.on("Target.receivedMessageFromTarget", received);
    target.events.on("Target.detachedFromTarget", detached);
    removers.add(() => {
      target.events.off("navigationDetached", closeChildren);
      target.events.off("Target.attachedToTarget", attached);
      target.events.off("Target.receivedMessageFromTarget", received);
      target.events.off("Target.detachedFromTarget", detached);
      for (const childSession of children.values()) {
        childSession.reject(new Error("Navigation authority fence ended"));
      }
    });
    // Register the target with its policy owner even if authority was lost, so
    // cancellation includes a newly attached, debugger-paused frame.
    await initialize(target);
    assertTargetCurrent();
    await target.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
      filter: [{ type: "iframe" }, { exclude: true }],
    });
    if (child) {
      assertTargetCurrent();
      await target.send("Runtime.runIfWaitingForDebugger");
    }
  };
  const ready = (async () => {
    await prepare(rootTarget);
    while (initialization.size > 0) {
      await Promise.all(initialization);
    }
    assertTargetCurrent();
  })();
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
    for (const remove of removers) {
      remove();
    }
    removers.clear();
    states.clear();
    page.off("close", closed);
  };
  const dispose = async () => {
    const deadline = createDeferred<never>();
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
      while (!page.isClosed() && (inFlight.size > 0 || initialization.size > 0)) {
        await bounded(Promise.allSettled([...inFlight, ...initialization]));
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
          (!activeDocuments && inFlight.size === 0 && initialization.size === 0)
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
    await ready;
  } catch (error) {
    fail(error);
    await dispose();
    throw error;
  }
  return dispose;
}
