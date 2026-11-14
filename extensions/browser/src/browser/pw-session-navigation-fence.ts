import { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { CDPSession, Page } from "playwright-core";
import { resolveBrowserNavigationTimeoutMs } from "./act-policy.js";
import { isRetiredFetchInterceptionError } from "./cdp-fetch-interception.js";
import {
  assertBrowserNavigationAllowed,
  type BrowserNavigationPolicyOptions,
} from "./navigation-guard.js";
import { createStandingNavigationPolicy } from "./pw-session-navigation-standing.js";

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
  targetInfo: { type: string; targetId: string; url: string };
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
  request: { url: string; headers: Record<string, string> };
};
type NetworkRequest = { requestId: string; type?: string; frameId?: string };
type TargetState = {
  documents: Map<string, string | undefined>;
  finishedDocuments: Set<string>;
  transferredFrames: Set<string>;
  removeListeners: () => void;
};

export type NavigationDocumentRoute = {
  continue: () => Promise<void>;
  fallback: () => Promise<void>;
  abort: () => Promise<void>;
  preserve: () => Promise<void>;
};
export type NavigationDocumentRequest = {
  url: () => string;
  isTopLevel: () => boolean;
};
export type NavigationAuthorityFenceDisposeOptions = {
  stopLoading?: boolean;
};

/**
 * Resolve or fail one paused request. A request the page already cancelled has
 * nothing left to admit or deny, so its retired id is not a navigation failure.
 */
async function settleInterception(
  target: NavigationTargetSession,
  method: "Fetch.continueRequest" | "Fetch.failRequest",
  params: { requestId: string; errorReason?: "Failed" | "Aborted" | "BlockedByClient" },
): Promise<void> {
  try {
    await target.send(method, params);
  } catch (error) {
    if (!isRetiredFetchInterceptionError(error)) {
      throw error;
    }
  }
}

type NavigationDocumentHandler = (
  route: NavigationDocumentRoute,
  request: NavigationDocumentRequest,
) => Promise<void>;

/** One invocation's claim on its tab's document decisions. */
type Invocation = {
  policy: BrowserNavigationPolicyOptions;
  handleDocument?: NavigationDocumentHandler;
  inFlight: Set<Promise<void>>;
  isOpen: () => boolean;
  fail: (error: unknown) => void;
  assertTargetCurrent: () => void;
};

const tabFences = new WeakMap<Page, ReturnType<typeof createTabFence>>();

/**
 * One document interception session per tab, shared by the invocations that
 * claim it. Each claiming invocation decides a paused document in turn; with
 * no claim, the tab's standing policy does.
 */
