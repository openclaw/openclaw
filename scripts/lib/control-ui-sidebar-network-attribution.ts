import type { CDPSession } from "playwright";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

type RequestTiming = {
  requestTime: number;
  proxyStart: number;
  proxyEnd: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  sslStart: number;
  sslEnd: number;
  sendStart: number;
  sendEnd: number;
  receiveHeadersStart: number;
  receiveHeadersEnd: number;
};

type Request = {
  requestId: string;
  url: string;
  origin: string;
  type: string;
  image: boolean;
  requestedAt: number;
  responseAt?: number;
  finishedAt?: number;
  status?: number;
  networkStatus?: number;
  cacheControl?: string;
  etag?: string;
  protocol?: string;
  connectionId?: number;
  connectionReused?: boolean;
  fromDiskCache?: boolean;
  fromServiceWorker?: boolean;
  serviceWorkerResponseSource?: string;
  fromPrefetchCache?: boolean;
  servedFromCache?: boolean;
  encodedBytes?: number;
  error?: string;
  timing?: RequestTiming;
};

type Socket = {
  requestId: string;
  url: string;
  handshakeSentAt?: number;
  handshakeResponseAt?: number;
  handshakeStatus?: number;
  connectSentAt?: number;
  helloReceivedAt?: number;
  connectId?: string;
  frames: { direction: "sent" | "received"; at: number; bytes: number }[];
};

type NetworkEvent =
  | "Network.requestWillBeSent"
  | "Network.requestServedFromCache"
  | "Network.responseReceived"
  | "Network.responseReceivedExtraInfo"
  | "Network.loadingFinished"
  | "Network.loadingFailed"
  | "Network.webSocketCreated"
  | "Network.webSocketWillSendHandshakeRequest"
  | "Network.webSocketHandshakeResponseReceived"
  | "Network.webSocketFrameSent"
  | "Network.webSocketFrameReceived";

const selectedHeaders = (headers: Record<string, string>) => {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return { cacheControl: normalized.get("cache-control"), etag: normalized.get("etag") };
};

function cacheSource(request: Request) {
  if (request.networkStatus === 304) return "revalidated";
  if (request.fromServiceWorker) return "service-worker";
  if (request.fromPrefetchCache) return "prefetch";
  if (request.fromDiskCache) return "disk";
  if (request.servedFromCache) return "memory-inferred";
  if (request.networkStatus !== undefined || (request.encodedBytes ?? 0) > 0) return "network";
  return "unresolved";
}

