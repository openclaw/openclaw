import * as http from "http";
import crypto from "node:crypto";
import { Readable } from "stream";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  applyBasicWebhookRequestGuards,
  readJsonBodyWithLimit,
  type RuntimeEnv,
  installRequestBodyLimitGuard,
} from "openclaw/plugin-sdk/feishu";
import { createFeishuWSClient } from "./client.js";
import {
  botNames,
  botOpenIds,
  FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
  FEISHU_WEBHOOK_MAX_BODY_BYTES,
  feishuWebhookRateLimiter,
  httpServers,
  recordWebhookStatus,
  webhookServerPool,
  wsClients,
  type WebhookServerEntry,
} from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type MonitorTransportParams = {
  account: ResolvedFeishuAccount;
  accountId: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  eventDispatcher: Lark.EventDispatcher;
};

function isFeishuWebhookPayload(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildFeishuWebhookEnvelope(
  req: http.IncomingMessage,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return Object.assign(Object.create({ headers: req.headers }), payload) as Record<string, unknown>;
}

function isFeishuWebhookSignatureValid(params: {
  headers: http.IncomingHttpHeaders;
  payload: Record<string, unknown>;
  encryptKey?: string;
}): boolean {
  const encryptKey = params.encryptKey?.trim();
  if (!encryptKey) {
    return true;
  }

  const timestampHeader = params.headers["x-lark-request-timestamp"];
  const nonceHeader = params.headers["x-lark-request-nonce"];
  const signatureHeader = params.headers["x-lark-signature"];
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const computedSignature = crypto
    .createHash("sha256")
    .update(timestamp + nonce + encryptKey + JSON.stringify(params.payload))
    .digest("hex");
  return computedSignature === signature;
}

function respondText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

export async function monitorWebSocket({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  log(`feishu[${accountId}]: starting WebSocket connection...`);

  const wsClient = createFeishuWSClient(account);
  wsClients.set(accountId, wsClient);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      wsClients.delete(accountId);
      botOpenIds.delete(accountId);
      botNames.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      wsClient.start({ eventDispatcher });
      log(`feishu[${accountId}]: WebSocket client started`);
    } catch (err) {
      cleanup();
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    }
  });
}

