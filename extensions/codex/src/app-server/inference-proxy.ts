import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { Writable, type Duplex } from "node:stream";
import { promisify } from "node:util";
import { zstdCompress, zstdDecompress } from "node:zlib";
import { createPermitPool } from "openclaw/plugin-sdk/concurrency-runtime";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";
import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";
import {
  fetchWithSsrFGuard,
  isBlockedHostnameOrIp,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  type RawData,
  rejectWebSocketUpgrade,
  WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { createCodexInferenceContext } from "./inference-context.js";
import {
  createUploadAdmission,
  createUploadBody,
  MAX_BODY_BYTES,
  MAX_PENDING_REQUESTS,
  MAX_UPLOADS,
} from "./inference-upload.js";
import { isJsonObject } from "./protocol.js";

const MAX_ERROR_BODY_BYTES = 1024 * 1024;
const MAX_WEBSOCKETS = 64;
// Preserve the former 64 WS + 16 HTTP envelope; uploads no longer own response slots.
const MAX_RESIDENTS = MAX_WEBSOCKETS + MAX_UPLOADS;
const REQUEST_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const IDLE_WEBSOCKET_MS = 60_000;
const OVERLOADED = "Codex inference relay is busy; retry on a fresh connection.";
const OVERLOAD_HEADERS = { "content-type": "application/json", "retry-after": "1" };
const OVERLOAD_BODY = JSON.stringify({
  type: "error",
  status: 503,
  // Native treats backend server_is_overloaded as terminal; local saturation must retry.
  error: { type: "server_error", code: "inference_relay_busy", message: OVERLOADED },
  headers: { "retry-after": "1" },
});
const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);
const FAILURE = "Codex parent-local inference transport failed; retry on a fresh connection.";

type ResidentTicket = {
  signal: AbortSignal;
  deadlineAtMs: number;
  pending: boolean;
  release: (() => void) | null;
  retiring: boolean;
};