function createTabFence(page: Page, session: CDPSession) {
  let mainFrameId: string | undefined;
  const states = new Map<NavigationTargetSession, TargetState>();
  const invocations = new Set<Invocation>();
  let released: Promise<unknown> = Promise.resolve();
  let stateChanged = createDeferred<void>();
  const standing = createStandingNavigationPolicy();
  const notify = () => {
    stateChanged.resolve();
    stateChanged = createDeferred<void>();
  };
  const fail = (error: unknown) => {
    for (const invocation of invocations) {
      invocation.fail(error);
    }
  };
  const enforceStanding = async (target: NavigationTargetSession, event: PausedRequest) => {
    const errorReason = await standing.denial({
      url: event.request.url,
      headers: event.request.headers,
      frameId: event.frameId ?? (target.parent ? target.frameId : mainFrameId),
      mainFrameId,
    });
    const settled = errorReason
      ? settleInterception(target, "Fetch.failRequest", { requestId: event.requestId, errorReason })
      : settleInterception(target, "Fetch.continueRequest", { requestId: event.requestId });
    // A target lost meanwhile has nothing left to settle.
    await settled.catch(() => {});
  };
  const interceptDocuments = (target: NavigationTargetSession) =>
    target.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
    });
  const initialize = async (target: NavigationTargetSession) => {
    const documents = new Map<string, string | undefined>();
    const finishedDocuments = new Set<string>();
    const transferredFrames = new Set<string>();
    const started = (event: NetworkRequest) => {
      // Documents are owned only while an invocation waits on them to settle.
      if (
        invocations.size > 0 &&
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
    const committed = (event: { frame: { id: string } }) => {
      // A committed response cannot redirect. Retire its navigation ownership,
      // not its still-loading body or children; each new document request keeps
      // its own admission check and uncommitted redirects remain fenced.
      for (const [requestId, frameId] of documents) {
        if (frameId === event.frame.id) {
          documents.delete(requestId);
          finishedDocuments.add(requestId);
        }
      }
      notify();
    };
    const handle = async (event: PausedRequest, claims: Invocation[]): Promise<void> => {
      const [invocation, ...later] = claims;
      if (!invocation) {
        await settleInterception(target, "Fetch.continueRequest", { requestId: event.requestId });
        return;
      }
      const { policy, handleDocument } = invocation;
      try {
        if (invocation.isOpen()) {
          if (handleDocument) {
            const isTopLevel = !target.parent && (!event.frameId || event.frameId === mainFrameId);
            const finishInterceptedDocument = () => {
              const interceptedFrameId =
                event.frameId ?? (target.parent ? target.frameId : mainFrameId);
              const requestIds = new Set(
                [event.networkId, event.requestId].filter((requestId): requestId is string =>
                  Boolean(requestId),
                ),
              );
              for (const [requestId, frameId] of documents) {
                if (
                  requestIds.has(requestId) ||
                  (interceptedFrameId && frameId === interceptedFrameId)
                ) {
                  documents.delete(requestId);
                  finishedDocuments.add(requestId);
                }
              }
              for (const requestId of requestIds) {
                finishedDocuments.add(requestId);
              }
              notify();
            };
            const resume = async () => {
              invocation.assertTargetCurrent();
              await handle(event, later);
            };
            await handleDocument(
              {
                continue: resume,
                fallback: resume,
                abort: async () => {
                  await settleInterception(target, "Fetch.failRequest", {
                    requestId: event.requestId,
                    errorReason: "Failed",
                  });
                  finishInterceptedDocument();
                },
                preserve: async () => {
                  // Raw CDP cancellation leaves the current document intact.
                  // A synthetic 204 keeps the URL but replaces Chromium's title
                  // with a provisional "Loading ..." state.
                  await settleInterception(target, "Fetch.failRequest", {
                    requestId: event.requestId,
                    errorReason: "Aborted",
                  });
                  finishInterceptedDocument();
                },
              },
              {
                url: () => event.request.url,
                isTopLevel: () => isTopLevel,
              },
            );
            return;
          }
          if (event.resourceType === "Document") {
            await assertBrowserNavigationAllowed({ url: event.request.url, ...policy });
          }
          if (!states.has(target)) {
            return;
          }
          if (invocation.isOpen()) {
            policy.assertNavigationCurrent?.();
            await handle(event, later);
            return;
          }
        }
      } catch (error) {
        if (!states.has(target)) {
          return;
        }
        invocation.fail(error);
      }
      if (!states.has(target)) {
        return;
      }
      await settleInterception(target, "Fetch.failRequest", {
        requestId: event.requestId,
        errorReason: "Aborted",
      }).catch((error: unknown) => {
        if (states.has(target)) {
          invocation.fail(error);
        }
      });
    };
    const listener = (event: PausedRequest) => {
      if (event.networkId) {
        started({ requestId: event.networkId, type: event.resourceType, frameId: event.frameId });
      }
      // Claims are fixed at arrival: a request never moves to a later invocation's grant.
      const claims = [...invocations];
      const operation = claims.length > 0 ? handle(event, claims) : enforceStanding(target, event);
      for (const invocation of claims) {
        invocation.inFlight.add(operation);
      }
      void operation.then(() => {
        for (const invocation of claims) {
          invocation.inFlight.delete(operation);
        }
        notify();
      });
    };
    const state: TargetState = {
      documents,
      finishedDocuments,
      transferredFrames,
      removeListeners: () => {
        target.events.off("Fetch.requestPaused", listener);
        target.events.off("Network.requestWillBeSent", started);
        target.events.off("Network.loadingFinished", finished);
        target.events.off("Network.loadingFailed", finished);
        target.events.off("Page.frameNavigated", committed);
        unobserveFrames();
      },
    };
    states.set(target, state);
    target.events.on("Fetch.requestPaused", listener);
    target.events.on("Network.requestWillBeSent", started);
    target.events.on("Network.loadingFinished", finished);
    target.events.on("Network.loadingFailed", finished);
    target.events.on("Page.frameNavigated", committed);
    const unobserveFrames = standing.observe(target.events);
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
    await target.send("Page.enable");
    if (invocations.size > 0) {
      await target.send("Network.enable");
    }
    await interceptDocuments(target);
  };
  const detachedTarget = (target: NavigationTargetSession) => {
    states.get(target)?.removeListeners();
    states.delete(target);
    if (target.parent && target.frameId) {
      states.get(target.parent)?.transferredFrames.delete(target.frameId);
    } else if (!page.isClosed()) {
      // The lost session released its interception; the next invocation attaches anew.
      retire();
      fail(new Error("Browser navigation authority target detached"));
    }
    notify();
  };
  /**
   * Public CDPSession has no child-session factory. Non-flat Target protocol keeps
   * child sessions under this tab's independently attached page session;
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
    "Page.frameNavigated",
    "Page.frameRequestedNavigation",
    "Page.frameDetached",
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
      standing.frameCommitted(event.targetInfo.targetId, event.targetInfo.url);
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
      // The tab outlives its frames; a detached target takes its cleanup with it.
      removers.delete(remove);
      for (const childSession of children.values()) {
        childSession.reject(new Error("Navigation frame ancestor detached"));
      }
      children.clear();
    };
    target.events.on("navigationDetached", closeChildren);
    target.events.on("Target.attachedToTarget", attached);
    target.events.on("Target.receivedMessageFromTarget", received);
    target.events.on("Target.detachedFromTarget", detached);
    const remove = () => {
      target.events.off("navigationDetached", closeChildren);
      target.events.off("Target.attachedToTarget", attached);
      target.events.off("Target.receivedMessageFromTarget", received);
      target.events.off("Target.detachedFromTarget", detached);
      for (const childSession of children.values()) {
        childSession.reject(new Error("Navigation authority fence ended"));
      }
    };
    removers.add(remove);
    await initialize(target);
    await target.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
      filter: [{ type: "iframe" }, { exclude: true }],
    });
    if (child) {
      // Interception is already on, so the frame's own documents stay fenced.
      await target.send("Runtime.runIfWaitingForDebugger");
    }
  };
  const ready = (async () => {
    const tree = await session.send("Page.getFrameTree");
    mainFrameId = tree.frameTree.frame.id;
    standing.seed(tree.frameTree);
    await prepare(rootTarget);
  })();
  const closed = () => {
    for (const state of states.values()) {
      state.documents.clear();
    }
    retire();
    notify();
  };
  page.on("close", closed);
  const retire = () => {
    tabFences.delete(page);
    for (const state of states.values()) {
      state.removeListeners();
    }
    for (const remove of removers) {
      remove();
    }
    removers.clear();
    states.clear();
    page.off("close", closed);
    void session.detach().catch(() => {});
  };
  // A tab that never attached must not hand the same failure to every later invocation.
  ready.catch(retire);
  return {
    session,
    states,
    initialization,
    invocations,
    standing,
    ready,
    notify,
    changed: () => stateChanged.promise,
    /**
     * Waits for the last release's answer. A release that is never answered fails
     * the wait instead of being started over.
     */
    untilReleased: async () => {
      await raceWithTimeout(released, resolveBrowserNavigationTimeoutMs(), () => {
        throw new Error("Browser navigation interception was not released in time");
      });
    },
    /** Starts what only a claimed tab runs. */
    claim: async () => {
      await Promise.all(
        [...states.keys()].map((target) =>
          target.send("Network.enable").catch((error: unknown) => {
            // A frame target lost meanwhile has nothing left to track.
            if (states.has(target)) {
              throw error;
            }
          }),
        ),
      );
    },
    release: () => {
      released = Promise.allSettled(
        [...states.keys()].map((target) => target.send("Network.disable")),
      ).then(() => {
        // Nothing tracked before tracking stopped reports its end.
        for (const state of states.values()) {
          state.documents.clear();
          state.finishedDocuments.clear();
        }
      });
      return released;
    },
  };
}