export async function monitorWebhook({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const port = account.config.webhookPort ?? 3000;
  const path = account.config.webhookPath ?? "/feishu/events";
  const host = account.config.webhookHost ?? "127.0.0.1";
  const serverKey = `${host}:${port}`;

  // ---------------------------------------------------------------------------
  // Helper: join an existing pooled server that is ready (or becoming ready).
  // ---------------------------------------------------------------------------
  const joinExistingServer = (existing: WebhookServerEntry): Promise<void> => {
    existing.routes.set(accountId, {
      accountId,
      appId: account.appId?.trim() ?? "",
      token: account.verificationToken?.trim() ?? "",
      handler: createGuardedHandler({ account, accountId, path, runtime, error, eventDispatcher }),
    });
    httpServers.set(accountId, existing.server);
    log(
      `feishu[${accountId}]: joined shared Webhook server on ${serverKey} ` +
        `(${existing.routes.size} accounts)`,
    );

    return new Promise<void>((resolve) => {
      const handleAbort = () => {
        log(`feishu[${accountId}]: abort, leaving shared server on ${serverKey}`);
        existing.routes.delete(accountId);
        httpServers.delete(accountId);
        botOpenIds.delete(accountId);
        botNames.delete(accountId);
        if (existing.routes.size === 0) {
          existing.server.close();
          webhookServerPool.delete(serverKey);
        }
        resolve();
      };
      if (abortSignal?.aborted) {
        handleAbort();
        return;
      }
      abortSignal?.addEventListener("abort", handleAbort, { once: true });
    });
  };

  // ---------------------------------------------------------------------------
  // Try to re-use an existing server on the same host:port.
  // The pool entry is published *before* listen() completes (reservation) so
  // concurrent starters coalesce on the same entry.  Joiners await
  // `entry.ready` and fall through to create a new server if listen fails.
  // ---------------------------------------------------------------------------
  const existing = webhookServerPool.get(serverKey);
  if (existing) {
    try {
      await existing.ready;
    } catch {
      // Creator's listen failed; the pool entry has been cleaned up.
      // Fall through to create a fresh server below.
      log(`feishu[${accountId}]: shared server on ${serverKey} failed to start, creating new`);
    }
    // Re-check: the pool entry may have been removed by the creator's error handler.
    const current = webhookServerPool.get(serverKey);
    if (current === existing) {
      return joinExistingServer(existing);
    }
    // else: fall through to create a new server.
  }

  // ---------------------------------------------------------------------------
  // First account on this host:port — create a new pooled server.
  // Publish the pool entry immediately (reservation) so concurrent starters
  // see it and await `ready` instead of creating duplicate servers.
  // ---------------------------------------------------------------------------
  log(`feishu[${accountId}]: starting Webhook server on ${host}:${port}, path ${path}...`);
  const server = http.createServer();

  let resolveReady!: () => void;
  let rejectReady!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Mark the rejection as observed so that Node does not treat it as an
  // unhandled rejection when no joiner is awaiting the promise (e.g. single-
  // account EADDRINUSE or early abort).  Joiners still receive the rejection
  // via their own `await existing.ready` inside a try/catch.
  ready.catch(() => {});

  const entry: WebhookServerEntry = {
    server,
    ready,
    routes: new Map([
      [
        accountId,
        {
          accountId,
          appId: account.appId?.trim() ?? "",
          token: account.verificationToken?.trim() ?? "",
          handler: createGuardedHandler({
            account,
            accountId,
            path,
            runtime,
            error,
            eventDispatcher,
          }),
        },
      ],
    ]),
  };
  // Publish reservation before listen so concurrent starters coalesce.
  webhookServerPool.set(serverKey, entry);
  httpServers.set(accountId, server);

  server.on("request", createPoolDispatcher(entry));

  return new Promise((resolve, reject) => {
    // Remove only this account's route; close the server only when no routes remain.
    // This mirrors the joiner's abort handler so creator and joiner behave identically.
    const removeOwnRoute = () => {
      entry.routes.delete(accountId);
      httpServers.delete(accountId);
      botOpenIds.delete(accountId);
      botNames.delete(accountId);
      if (entry.routes.size === 0) {
        server.close();
        webhookServerPool.delete(serverKey);
      }
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, leaving Webhook server on ${serverKey}`);
      // Settle `ready` so concurrent joiners awaiting it do not hang forever.
      rejectReady(new Error("aborted"));
      removeOwnRoute();
      resolve();
    };

    if (abortSignal?.aborted) {
      rejectReady(new Error("aborted"));
      removeOwnRoute();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    server.listen(port, host, () => {
      resolveReady();
      log(`feishu[${accountId}]: Webhook server listening on ${host}:${port}`);
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      // Signal pending joiners that this server will not start.
      rejectReady(err);
      // Clean pool state so the next restart does not join a dead server.
      server.close();
      webhookServerPool.delete(serverKey);
      for (const aid of entry.routes.keys()) {
        httpServers.delete(aid);
        botOpenIds.delete(aid);
        botNames.delete(aid);
      }
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Internal helpers — kept private to this module.
// ---------------------------------------------------------------------------

/** Wrap an account's webhook logic with rate-limit, body-guard, signature
 *  validation, challenge handling, and event dispatch.
 *  Signature stays `(req, res) => void` so it slots into the route map. */
function createGuardedHandler(opts: {
  account: ResolvedFeishuAccount;
  accountId: string;
  path: string;
  runtime?: RuntimeEnv;
  error: (...args: unknown[]) => void;
  eventDispatcher: Lark.EventDispatcher;
}): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    res.on("finish", () => {
      recordWebhookStatus(opts.runtime, opts.accountId, opts.path, res.statusCode);
    });

    const rateLimitKey = `${opts.accountId}:${opts.path}:${req.socket.remoteAddress ?? "unknown"}`;
    if (
      !applyBasicWebhookRequestGuards({
        req,
        res,
        rateLimiter: feishuWebhookRateLimiter,
        rateLimitKey,
        nowMs: Date.now(),
        requireJsonContentType: true,
      })
    ) {
      return;
    }

    const guard = installRequestBodyLimitGuard(req, res, {
      maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
      responseFormat: "text",
    });
    if (guard.isTripped()) {
      return;
    }

    void (async () => {
      try {
        const bodyResult = await readJsonBodyWithLimit(req, {
          maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
          timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
        });
        if (guard.isTripped() || res.writableEnded) {
          return;
        }
        if (!bodyResult.ok) {
          if (bodyResult.code === "INVALID_JSON") {
            respondText(res, 400, "Invalid JSON");
          }
          return;
        }
        if (!isFeishuWebhookPayload(bodyResult.value)) {
          respondText(res, 400, "Invalid JSON");
          return;
        }

        // Lark's default adapter drops invalid signatures as an empty 200. Reject here instead.
        if (
          !isFeishuWebhookSignatureValid({
            headers: req.headers,
            payload: bodyResult.value,
            encryptKey: opts.account.encryptKey,
          })
        ) {
          respondText(res, 401, "Invalid signature");
          return;
        }

        const { isChallenge, challenge } = Lark.generateChallenge(bodyResult.value, {
          encryptKey: opts.account.encryptKey ?? "",
        });
        if (isChallenge) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(challenge));
          return;
        }

        const value = await opts.eventDispatcher.invoke(
          buildFeishuWebhookEnvelope(req, bodyResult.value),
          { needCheck: false },
        );
        if (!res.headersSent) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(value));
        }
      } catch (err) {
        if (!guard.isTripped()) {
          opts.error(`feishu[${opts.accountId}]: webhook handler error: ${String(err)}`);
          if (!res.headersSent) {
            respondText(res, 500, "Internal Server Error");
          }
        }
      } finally {
        guard.dispose();
      }
    })();
  };
}

/** Create the single `request` listener for a pooled server.
 *
 *  - 1 route  → fast-path: delegate directly (zero body parsing overhead).
 *  - N routes → read body once, extract `header.token` / `header.app_id` for
 *               routing, then replay the body as a new Readable stream. */
function createPoolDispatcher(entry: WebhookServerEntry) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Fast path: single account — no routing needed.
    if (entry.routes.size === 1) {
      const route = entry.routes.values().next().value;
      if (route) route.handler(req, res);
      return;
    }

    // Apply lightweight request guards *before* buffering the body so that
    // invalid-method / non-JSON requests are rejected without consuming socket
    // and memory resources.  Rate limiting is intentionally omitted here — each
    // routed account's createGuardedHandler applies its own per-account limit.
    // A pool-wide per-IP limit would cap aggregate traffic from one IP across
    // all accounts at a single-account threshold, rejecting legitimate events.
    if (
      !applyBasicWebhookRequestGuards({
        req,
        res,
        requireJsonContentType: true,
      })
    ) {
      return;
    }

    // Multi-account: buffer body to extract the routing token.
    // Enforce the same body size limit and timeout used by the per-account guard
    // so an oversized or slow payload is rejected before we finish buffering.
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    const bodyTimeout = setTimeout(() => {
      if (aborted) return;
      aborted = true;
      res.statusCode = 408;
      res.end("Request Timeout");
      req.destroy();
    }, FEISHU_WEBHOOK_BODY_TIMEOUT_MS);

    const finishBuffering = () => {
      clearTimeout(bodyTimeout);
    };

    req.on("data", (c: Buffer) => {
      if (aborted) return;
      totalBytes += c.length;
      if (totalBytes > FEISHU_WEBHOOK_MAX_BODY_BYTES) {
        aborted = true;
        finishBuffering();
        res.statusCode = 413;
        res.end("Payload Too Large");
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      finishBuffering();
      if (aborted) return;
      const raw = Buffer.concat(chunks);
      const route = resolveRoute(entry, raw);
      if (!route) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }
      route.handler(replayRequest(req, raw), res);
    });
    req.on("error", () => {
      finishBuffering();
      if (!res.headersSent) {
        res.statusCode = 400;
        res.end("Bad Request");
      }
    });
  };
}

/** Pick the matching route using a three-tier strategy:
 *  1. token + appId  (strongest — disambiguates shared/inherited tokens)
 *  2. token-only     (sufficient when tokens are unique per account)
 *  3. appId-only     (fallback when verificationToken is absent)
 *  4. url_verification → any account can respond. */
function resolveRoute(entry: WebhookServerEntry, body: Buffer) {
  let token: string | undefined;
  let appId: string | undefined;
  let type: string | undefined;
  try {
    const json = JSON.parse(body.toString("utf-8"));
    token = json.header?.token ?? json.token;
    appId = json.header?.app_id ?? json.event?.app_id;
    type = json.type;
  } catch {
    return undefined;
  }

  // Tier 1: both token and appId match — handles shared/inherited tokens.
  if (token && appId) {
    for (const route of entry.routes.values()) {
      if (route.token && route.token === token && route.appId && route.appId === appId) {
        return route;
      }
    }
  }
  // Tier 2: token-only (unique token per account).
  if (token) {
    for (const route of entry.routes.values()) {
      if (route.token && route.token === token) return route;
    }
  }
  // Tier 3: appId-only (verificationToken absent).
  if (appId) {
    for (const route of entry.routes.values()) {
      if (route.appId && route.appId === appId) return route;
    }
  }
  // url_verification: any account can respond.
  if (type === "url_verification") return entry.routes.values().next().value;
  return undefined;
}

/** Create a Readable that replays `rawBody` while preserving original request
 *  properties so downstream handlers can consume it normally. */
function replayRequest(original: http.IncomingMessage, rawBody: Buffer): http.IncomingMessage {
  const stream = new Readable({ read() {} });
  stream.push(rawBody);
  stream.push(null);
  Object.assign(stream, {
    method: original.method,
    url: original.url,
    headers: original.headers,
    rawHeaders: original.rawHeaders,
    httpVersion: original.httpVersion,
    socket: original.socket,
    connection: original.connection,
  });
  return stream as unknown as http.IncomingMessage;
}