/** Private, fixed-destination relay. No upstream credentials or model content are retained. */
export async function createCodexInferenceProxy(params: {
  upstream: URL;
  assertCurrent: () => void;
}) {
  const upstream = new URL(params.upstream);
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.hash) {
    throw new Error("Codex inference requires a credential-free HTTPS upstream URL");
  }
  const lifetime = new AbortController();
  const assertCurrent = () => {
    lifetime.signal.throwIfAborted();
    params.assertCurrent();
  };
  const context = createCodexInferenceContext(assertCurrent);
  // Keep the native backend suffix; Codex uses it to select Guardian/backend surfaces.
  const pathPrefix =
    "/" + generateSecureToken({ bytes: 32, redact: true }) + upstream.pathname.replace(/\/$/, "");
  const acquireUpload = createUploadAdmission();
  const connections = new Set<() => void>();
  const idleConnections = new Set<() => void>();
  const residents = createPermitPool(MAX_RESIDENTS);
  const tickets = new Set<ResidentTicket>();
  const reclaimIdle = () => {
    if (tickets.size < MAX_RESIDENTS || idleConnections.size === 0) {
      return;
    }
    let acquired = 0;
    let waiting = false;
    let retiring = false;
    // A logically closed connection still owns its ticket until transport cleanup settles.
    for (const ticket of tickets) {
      retiring ||= ticket.retiring;
      if (ticket.release) {
        acquired++;
      } else if (ticket.pending && !ticket.signal.aborted && Date.now() < ticket.deadlineAtMs) {
        waiting = true;
      }
    }
    if (!retiring && acquired === MAX_RESIDENTS && waiting) {
      idleConnections.values().next().value?.();
    }
  };
  const reserveResident = (socket: Duplex, signal: AbortSignal, deadlineAtMs: number) => {
    // Reserve synchronously: acquire() resolves even free grants asynchronously.
    // Cancelled waiters remain charged while their socket/owner is still closing.
    if (tickets.size >= MAX_RESIDENTS + MAX_PENDING_REQUESTS) {
      return null;
    }
    const ticket: ResidentTicket = {
      signal,
      deadlineAtMs,
      pending: true,
      release: null,
      retiring: false,
    };
    tickets.add(ticket);
    let finished = false;
    const settle = () => {
      if (!finished || !socket.closed || ticket.pending || !tickets.delete(ticket)) {
        return;
      }
      socket.off("close", settle);
      ticket.release?.();
      ticket.release = null;
      reclaimIdle();
    };
    socket.once("close", settle);
    const ready = residents.acquire({ signal, deadlineAtMs }).then((release) => {
      ticket.pending = false;
      if (release && signal.aborted) {
        release();
      } else {
        ticket.release = release;
      }
      settle();
      reclaimIdle();
      return ticket.release !== null;
    });
    reclaimIdle();
    return {
      ready,
      retireIdle() {
        ticket.retiring = true;
      },
      finish() {
        finished = true;
        settle();
      },
    };
  };
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BODY_BYTES,
    perMessageDeflate: false,
  });
  const handshakeHeaders = new WeakMap<IncomingMessage, Record<string, string>>();
  wss.on("headers", (headers, request) => {
    for (const [key, value] of Object.entries(handshakeHeaders.get(request) ?? {})) {
      if (!key.startsWith("sec-websocket-")) {
        headers.push(key + ": " + value);
      }
    }
    handshakeHeaders.delete(request);
  });
  const resolveTarget = (request: IncomingMessage) => {
    assertCurrent();
    if (
      request.headers.origin ||
      !request.url?.startsWith(pathPrefix + "/") ||
      isBlockedHostnameOrIp(upstream.hostname)
    ) {
      throw new Error(FAILURE);
    }
    // Raw prefix comparison authenticates the private route; URL normalization never broadens it.
    const suffix = request.url.slice(pathPrefix.length);
    if (
      suffix.startsWith("//") ||
      suffix.includes("\\") ||
      /%2e|%2f|%5c|(?:^|\/)\.\.?(?:\/|\?|$)/i.test(suffix)
    ) {
      throw new Error(FAILURE);
    }
    const target = new URL(upstream);
    const incoming = new URL(suffix, "http://localhost");
    target.pathname = upstream.pathname.replace(/\/$/, "") + incoming.pathname;
    for (const [key, value] of incoming.searchParams) {
      target.searchParams.append(key, value);
    }
    return { target, sampling: incoming.pathname === "/responses" };
  };
  const prepare = (bytes: Buffer, sampling: boolean) => {
    assertCurrent();
    if (!sampling) {
      return { bytes, assertCurrent, signal: undefined };
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isJsonObject(value)) {
      throw new Error(FAILURE);
    }
    const prepared = context.prepare(value);
    const rewritten = Buffer.from(JSON.stringify(prepared.body));
    if (rewritten.length > MAX_BODY_BYTES) {
      throw new Error(FAILURE);
    }
    return { bytes: rewritten, assertCurrent: prepared.assertCurrent, signal: prepared.signal };
  };
  const prepareHttp = async (
    req: IncomingMessage,
    sampling: boolean,
    signal: AbortSignal,
    release: () => void,
  ) => {
    const wire = await readProxyBody(req, MAX_BODY_BYTES);
    const encoding = req.headers["content-encoding"];
    if (encoding && encoding !== "identity" && encoding !== "zstd") {
      throw new Error(FAILURE);
    }
    const decoded =
      encoding === "zstd" ? await decompress(wire, { maxOutputLength: MAX_BODY_BYTES }) : wire;
    signal.throwIfAborted();
    const prepared = prepare(decoded, sampling);
    const body = encoding === "zstd" ? await compress(prepared.bytes) : prepared.bytes;
    prepared.assertCurrent();
    const requestSignal = AbortSignal.any([signal, ...(prepared.signal ? [prepared.signal] : [])]);
    return {
      ...createUploadBody(body, requestSignal, release),
      assertCurrent: prepared.assertCurrent,
      signal: requestSignal,
    };
  };
  const server = createServer((req, res) => {
    const socket = req.socket;
    // Native creates a fresh HTTP transport per inference. Closing this response
    // avoids retaining uncharged keepalive sockets after resident admission ends.
    res.setHeader("Connection", "close");
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    const deadlineAtMs = Date.now() + REQUEST_TIMEOUT_MS;
    let releasePermit: (() => void) | null = null;
    let resident: ReturnType<typeof reserveResident> = null;
    let upload: Awaited<ReturnType<typeof prepareHttp>> | undefined;
    let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    void (async () => {
      try {
        const { target, sampling } = resolveTarget(req);
        if (req.method !== "POST") {
          throw new Error(FAILURE);
        }
        resident = reserveResident(socket, signal, deadlineAtMs);
        const admitted = resident && (await resident.ready);
        signal.throwIfAborted();
        assertCurrent();
        if (!admitted) {
          res.writeHead(503, OVERLOAD_HEADERS).end(OVERLOAD_BODY);
          return;
        }
        releasePermit = await acquireUpload(signal, deadlineAtMs);
        signal.throwIfAborted();
        assertCurrent();
        if (!releasePermit) {
          res.writeHead(503, OVERLOAD_HEADERS).end(OVERLOAD_BODY);
          return;
        }
        upload = await prepareHttp(req, sampling, signal, releasePermit);
        const init: RequestInit & { duplex: "half" } = {
          method: "POST",
          headers: { ...relayHeaders(req.headers), "content-length": String(upload.length) },
          body: upload.body,
          signal: upload.signal,
          duplex: "half",
        };
        guarded = await fetchWithSsrFGuard({
          url: target.toString(),
          init,
          signal: upload.signal,
          beforeRequest: upload.assertCurrent,
          requireHttps: true,
          maxRedirects: 0,
          capture: false,
          mode: "trusted_env_proxy",
          auditContext: "codex-parent-local-inference",
        });
        upload.assertCurrent();
        // fetch decodes response content encodings. Never forward stale encoding/length headers.
        const headers = Object.fromEntries(guarded.response.headers);
        delete headers["content-encoding"];
        res.writeHead(guarded.response.status, relayHeaders(headers));
        if (!guarded.response.body) {
          res.end();
        } else {
          await guarded.response.body.pipeTo(Writable.toWeb(res), { signal: upload.signal });
        }
      } catch {
        // Errors can contain headers, bodies, or the private URL: never log/reflect them.
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(502, { "content-type": "text/plain" }).end(FAILURE);
        } else {
          res.destroy();
        }
      } finally {
        upload?.settle();
        releasePermit?.();
        req.off("aborted", abort);
        res.off("close", abort);
        await guarded?.release().catch(() => undefined);
        resident?.finish();
      }
    })();
  });
  // Leave HTTP/failure-response headroom beyond the separately bounded WS pool.
  // This last-resort TCP ceiling must not be the normal inference admission limit.
  server.maxConnections = MAX_WEBSOCKETS + MAX_UPLOADS * 4;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HANDSHAKE_TIMEOUT_MS;
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      let remote: WebSocket | undefined;
      let local: WebSocket | undefined;
      let proxyAgent: ReturnType<typeof createNodeProxyAgent>;
      let upstreamClosed = Promise.resolve();
      let finishSetup = () => {};
      const setupSettled = new Promise<void>((resolve) => {
        finishSetup = resolve;
      });
      let resident: ReturnType<typeof reserveResident> = null;
      const controller = new AbortController();
      const deadlineAtMs = Date.now() + HANDSHAKE_TIMEOUT_MS;
      let releasePermit: (() => void) | null = null;
      let framePending = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      let closing = false;
      const close = () => {
        if (closing) {
          return;
        }
        closing = true;
        if (idleConnections.has(close)) {
          resident?.retireIdle();
        }
        clearTimeout(idleTimer);
        clearTimeout(handshakeTimer);
        socket.off("end", close);
        connections.delete(close);
        idleConnections.delete(close);
        controller.abort();
        remote?.terminate();
        local?.terminate();
        proxyAgent?.destroy();
        socket.destroy();
        // ws can emit close before a CONNECTING request's socket actually closes.
        // Keep residency until the public request/socket teardown has settled too.
        void setupSettled
          .then(() => upstreamClosed)
          .then(() => {
            releasePermit?.();
            releasePermit = null;
            resident?.finish();
          });
      };
      try {
        const { target, sampling } = resolveTarget(req);
        if (!sampling) {
          throw new Error(FAILURE);
        }
        if (connections.size >= MAX_WEBSOCKETS) {
          // Prefer reclaiming the oldest proven-idle transport to rejecting new work.
          idleConnections.values().next().value?.();
        }
        if (connections.size >= MAX_WEBSOCKETS) {
          rejectBusyUpgrade(socket);
          return;
        }
        connections.add(close);
        socket.once("close", close);
        socket.once("error", close);
        // Raw HTTP upgrades stay half-open after FIN until ws owns the socket.
        // Cancel pending admission before it can dial for a disconnected caller.
        socket.once("end", close);
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        resident = reserveResident(socket, signal, deadlineAtMs);
        const admitted = resident && (await resident.ready);
        signal.throwIfAborted();
        assertCurrent();
        if (!admitted) {
          rejectBusyUpgrade(socket);
          return;
        }
        // Admission precedes the upstream dial. Complete the real upstream handshake
        // before local 101 so native auth errors and negotiated headers stay intact.
        releasePermit = await acquireUpload(signal, deadlineAtMs);
        signal.throwIfAborted();
        assertCurrent();
        if (!releasePermit) {
          rejectBusyUpgrade(socket);
          return;
        }
        // Queueing, DNS and the remote handshake share one native-compatible deadline.
        handshakeTimer = setTimeout(close, Math.max(1, deadlineAtMs - Date.now()));
        handshakeTimer.unref();
        const assertHandshakeCurrent = () => {
          assertCurrent();
          signal.throwIfAborted();
          if (Date.now() >= deadlineAtMs) {
            throw new Error(FAILURE);
          }
        };
        // Trusted proxies own destination DNS; direct connections retain DNS pinning.
        proxyAgent = createNodeProxyAgent({ mode: "env", targetUrl: target.href });
        const lookup = proxyAgent
          ? undefined
          : (await resolvePinnedHostnameWithPolicy(target.hostname, { signal })).lookup;
        assertHandshakeCurrent();
        target.protocol = "wss:";
        const headers = relayHeaders(req.headers);
        for (const key of Object.keys(headers)) {
          if (key.startsWith("sec-websocket-")) {
            delete headers[key];
          }
        }
        remote = new WebSocket(target, {
          headers,
          ...(proxyAgent ? { agent: proxyAgent } : { lookup }),
          followRedirects: false,
          perMessageDeflate: false,
          maxPayload: MAX_BODY_BYTES,
          handshakeTimeout: Math.max(1, deadlineAtMs - Date.now()),
          finishRequest(request) {
            let socketClosed = Promise.resolve();
            request.once("socket", (upstreamSocket) => {
              socketClosed = new Promise<void>((resolve) => {
                upstreamSocket.once("close", () => resolve());
              });
            });
            upstreamClosed = new Promise<void>((resolve) => {
              request.once("close", () => {
                void socketClosed.then(resolve);
              });
            });
            // finishRequest replaces ws's default end(), including proxy-agent requests.
            request.end();
          },
        });
        remote.once("upgrade", (response) => {
          handshakeHeaders.set(req, relayHeaders(response.headers));
        });
        remote.once("error", close);
        remote.once("close", close);
        // Native auth/retry classification consumes the complete HTTP failure, not only status.
        remote.once("unexpected-response", (_request, response) => {
          void (async () => {
            try {
              const body = await readProxyBody(response, MAX_ERROR_BODY_BYTES);
              assertCurrent();
              signal.throwIfAborted();
              const failureHeaders = Object.entries(relayHeaders(response.headers)).map(
                ([key, value]) => key + ": " + value,
              );
              failureHeaders.push("Connection: close", "Content-Length: " + body.length);
              const status =
                "HTTP/1.1 " +
                response.statusCode +
                " " +
                (response.statusMessage ?? "Upstream refused");
              socket.end(
                Buffer.concat([
                  Buffer.from(status + "\r\n" + failureHeaders.join("\r\n") + "\r\n\r\n"),
                  body,
                ]),
                close,
              );
            } catch {
              close();
            }
          })();
        });
        remote.once("open", () => {
          try {
            assertHandshakeCurrent();
            wss.handleUpgrade(req, socket, head, (accepted) => {
              clearTimeout(handshakeTimer);
              socket.off("end", close);
              local = accepted;
              accepted.once("error", close);
              accepted.once("close", close);
              let releaseFrame = () => {};
              const idle = (reclaimable = true) => {
                framePending = false;
                idleConnections.delete(close);
                if (reclaimable) {
                  idleConnections.add(close);
                }
                clearTimeout(idleTimer);
                idleTimer = setTimeout(close, IDLE_WEBSOCKET_MS);
                idleTimer.unref();
                reclaimIdle();
              };
              releasePermit?.();
              releasePermit = null;
              // A fresh 101 still awaits native's first frame. Pressure may reclaim
              // cached completed responses, not the handshake it just admitted.
              idle(false);
              const forward = async (prepared: ReturnType<typeof prepare>) => {
                let releaseUpload: (() => void) | null = null;
                try {
                  const requestSignal = AbortSignal.any([
                    signal,
                    ...(prepared.signal ? [prepared.signal] : []),
                  ]);
                  releaseUpload = await acquireUpload(
                    requestSignal,
                    Date.now() + REQUEST_TIMEOUT_MS,
                    prepared.bytes.length,
                  );
                  requestSignal.throwIfAborted();
                  prepared.assertCurrent();
                  if (!releaseUpload) {
                    accepted.send(OVERLOAD_BODY, { binary: false }, close);
                    return;
                  }
                  if (
                    !remote ||
                    remote.readyState !== WebSocket.OPEN ||
                    remote.bufferedAmount + prepared.bytes.length > MAX_BODY_BYTES
                  ) {
                    throw new Error(FAILURE);
                  }
                  const release = releaseUpload;
                  remote.send(prepared.bytes, { binary: false }, (error) => {
                    // Capture this frame's lease: terminal delivery can allow the next
                    // frame before an earlier send callback runs.
                    release();
                    if (error) {
                      close();
                    }
                  });
                } catch {
                  releaseUpload?.();
                  close();
                }
              };
              accepted.on("message", (data, binary) => {
                try {
                  if (binary) {
                    throw new Error(FAILURE);
                  }
                  const prepared = prepare(rawBytes(data), true);
                  prepared.assertCurrent();
                  // Native serializes response.create calls on a reusable connection.
                  if (framePending) {
                    throw new Error(FAILURE);
                  }
                  framePending = true;
                  clearTimeout(idleTimer);
                  idleConnections.delete(close);
                  // A WS may serve later turns. Replace the old generation's abort listener.
                  releaseFrame();
                  const onAbort = () => close();
                  const frameSignal = prepared.signal;
                  frameSignal?.addEventListener("abort", onAbort, { once: true });
                  releaseFrame = () => frameSignal?.removeEventListener("abort", onAbort);
                  void forward(prepared);
                } catch {
                  close();
                }
              });
              accepted.once("close", () => releaseFrame());
              remote!.on("message", (data: RawData, binary: boolean) => {
                if (
                  accepted.readyState !== WebSocket.OPEN ||
                  accepted.bufferedAmount + rawBytes(data).length > MAX_BODY_BYTES
                ) {
                  close();
                  return;
                }
                // Upload completion does not prove response quiescence. Only a
                // delivered terminal event makes this retained transport reclaimable.
                const terminal = !binary && isTerminalResponse(rawBytes(data));
                accepted.send(data, { binary }, (error) => {
                  if (error) {
                    close();
                  } else if (terminal && connections.has(close)) {
                    // Do not evict a transport while its final frame is still buffered.
                    idle();
                  }
                });
              });
            });
          } catch {
            close();
          }
        });
      } catch {
        close();
      } finally {
        finishSetup();
      }
    })();
  });
  const close = () => {
    lifetime.abort();
    context.close();
    for (const closeConnection of connections) {
      closeConnection();
    }
    server.close();
    server.closeAllConnections();
    wss.close();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    assertCurrent();
    server.on("error", close);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error(FAILURE);
    }
    return {
      context,
      upstream: upstream.toString(),
      baseUrl: "http://127.0.0.1:" + address.port + pathPrefix,
      assertCurrent,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

function rejectBusyUpgrade(socket: Duplex) {
  rejectWebSocketUpgrade(socket, {
    status: 503,
    headers: { "Retry-After": "1" },
    body: { contentType: "application/json", text: OVERLOAD_BODY },
  });
}

function isTerminalResponse(bytes: Buffer): boolean {
  try {
    const event: unknown = JSON.parse(bytes.toString("utf8"));
    return (
      isJsonObject(event) &&
      (event.type === "response.failed" ||
        event.type === "response.incomplete" ||
        (event.type === "response.completed" &&
          isJsonObject(event.response) &&
          typeof event.response.id === "string"))
    );
  } catch {
    return false;
  }
}

async function readProxyBody(stream: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      throw new Error(FAILURE);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function rawBytes(data: RawData): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
}

function relayHeaders(input: IncomingHttpHeaders): Record<string, string> {
  const excluded = new Set(HOP_HEADERS);
  for (const token of (input.connection ?? "").split(",")) {
    excluded.add(token.trim().toLowerCase());
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && !excluded.has(key.toLowerCase())) {
      output[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return output;
}

export type CodexInferenceProxy = Awaited<ReturnType<typeof createCodexInferenceProxy>>;
