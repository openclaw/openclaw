#!/usr/bin/env node

import http from "node:http";
import { Readable } from "node:stream";

// grammY supports client.environment="test", but OpenClaw does not expose it
// through Telegram config. Keep this adapter until that runtime seam exists.

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function telegramTestApiPath(pathname) {
  const match = pathname.match(/^((?:\/file)?\/bot[^/]+)(\/.*)$/u);
  if (!match) throw new Error("Telegram Test Server proxy received an invalid Bot API path.");
  return `${match[1]}/test${match[2]}`;
}

function requestHeaders(headers) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && key !== "host" && !HOP_BY_HOP_HEADERS.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function responseHeaders(headers) {
  const filtered = {};
  for (const [key, value] of headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key) && key !== "content-encoding" && key !== "content-length") {
      filtered[key] = value;
    }
  }
  return filtered;
}

function telegramApiMethod(pathname) {
  return pathname.match(/^\/bot[^/]+\/([^/?]+)/u)?.[1];
}

async function drainTelegramTestUpdates(apiRoot, token) {
  let offset = 0;
  for (;;) {
    const response = await fetch(`${apiRoot}/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset, timeout: 0, allowed_updates: ["message", "edited_message"] }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true || !Array.isArray(payload.result)) {
      throw new Error("Telegram Test Bot API getUpdates failed while draining stale updates.");
    }
    if (payload.result.length === 0) return;
    const updateId = payload.result.at(-1)?.update_id;
    if (!Number.isSafeInteger(updateId)) {
      throw new Error("Telegram Test Bot API getUpdates returned an invalid update.");
    }
    offset = updateId + 1;
  }
}

export async function startTelegramTestApiProxy({
  host = "127.0.0.1",
  port = 0,
  upstream = "https://api.telegram.org",
  fetchImpl = fetch,
  leaseHealth,
} = {}) {
  let responseHold;
  let requestRejection;
  let heldResponse;
  let leaseError;
  const upstreamControllers = new Set();
  const holdEvents = [];
  const rejectionEvents = [];
  const methodOrdinals = new Map();
  const heldWaiters = new Set();
  const sockets = new Set();
  const requests = new Set();
  let closing;

  const assertLeaseHealthy = () => {
    if (leaseError) throw leaseError;
    leaseHealth?.assertHealthy();
  };

  const stop = (error) => {
    leaseError ??= error;
    responseHold = undefined;
    requestRejection = undefined;
    heldResponse?.release.resolve();
    for (const waiter of heldWaiters) waiter.reject(error);
    for (const controller of upstreamControllers) controller.abort(error);
    for (const socket of sockets) socket.destroy();
  };
  leaseHealth?.whenUnhealthy.then(stop);

  const claimResponseHold = (method, ordinal) => {
    if (!responseHold || responseHold.method !== method) return undefined;
    if (responseHold.skip > 0) {
      responseHold.skip -= 1;
      return undefined;
    }
    const event = { method, ordinal, upstreamAcceptedAt: Date.now(), heldAt: Date.now() };
    const release = Promise.withResolvers();
    heldResponse = { event, release };
    responseHold = undefined;
    holdEvents.push(event);
    for (const waiter of heldWaiters) {
      if (waiter.method === method) waiter.resolve(event);
    }
    return release.promise;
  };

  const server = http.createServer((request, response) => {
    const work = handleRequest(request, response);
    requests.add(work);
    work.then(
      () => requests.delete(work),
      () => requests.delete(work),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  async function handleRequest(request, response) {
    const upstreamController = new AbortController();
    upstreamControllers.add(upstreamController);
    const abortUpstream = () => upstreamController.abort();
    request.once("aborted", abortUpstream);
    response.once("close", abortUpstream);
    try {
      assertLeaseHealthy();
      const incoming = new URL(request.url || "/", `http://${host}`);
      const upstreamUrl = new URL(upstream);
      upstreamUrl.pathname = telegramTestApiPath(incoming.pathname);
      upstreamUrl.search = incoming.search;
      const method = telegramApiMethod(incoming.pathname);
      const ordinal = (methodOrdinals.get(method) ?? 0) + 1;
      methodOrdinals.set(method, ordinal);
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      let body = hasBody ? request : undefined;
      const rejection = requestRejection;
      if (rejection && rejection.method === method) {
        if (rejection.bodyIncludes !== undefined && hasBody) {
          const chunks = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          body = Buffer.concat(chunks);
        }
        const matches =
          requestRejection === rejection &&
          (rejection.bodyIncludes === undefined ||
            (Buffer.isBuffer(body) && body.includes(rejection.bodyIncludes)));
        if (matches && rejection.skip > 0) {
          rejection.skip -= 1;
        } else if (matches) {
          assertLeaseHealthy();
          requestRejection = undefined;
          rejectionEvents.push({
            method,
            ordinal,
            rejectedAt: Date.now(),
            upstreamForwarded: false,
            errorCode: 400,
          });
          request.resume();
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: synthetic Telegram E2E rejection",
            }),
          );
          return;
        }
      }
      const result = await fetchImpl(upstreamUrl, {
        method: request.method,
        headers: requestHeaders(request.headers),
        ...(hasBody ? { body, duplex: "half" } : {}),
        signal: upstreamController.signal,
      });
      assertLeaseHealthy();
      const hold = method ? claimResponseHold(method, ordinal) : undefined;
      if (hold) {
        const body = result.body ? Buffer.from(await result.arrayBuffer()) : undefined;
        response.writeHead(result.status, responseHeaders(result.headers));
        response.write(" ");
        const heartbeat = setInterval(() => response.write(" "), 30_000);
        heartbeat.unref?.();
        response.once("close", () => {
          if (heldResponse && !heldResponse.event.releasedAt) {
            heldResponse.event.clientClosedAt = Date.now();
          }
        });
        try {
          await hold;
        } finally {
          clearInterval(heartbeat);
        }
        assertLeaseHealthy();
        heldResponse.event.releasedAt = Date.now();
        heldResponse = undefined;
        response.end(body);
        return;
      }
      assertLeaseHealthy();
      response.writeHead(result.status, responseHeaders(result.headers));
      if (!result.body) {
        response.end();
        return;
      }
      await new Promise((resolve, reject) => {
        const readable = Readable.fromWeb(result.body);
        const cleanup = () => {
          readable.off("error", failed);
          response.off("finish", finished);
          response.off("close", finished);
        };
        const failed = (error) => {
          cleanup();
          reject(error);
        };
        const finished = () => {
          cleanup();
          resolve();
        };
        readable.once("error", failed);
        response.once("finish", finished);
        response.once("close", finished);
        readable.pipe(response);
      });
    } catch {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      response.end(
        JSON.stringify({ ok: false, description: "Telegram Test Server proxy failed." }),
      );
    } finally {
      request.off("aborted", abortUpstream);
      response.off("close", abortUpstream);
      upstreamControllers.delete(upstreamController);
    }
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Telegram Test Server proxy did not bind a TCP port.");
  }
  const apiRoot = `http://${host}:${address.port}`;
  return {
    apiRoot,
    drainUpdates: (token) => drainTelegramTestUpdates(apiRoot, token),
    rejectNextRequest({ method, skip = 0, bodyIncludes }) {
      assertLeaseHealthy();
      if (requestRejection) throw new Error("A Telegram API request rejection is active.");
      requestRejection = { method, skip, bodyIncludes };
    },
    holdNextResponse({ method, skip = 0 }) {
      assertLeaseHealthy();
      if (responseHold || heldResponse) throw new Error("A Telegram API response hold is active.");
      responseHold = { method, skip };
    },
    waitForHeldResponse(method, timeoutMs) {
      assertLeaseHealthy();
      if (heldResponse?.event.method === method) return Promise.resolve(heldResponse.event);
      return new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          heldWaiters.delete(waiter);
        };
        const waiter = {
          method,
          resolve(event) {
            done();
            resolve(event);
          },
          reject(error) {
            done();
            reject(error);
          },
        };
        const timer = setTimeout(
          () => waiter.reject(new Error(`Timed out waiting for held Telegram ${method} response.`)),
          timeoutMs,
        );
        heldWaiters.add(waiter);
      });
    },
    releaseHeldResponse() {
      assertLeaseHealthy();
      if (!heldResponse) throw new Error("No Telegram API response is held.");
      const event = heldResponse.event;
      heldResponse.release.resolve();
      return event;
    },
    getResponseHoldEvents: () => holdEvents.map((event) => ({ ...event })),
    getRequestRejectionEvents: () => rejectionEvents.map((event) => ({ ...event })),
    close: () => {
      closing ??= (async () => {
        stop(new Error("Telegram Test Server proxy closed."));
        await new Promise((resolve) => server.close(() => resolve()));
        await Promise.allSettled([...requests]);
      })();
      return closing;
    },
  };
}
