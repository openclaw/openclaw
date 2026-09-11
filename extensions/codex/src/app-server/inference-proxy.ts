import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { zstdCompress, zstdDecompress } from "node:zlib";
import { createNodeProxyAgent } from "openclaw/plugin-sdk/fetch-runtime";
import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";
import {
  fetchWithSsrFGuard,
  isBlockedHostnameOrIp,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { createCodexInferenceContext } from "./inference-context.js";
import { isJsonObject } from "./protocol.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 16;
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
  const active = new Set<AbortController>();
  const sockets = new Set<WebSocket>();
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
    return { ...prepared, bytes: rewritten };
  };
  const server = createServer((req, res) => {
    const controller = new AbortController();
    let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    void (async () => {
      try {
        const { target, sampling } = resolveTarget(req);
        if (req.method !== "POST" || active.size >= MAX_CONNECTIONS) {
          throw new Error(FAILURE);
        }
        active.add(controller);
        const wire = await readProxyBody(req, MAX_BODY_BYTES);
        const encoding = req.headers["content-encoding"];
        if (encoding && encoding !== "identity" && encoding !== "zstd") {
          throw new Error(FAILURE);
        }
        const decoded =
          encoding === "zstd" ? await decompress(wire, { maxOutputLength: MAX_BODY_BYTES }) : wire;
        assertCurrent();
        const prepared = prepare(decoded, sampling);
        // Materialize ArrayBuffer-backed bytes for the web Fetch body contract.
        const body = Buffer.from(
          encoding === "zstd" ? await compress(prepared.bytes) : prepared.bytes,
        );
        prepared.assertCurrent();
        const signal = AbortSignal.any([
          lifetime.signal,
          controller.signal,
          ...(prepared.signal ? [prepared.signal] : []),
        ]);
        guarded = await fetchWithSsrFGuard({
          url: target.toString(),
          init: { method: "POST", headers: relayHeaders(req.headers), body, signal },
          signal,
          beforeRequest: prepared.assertCurrent,
          requireHttps: true,
          maxRedirects: 0,
          capture: false,
          mode: "trusted_env_proxy",
          auditContext: "codex-parent-local-inference",
        });
        prepared.assertCurrent();
        // fetch decodes response content encodings. Never forward stale encoding/length headers.
        const headers = Object.fromEntries(guarded.response.headers);
        delete headers["content-encoding"];
        res.writeHead(guarded.response.status, relayHeaders(headers));
        if (!guarded.response.body) {
          res.end();
        } else {
          await guarded.response.body.pipeTo(Writable.toWeb(res), { signal });
        }
      } catch {
        // Errors can contain headers, bodies, or the private URL: never log/reflect them.
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(502, { "content-type": "text/plain" }).end(FAILURE);
        } else {
          res.destroy();
        }
      } finally {
        active.delete(controller);
        req.off("aborted", abort);
        res.off("close", abort);
        await guarded?.release().catch(() => undefined);
      }
    })();
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      let remote: WebSocket | undefined;
      let local: WebSocket | undefined;
      let proxyAgent: ReturnType<typeof createNodeProxyAgent>;
      const controller = new AbortController();
      const close = () => {
        controller.abort();
        active.delete(controller);
        remote?.terminate();
        local?.terminate();
        proxyAgent?.destroy();
        if (remote) {
          sockets.delete(remote);
        }
        if (local) {
          sockets.delete(local);
        }
        socket.destroy();
      };
      try {
        const { target, sampling } = resolveTarget(req);
        if (!sampling || active.size >= MAX_CONNECTIONS) {
          throw new Error(FAILURE);
        }
        active.add(controller);
        socket.once("close", close);
        socket.once("error", close);
        const signal = AbortSignal.any([lifetime.signal, controller.signal]);
        // Trusted proxies own destination DNS; direct connections retain DNS pinning.
        proxyAgent = createNodeProxyAgent({ mode: "env", targetUrl: target.href });
        const lookup = proxyAgent
          ? undefined
          : (await resolvePinnedHostnameWithPolicy(target.hostname, { signal })).lookup;
        assertCurrent();
        signal.throwIfAborted();
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
          handshakeTimeout: 10_000,
        });
        sockets.add(remote);
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
            assertCurrent();
            signal.throwIfAborted();
            wss.handleUpgrade(req, socket, head, (accepted) => {
              local = accepted;
              sockets.add(accepted);
              accepted.once("error", close);
              accepted.once("close", close);
              let releaseFrame = () => {};
              accepted.on("message", (data, binary) => {
                try {
                  if (binary) {
                    throw new Error(FAILURE);
                  }
                  const prepared = prepare(rawBytes(data), true);
                  prepared.assertCurrent();
                  // A WS may serve later turns. Replace the old generation's abort listener.
                  releaseFrame();
                  const onAbort = () => close();
                  prepared.signal?.addEventListener("abort", onAbort, { once: true });
                  releaseFrame = () => prepared.signal?.removeEventListener("abort", onAbort);
                  if (
                    !remote ||
                    remote.readyState !== WebSocket.OPEN ||
                    remote.bufferedAmount + prepared.bytes.length > MAX_BODY_BYTES
                  ) {
                    throw new Error(FAILURE);
                  }
                  remote.send(prepared.bytes, { binary: false }, (error) => {
                    if (error) {
                      close();
                    }
                  });
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
                accepted.send(data, { binary }, (error) => {
                  if (error) {
                    close();
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
      }
    })();
  });
  const close = () => {
    lifetime.abort();
    context.close();
    for (const controller of active) {
      controller.abort();
    }
    for (const socket of sockets) {
      socket.terminate();
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