/** Attribution only; shares the caller's existing CDP session without changing cache policy. */
export async function attachSidebarNetworkAttribution(session: CDPSession) {
  const { frameTree } = await session.send("Page.getFrameTree");
  const requests: Request[] = [];
  const active = new Map<string, Request>();
  const sockets = new Map<string, Socket>();
  let documentStart: number | undefined;
  let documentWallTime: number | undefined;
  const cleanup: (() => void)[] = [];
  const on = <Event extends NetworkEvent>(
    event: Event,
    listener: Parameters<typeof session.on<Event>>[1],
  ) => {
    session.on(event, listener);
    cleanup.push(() => {
      session.off(event, listener);
    });
  };
  on("Network.requestWillBeSent", (event) => {
    const url = URL.parse(event.request.url);
    if (!url) return;
    if (
      event.type === "Document" &&
      event.frameId === frameTree.frame.id &&
      documentStart === undefined
    ) {
      documentStart = event.timestamp;
      documentWallTime = event.wallTime;
    }
    const request: Request = {
      requestId: event.requestId,
      url: event.request.url,
      origin: url.origin,
      type: event.type ?? "Other",
      image: event.type === "Image" || /(?:^|\/)(?:avatar|avatars)(?:\/|$)/u.test(url.pathname),
      requestedAt: event.timestamp,
    };
    // Redirect hops reuse an ID; retain the completed hop before replacing its active slot.
    const previous = active.get(event.requestId);
    if (previous && event.redirectResponse) {
      previous.finishedAt = event.timestamp;
      previous.status = event.redirectResponse.status;
      Object.assign(previous, selectedHeaders(event.redirectResponse.headers));
    }
    active.set(event.requestId, request);
    requests.push(request);
  });
  on("Network.requestServedFromCache", ({ requestId }) => {
    const request = active.get(requestId);
    if (request) request.servedFromCache = true;
  });
  on("Network.responseReceived", ({ requestId, timestamp, response }) => {
    const request = active.get(requestId);
    if (!request) return;
    Object.assign(request, selectedHeaders(response.headers), {
      responseAt: timestamp,
      status: response.status,
      protocol: response.protocol,
      connectionId: response.connectionId,
      connectionReused: response.connectionReused,
      fromDiskCache: response.fromDiskCache,
      fromServiceWorker: response.fromServiceWorker,
      serviceWorkerResponseSource: response.serviceWorkerResponseSource,
      fromPrefetchCache: response.fromPrefetchCache,
      timing: response.timing,
    });
  });
  on("Network.responseReceivedExtraInfo", ({ requestId, statusCode, headers }) => {
    const request = active.get(requestId);
    if (!request) return;
    request.networkStatus = statusCode;
    const selected = selectedHeaders(headers);
    if (selected.cacheControl !== undefined) request.cacheControl = selected.cacheControl;
    if (selected.etag !== undefined) request.etag = selected.etag;
  });
  on("Network.loadingFinished", ({ requestId, timestamp, encodedDataLength }) => {
    const request = active.get(requestId);
    if (request) Object.assign(request, { finishedAt: timestamp, encodedBytes: encodedDataLength });
  });
  on("Network.loadingFailed", ({ requestId, timestamp, errorText }) => {
    const request = active.get(requestId);
    if (request) Object.assign(request, { finishedAt: timestamp, error: errorText });
  });
  on("Network.webSocketCreated", ({ requestId, url }) => {
    sockets.set(requestId, { requestId, url, frames: [] });
  });
  on("Network.webSocketWillSendHandshakeRequest", ({ requestId, timestamp }) => {
    const socket = sockets.get(requestId);
    if (socket) socket.handshakeSentAt = timestamp;
  });
  on("Network.webSocketHandshakeResponseReceived", ({ requestId, timestamp, response }) => {
    const socket = sockets.get(requestId);
    if (socket)
      Object.assign(socket, { handshakeResponseAt: timestamp, handshakeStatus: response.status });
  });
  const frame = (
    requestId: string,
    at: number,
    opcode: number,
    payload: string,
    direction: "sent" | "received",
  ) => {
    const socket = sockets.get(requestId);
    if (!socket) return;
    socket.frames.push({
      direction,
      at,
      bytes: Buffer.byteLength(payload, opcode === 1 ? "utf8" : "base64"),
    });
    if (opcode !== 1) return;
    let message: unknown;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (direction === "sent" && message.method === "connect" && typeof message.id === "string") {
      socket.connectId = message.id;
      socket.connectSentAt = at;
    } else if (
      direction === "received" &&
      message.id === socket.connectId &&
      message.type === "res" &&
      message.ok === true &&
      isRecord(message.payload) &&
      message.payload.type === "hello-ok"
    ) {
      socket.helloReceivedAt = at;
    }
  };
  on("Network.webSocketFrameSent", ({ requestId, timestamp, response }) => {
    frame(requestId, timestamp, response.opcode, response.payloadData, "sent");
  });
  on("Network.webSocketFrameReceived", ({ requestId, timestamp, response }) => {
    frame(requestId, timestamp, response.opcode, response.payloadData, "received");
  });
  await session.send("Network.enable");
  return {
    dispose() {
      cleanup.splice(0).forEach((stop) => stop());
    },
    read(boundaries: {
      helloHandledMs: number | null;
      finalRowsMs: number | null;
      timeOriginMs?: number;
      navigationStartSeconds?: number;
    }) {
      // The document event pairs monotonic seconds with Unix seconds. performance.timeOrigin
      // is Unix milliseconds, so it must cross that pair before subtracting CDP timestamps.
      const origin =
        boundaries.navigationStartSeconds ??
        (boundaries.timeOriginMs !== undefined &&
        documentStart !== undefined &&
        documentWallTime !== undefined
          ? documentStart + boundaries.timeOriginMs / 1000 - documentWallTime
          : documentStart);
      if (origin === undefined)
        throw new Error("Network attribution did not observe navigation start");
      const relative = (timestamp: number | undefined) =>
        timestamp === undefined ? null : (timestamp - origin) * 1000;
      const rows = requests.map((request) => ({
        ...request,
        requestedAt: relative(request.requestedAt)!,
        responseAt: relative(request.responseAt),
        finishedAt: relative(request.finishedAt),
        cacheSource: cacheSource(request),
        sendDelayMs:
          request.timing && request.timing.sendStart >= 0
            ? (request.timing.requestTime - request.requestedAt) * 1000 + request.timing.sendStart
            : null,
        timing: request.timing && {
          ...request.timing,
          requestTime: relative(request.timing.requestTime),
        },
      }));
      const before = (boundary: number | null) => {
        const images =
          boundary === null
            ? []
            : rows.filter(
                (request) =>
                  request.image && request.requestedAt >= 0 && request.requestedAt < boundary,
              );
        return {
          boundaryMs: boundary,
          requests: images.length,
          byCacheSource: Object.fromEntries(
            [...new Set(images.map((request) => request.cacheSource))].map((source) => [
              source,
              images.filter((request) => request.cacheSource === source).length,
            ]),
          ),
        };
      };
      return {
        navigationStartSeconds: origin,
        normalization:
          boundaries.navigationStartSeconds !== undefined
            ? "explicit-navigation-start"
            : boundaries.timeOriginMs !== undefined
              ? "performance-time-origin-via-document-clock-pair"
              : "document-request-start",
        imagesBeforeHelloHandled: before(boundaries.helloHandledMs),
        imagesBeforeFinalRows: before(boundaries.finalRowsMs),
        requests: rows,
        sockets: [...sockets.values()].map(({ connectId: _connectId, ...socket }) => ({
          ...socket,
          handshakeSentAt: relative(socket.handshakeSentAt),
          handshakeResponseAt: relative(socket.handshakeResponseAt),
          connectSentAt: relative(socket.connectSentAt),
          helloReceivedAt: relative(socket.helloReceivedAt),
          frames: socket.frames.map((item) => ({ ...item, at: relative(item.at) })),
        })),
        limitations: [
          "memory-inferred means requestServedFromCache without disk, prefetch, or service-worker flags; CDP does not prove a memory tier",
          "service-worker responses do not expose worker-internal requests or their upstream cache tier",
          "sendDelayMs includes browser scheduling and connection setup, not an isolated socket-queue duration",
          "helloReceivedAt is the connect response receipt, not the application hello-handled milestone",
        ],
      };
    },
  };
}