/** Fence every Chromium redirect hop, including separately hosted iframe targets. */
export async function installNavigationAuthorityFence(
  page: Page,
  policy: BrowserNavigationPolicyOptions,
  onError: (error: unknown) => void,
  handleDocument?: NavigationDocumentHandler,
): Promise<(options?: NavigationAuthorityFenceDisposeOptions) => Promise<unknown>> {
  const assertCurrent = policy.assertNavigationCurrent ?? (() => {});
  let tab = tabFences.get(page);
  if (!tab) {
    const session = await page.context().newCDPSession(page);
    // A concurrent invocation may have attached the tab meanwhile.
    tab = tabFences.get(page);
    if (tab) {
      void session.detach().catch(() => {});
    } else {
      tab = createTabFence(page, session);
      tabFences.set(page, tab);
    }
  }
  const { session, states, initialization, invocations, notify } = tab;
  const inFlight = new Set<Promise<void>>();
  let closing = false;
  let failed = false;
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
  const invocation: Invocation = {
    policy,
    handleDocument,
    inFlight,
    isOpen: () => !closing && !failed,
    fail,
    assertTargetCurrent,
  };
  invocations.add(invocation);
  if (policy.standingSsrfPolicy) {
    tab.standing.set({
      ssrfPolicy: policy.standingSsrfPolicy,
      ...(policy.browserProxyMode ? { browserProxyMode: policy.browserProxyMode } : {}),
    });
  }
  const dispose = async (options: NavigationAuthorityFenceDisposeOptions = {}) => {
    const deadline = createDeferred<never>();
    const timer = setTimeout(() => {
      deadline.reject(new Error("Browser navigation did not settle before authority cleanup"));
    }, resolveBrowserNavigationTimeoutMs());
    // Bound each wait, not a detached cleanup coroutine that could later release
    // the claim after the timeout path has retained it.
    const bounded = <T>(operation: Promise<T>) => Promise.race([operation, deadline.promise]);
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
        // The command acknowledgement is the terminal ownership boundary. CDP
        // does not consistently emit Network.loadingFailed for every committed
        // streaming document, so do not wait for an optional follow-up event.
        for (const state of states.values()) {
          state.documents.clear();
        }
        notify();
      }
    };
    const drain = async () => {
      while (!page.isClosed() && (inFlight.size > 0 || initialization.size > 0)) {
        await bounded(Promise.allSettled([...inFlight, ...initialization]));
      }
    };
    try {
      checkCurrent();
      // Actions such as `location.href = ...` can resolve in Playwright before
      // this independently attached session receives the queued document event.
      // A same-target round trip establishes an event-delivery barrier before
      // the first idle-state decision releases this invocation's claim.
      await bounded(session.send("Runtime.evaluate", { expression: "void 0" }));
      let loadingSettled = false;
      for (;;) {
        // Capture before reading state so a terminal event cannot notify
        // between the predicate and the wait and leave cleanup asleep.
        const changed = tab.changed();
        if (!loadingSettled && options.stopLoading) {
          await stopLoading();
          loadingSettled = true;
        }
        const activeDocuments = [...states.values()].some((state) => state.documents.size > 0);
        if (
          failed ||
          page.isClosed() ||
          (!activeDocuments && inFlight.size === 0 && initialization.size === 0)
        ) {
          break;
        }
        await bounded(changed);
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
      invocations.delete(invocation);
      notify();
      if (invocations.size === 0) {
        // The next invocation's document tracking starts after this one's has stopped.
        await bounded(tab.release());
      }
      return undefined;
    } catch (error) {
      closing = true;
      if (page.isClosed()) {
        invocations.delete(invocation);
        notify();
        return undefined;
      }
      fail(error);
      // Unconfirmed cancellation must not release pending requests: the closed
      // claim stays and refuses every document. Only this genuinely failed
      // cleanup requires closing the selected tab to recover. Later invocations
      // have nothing of this one's left to wait for.
      for (const state of states.values()) {
        state.documents.clear();
      }
      notify();
      return error;
    } finally {
      clearTimeout(timer);
    }
  };
  let started = false;
  try {
    await tab.ready;
    await tab.untilReleased();
    started = true;
    await tab.claim();
    while (initialization.size > 0) {
      await Promise.all(initialization);
    }
    assertTargetCurrent();
  } catch (error) {
    fail(error);
    if (started) {
      await dispose();
    } else {
      // Nothing of this invocation started, so it only gives up its claim.
      invocations.delete(invocation);
      notify();
    }
    throw error;
  }
  return dispose;
}
