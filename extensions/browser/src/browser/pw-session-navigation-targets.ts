import { EventEmitter } from "node:events";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CDPSession } from "playwright-core";

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
export type NavigationTargetSession = {
  events: EventEmitter;
  parent?: NavigationTargetSession;
  frameId?: string;
  send: (method: Command, params?: CommandParameters) => Promise<unknown>;
};

type PendingCommand = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

/**
 * Public CDPSession has no child-session factory. Non-flat Target protocol keeps
 * child sessions under this operation's independently attached page session;
 * Playwright continues managing its own frame sessions and debugger resumes.
 */
export function observeNavigationTargetSessions(
  root: CDPSession,
  options: {
    initialize: (target: NavigationTargetSession) => Promise<void>;
    detached: (target: NavigationTargetSession) => void;
    assertCurrent: () => void;
    onError: (error: unknown) => void;
    changed: () => void;
  },
): {
  ready: Promise<void>;
  pending: ReadonlySet<Promise<void>>;
  removeListeners: () => void;
} {
  const initialization = new Set<Promise<void>>();
  const removers = new Set<() => void>();
  const rootEvents = new EventEmitter();
  const rootTarget: NavigationTargetSession = { events: rootEvents, send: root.send.bind(root) };
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
    root.on(method, forward);
    removers.add(() => root.off(method, forward));
  }
  const rootClosed = () => {
    rootEvents.emit("navigationDetached");
    options.detached(rootTarget);
  };
  root.on("close", rootClosed);
  removers.add(() => root.off("close", rootClosed));

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
        options.detached(session);
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
      const session: NavigationTargetSession = {
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
      children.set(event.sessionId, { target: session, reject });
      const operation = prepare(session, true).catch((error: unknown) => {
        if (!detached) {
          options.onError(error);
        }
      });
      initialization.add(operation);
      options.changed();
      void operation.then(() => {
        initialization.delete(operation);
        options.changed();
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
        options.onError(error);
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
    await options.initialize(target);
    options.assertCurrent();
    await target.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
      filter: [{ type: "iframe" }, { exclude: true }],
    });
    if (child) {
      options.assertCurrent();
      await target.send("Runtime.runIfWaitingForDebugger");
    }
  };
  const ready = (async () => {
    await prepare(rootTarget);
    while (initialization.size > 0) {
      await Promise.all(initialization);
    }
    options.assertCurrent();
  })();
  return {
    ready,
    pending: initialization,
    removeListeners: () => {
      for (const remove of removers) {
        remove();
      }
      removers.clear();
    },
  };
}
