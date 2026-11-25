import type { Browser } from "playwright";

export type NavigationNetworkConditions = {
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
};

export type NavigationWorkerRequest = {
  id: string;
  sessionId: string;
  requestId: string;
  url: string;
  type: string;
  requestedAt: number;
  responseAt?: number;
  finishedAt?: number;
  status?: number;
  networkStatus?: number;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  servedFromCache?: boolean;
  receivedBytes: number;
  encodedBytes?: number;
  error?: string;
  canceled?: boolean;
};

type WorkerEvents = {
  "Network.requestWillBeSent": {
    requestId: string;
    request: { url: string };
    type?: string;
    timestamp: number;
  };
  "Network.requestServedFromCache": { requestId: string };
  "Network.responseReceived": {
    requestId: string;
    timestamp: number;
    response: { status: number; fromDiskCache?: boolean; fromServiceWorker?: boolean };
  };
  "Network.responseReceivedExtraInfo": { requestId: string; statusCode: number };
  "Network.dataReceived": { requestId: string; timestamp: number; encodedDataLength: number };
  "Network.loadingFinished": { requestId: string; timestamp: number; encodedDataLength: number };
  "Network.loadingFailed": {
    requestId: string;
    timestamp: number;
    errorText: string;
    canceled?: boolean;
  };
};
type WorkerEvent = {
  [Method in keyof WorkerEvents]: { method: Method; params: WorkerEvents[Method] };
}[keyof WorkerEvents];

/** Page-target emulation does not reach fetches made by the production service worker. */
export async function emulateNavigationWorkerNetwork(
  browser: Browser,
  conditions: NavigationNetworkConditions,
) {
  const cdp = await browser.newBrowserCDPSession();
  let sequence = 0;
  let closed = false;
  const attaching = new Set<string>();
  const failures: Error[] = [];
  const requests: NavigationWorkerRequest[] = [];
  const activeRequests = new Map<string, NavigationWorkerRequest>();
  const events: Array<WorkerEvent & { sessionId: string }> = [];
  const pending = new Map<
    number,
    {
      sessionId: string;
      resolve: () => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const send = (sessionId: string, method: string, params: object = {}) =>
    new Promise<void>((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Service worker CDP ${method} timed out`));
      }, 30_000);
      pending.set(id, { sessionId, resolve, reject, timeout });
      void cdp
        .send("Target.sendMessageToTarget", {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch((error: unknown) => {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  const apply = (sessionId: string) =>
    send(sessionId, "Network.emulateNetworkConditions", {
      offline: false,
      latency: conditions.latency,
      downloadThroughput: conditions.downloadThroughput,
      uploadThroughput: conditions.uploadThroughput,
    });
  cdp.on("Target.receivedMessageFromTarget", (event: { sessionId: string; message: string }) => {
    const message: { id: number; error?: { message: string } } | WorkerEvent = JSON.parse(
      event.message,
    );
    if (!("id" in message)) {
      // Other enabled domains may notify without params. Only the Network
      // events below carry the request identity this collector understands.
      if (
        ![
          "Network.requestWillBeSent",
          "Network.requestServedFromCache",
          "Network.responseReceived",
          "Network.responseReceivedExtraInfo",
          "Network.dataReceived",
          "Network.loadingFinished",
          "Network.loadingFailed",
        ].includes(message.method)
      ) {
        return;
      }
      const key = `${event.sessionId}:${message.params.requestId}`;
      const request = activeRequests.get(key);
      switch (message.method) {
        case "Network.requestWillBeSent": {
          const next: NavigationWorkerRequest = {
            id: `${key}:${requests.length}`,
            sessionId: event.sessionId,
            requestId: message.params.requestId,
            url: message.params.request.url,
            type: message.params.type ?? "Other",
            requestedAt: message.params.timestamp,
            receivedBytes: 0,
          };
          requests.push(next);
          activeRequests.set(key, next);
          break;
        }
        case "Network.requestServedFromCache":
          if (request) {
            request.servedFromCache = true;
          }
          break;
        case "Network.responseReceived":
          if (request) {
            Object.assign(request, {
              responseAt: message.params.timestamp,
              status: message.params.response.status,
              fromDiskCache: message.params.response.fromDiskCache,
              fromServiceWorker: message.params.response.fromServiceWorker,
            });
          }
          break;
        case "Network.responseReceivedExtraInfo":
          if (request) {
            request.networkStatus = message.params.statusCode;
          }
          break;
        case "Network.dataReceived":
          if (request) {
            request.receivedBytes += message.params.encodedDataLength;
          }
          break;
        case "Network.loadingFinished":
          if (request) {
            request.finishedAt = message.params.timestamp;
            request.encodedBytes = message.params.encodedDataLength;
          }
          break;
        case "Network.loadingFailed":
          if (request) {
            request.finishedAt = message.params.timestamp;
            request.error = message.params.errorText;
            request.canceled = message.params.canceled;
          }
          break;
        default:
          return;
      }
      events.push({ ...message, sessionId: event.sessionId });
      return;
    }
    const request = pending.get(message.id);
    if (!request || request.sessionId !== event.sessionId) {
      return;
    }
    clearTimeout(request.timeout);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message));
    } else {
      request.resolve();
    }
  });
  cdp.on(
    "Target.attachedToTarget",
    (event: { sessionId: string; targetInfo: { type: string; targetId: string } }) => {
      const { targetId, type } = event.targetInfo;
      if (type !== "service_worker" || attaching.has(targetId)) {
        return;
      }
      attaching.add(targetId);
      void (async () => {
        // Browser auto-attach requires flat sessions. A second public, non-flat
        // attachment provides sendMessageToTarget without Playwright internals.
        const { sessionId }: { sessionId: string } = await cdp.send("Target.attachToTarget", {
          targetId,
          flatten: false,
        });
        try {
          await send(sessionId, "Network.enable");
          await apply(sessionId);
        } finally {
          try {
            await send(sessionId, "Runtime.runIfWaitingForDebugger");
          } finally {
            // The original flat session owns the worker startup throttle. Release
            // that attachment only after its replacement has applied the profile.
            await cdp.send("Target.detachFromTarget", { sessionId: event.sessionId });
          }
        }
      })().catch((error: unknown) => {
        if (!closed) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  );
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "service_worker" }, { exclude: true }],
  });
  return {
    snapshot() {
      return {
        requests: requests.map((request) => ({ ...request })),
        // Finished totals include headers; incomplete/aborted transfers retain
        // their observed body bytes instead of falsely appearing free.
        observedBytes: requests.reduce(
          (total, request) => total + Math.max(request.encodedBytes ?? 0, request.receivedBytes),
          0,
        ),
      };
    },
    events() {
      return events;
    },
    assertHealthy() {
      if (failures.length) {
        throw new AggregateError(failures, "Service worker network emulation failed");
      }
    },
    async close() {
      closed = true;
      await cdp.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error("Service worker network emulation closed"));
      }
      pending.clear();
      await cdp.detach();
    },
  };
}
