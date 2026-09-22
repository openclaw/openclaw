#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolveQaConvexBrokerConnection,
  runQaConvexLookup,
} from "../../../../extensions/qa-lab/src/qa-credentials-bootstrap.ts";

const ENDPOINT_PREFIX = "/qa-credentials/v1";
const CHUNKED_PAYLOAD_MARKER = "__openclawQaCredentialPayloadChunksV1";
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_PAYLOAD_MAX_CHUNKS = 4096;
const DEFAULT_RESPONSE_MAX_BYTES = 1024 * 1024;
const RETRYABLE_ACQUIRE_CODES = new Set(["POOL_EXHAUSTED", "NO_CREDENTIAL_AVAILABLE"]);
const CONVEX_WRITE_CONTENTION =
  /Documents read from or written to the "credential_sets" table changed while this mutation was being run/u;

export class QaCredentialBrokerError extends Error {
  constructor(code, message, retryAfterMs) {
    super(message);
    this.name = "QaCredentialBrokerError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryableAcquireError(error) {
  return (
    error instanceof QaCredentialBrokerError &&
    (RETRYABLE_ACQUIRE_CODES.has(error.code) ||
      (error.code === "INTERNAL_ERROR" && CONVEX_WRITE_CONTENTION.test(error.message)))
  );
}

async function defaultRunConvexCli(args, options) {
  // The standalone Telegram entrypoint keeps its existing child-process owner.
  const { runCommand } = await import("./run-mock-sut-user-e2e.mjs");
  const { withTelegramRun } = await import("./telegram-run-scope.mjs");
  return await runQaConvexLookup(args, options, (command, argv, runOptions) =>
    withTelegramRun(() => runCommand(command, argv, runOptions), { signal: options.signal }),
  );
}

async function readBrokerResponse(response, maxBytes) {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Broker response exceeded ${maxBytes} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Broker returned invalid JSON.");
  }
}

async function callBroker(
  suffix,
  body,
  { broker, fetchImpl, httpTimeoutMs, maxResponseBytes = DEFAULT_RESPONSE_MAX_BYTES },
) {
  const { siteUrl, secret } = broker;
  const response = await fetchImpl(`${siteUrl}${ENDPOINT_PREFIX}/${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(httpTimeoutMs),
  });
  const payload = await readBrokerResponse(response, maxResponseBytes);
  const acceptsEmptySuccess =
    response.ok &&
    Object.keys(payload).length === 0 &&
    (suffix === "heartbeat" || suffix === "release");
  if (!response.ok || (payload.status !== "ok" && !acceptsEmptySuccess)) {
    const code = typeof payload.code === "string" ? payload.code : "BROKER_REQUEST_FAILED";
    const message =
      typeof payload.message === "string" ? payload.message : "Broker request failed.";
    const retryAfterMs = Number.isFinite(payload.retryAfterMs) ? payload.retryAfterMs : undefined;
    throw new QaCredentialBrokerError(code, `${suffix} failed: ${code} ${message}`, retryAfterMs);
  }
  return payload;
}

function parseChunkedPayloadMarker(payload, { payloadMaxBytes, payloadMaxChunks }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload[CHUNKED_PAYLOAD_MARKER] !== true) return null;
  if (!Number.isSafeInteger(payload.chunkCount) || payload.chunkCount < 1) {
    throw new Error("Chunked credential payload has invalid chunkCount.");
  }
  if (payload.chunkCount > payloadMaxChunks) {
    throw new Error(`Chunked credential payload exceeded ${payloadMaxChunks} chunks.`);
  }
  if (!Number.isSafeInteger(payload.byteLength) || payload.byteLength < 0) {
    throw new Error("Chunked credential payload has invalid byteLength.");
  }
  if (payload.byteLength > payloadMaxBytes) {
    throw new Error(`Chunked credential payload exceeded ${payloadMaxBytes} bytes.`);
  }
  return { chunkCount: payload.chunkCount, byteLength: payload.byteLength };
}

async function resolveCredentialPayload(acquired, identity, requestOptions, limits, leaseHealth) {
  const marker = parseChunkedPayloadMarker(acquired.payload, limits);
  if (!marker) return acquired.payload;
  const chunks = [];
  let byteLength = 0;
  for (let index = 0; index < marker.chunkCount; index += 1) {
    leaseHealth.assertHealthy();
    const chunk = await Promise.race([
      callBroker(
        "payload-chunk",
        { ...identity, index },
        { ...requestOptions, maxResponseBytes: limits.payloadMaxBytes },
      ),
      leaseHealth.whenUnhealthy.then((error) => Promise.reject(error)),
    ]);
    leaseHealth.assertHealthy();
    if (typeof chunk.data !== "string") {
      throw new Error("Broker payload chunk is missing data.");
    }
    byteLength += Buffer.byteLength(chunk.data, "utf8");
    if (byteLength > marker.byteLength) {
      throw new Error("Chunked credential payload exceeded its declared byteLength.");
    }
    chunks.push(chunk.data);
  }
  if (byteLength !== marker.byteLength) {
    throw new Error("Chunked credential payload length mismatch.");
  }
  return JSON.parse(chunks.join(""));
}

export async function acquireQaLease({
  kind = "",
  ownerId = `qa-lease-${os.hostname()}-${process.pid}-${randomUUID()}`,
  leaseTtlMs = 20 * 60_000,
  heartbeatIntervalMs = 30_000,
  acquireTimeoutMs = 90_000,
  httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  payloadMaxBytes = DEFAULT_PAYLOAD_MAX_BYTES,
  payloadMaxChunks = DEFAULT_PAYLOAD_MAX_CHUNKS,
  env = process.env,
  signal,
  cwd = process.cwd(),
  runConvexCliImpl = defaultRunConvexCli,
  convexProjectDir,
  fetchImpl = fetch,
  sleepImpl = (ms) => delay(ms, undefined, { signal }),
  randomImpl = Math.random,
} = {}) {
  if (!kind) throw new Error("acquireQaLease requires a credential kind.");
  signal?.throwIfAborted();
  const broker = await resolveQaConvexBrokerConnection({
    env,
    cwd,
    runConvexCliImpl,
    convexProjectDir,
    signal,
  });
  const requestOptions = { broker, fetchImpl, httpTimeoutMs };
  const startedAt = Date.now();
  let acquired;
  let confirmedAt;
  for (;;) {
    signal?.throwIfAborted();
    try {
      confirmedAt = { wall: Date.now(), monotonic: performance.now() };
      acquired = await callBroker(
        "acquire",
        { kind, ownerId, actorRole: "ci", leaseTtlMs, heartbeatIntervalMs },
        requestOptions,
      );
      break;
    } catch (error) {
      if (!retryableAcquireError(error)) throw error;
      const remainingMs = acquireTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw error;
      }
      const retryAfterMs =
        error.retryAfterMs ??
        (error.code === "INTERNAL_ERROR" ? 50 + Math.floor(randomImpl() * 250) : 1_000);
      await sleepImpl(Math.min(retryAfterMs, remainingMs));
    }
  }
  const identity = {
    kind,
    ownerId,
    actorRole: "ci",
    credentialId: acquired.credentialId,
    leaseToken: acquired.leaseToken,
  };
  if (!identity.credentialId || !identity.leaseToken) {
    throw new Error("Broker acquire response is missing lease identity.");
  }
  return await manageQaLease({
    identity,
    acquired,
    confirmedAt,
    requestOptions,
    leaseTtlMs,
    heartbeatIntervalMs,
    payloadMaxBytes,
    payloadMaxChunks,
    signal,
  });
}

// Recovery revalidates the same broker owner. It never allocates a replacement.
export async function resumeQaLease({
  recovery,
  env = process.env,
  signal,
  cwd = process.cwd(),
  fetchImpl = fetch,
  runConvexCliImpl = defaultRunConvexCli,
  convexProjectDir,
  httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
}) {
  signal?.throwIfAborted();
  const broker = await resolveQaConvexBrokerConnection({
    env,
    cwd,
    runConvexCliImpl,
    convexProjectDir,
    signal,
  });
  return await manageQaLease({
    identity: recovery.identity,
    acquired: { payload: undefined },
    requestOptions: { broker, fetchImpl, httpTimeoutMs },
    leaseTtlMs: recovery.leaseTtlMs,
    heartbeatIntervalMs: recovery.heartbeatIntervalMs,
    payloadMaxBytes: DEFAULT_PAYLOAD_MAX_BYTES,
    payloadMaxChunks: DEFAULT_PAYLOAD_MAX_CHUNKS,
    signal,
    recovering: true,
  });
}

async function manageQaLease({
  identity,
  acquired,
  requestOptions,
  leaseTtlMs,
  heartbeatIntervalMs,
  payloadMaxBytes,
  payloadMaxChunks,
  signal,
  recovering = false,
  confirmedAt = { wall: Date.now(), monotonic: performance.now() },
}) {
  let heartbeatError;
  let heartbeatInFlight;
  let resolveUnhealthy;
  const whenUnhealthy = new Promise((resolve) => {
    resolveUnhealthy = resolve;
  });
  const invalidate = (error) => {
    if (!heartbeatError) {
      heartbeatError = error;
      resolveUnhealthy(error);
    }
  };
  const assertHealthy = () => {
    // Anchor to request start, not response receipt. Check synchronously at use:
    // a suspended worker must not forward before its heartbeat timer catches up.
    const age = Math.max(Date.now() - confirmedAt.wall, performance.now() - confirmedAt.monotonic);
    if (age >= leaseTtlMs) invalidate(new Error("Credential lease confirmation expired."));
    if (heartbeatError) throw heartbeatError;
  };
  const heartbeat = () => {
    if (heartbeatInFlight || heartbeatError) return heartbeatInFlight;
    try {
      assertHealthy();
    } catch {
      return;
    }
    const requestedAt = { wall: Date.now(), monotonic: performance.now() };
    heartbeatInFlight = callBroker("heartbeat", { ...identity, leaseTtlMs }, requestOptions)
      .then(() => {
        if (heartbeatError) return;
        confirmedAt = requestedAt;
        assertHealthy();
      })
      .catch((error) => {
        invalidate(error);
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
    return heartbeatInFlight;
  };
  const initialHeartbeat = heartbeat();
  const timer = setInterval(heartbeat, heartbeatIntervalMs);
  timer.unref?.();
  const stopHeartbeat = async () => {
    clearInterval(timer);
    const inFlight = heartbeatInFlight;
    await inFlight;
  };
  let payload;
  try {
    await initialHeartbeat;
    signal?.throwIfAborted();
    assertHealthy();
    payload = await resolveCredentialPayload(
      acquired,
      identity,
      requestOptions,
      {
        payloadMaxBytes,
        payloadMaxChunks,
      },
      { assertHealthy, whenUnhealthy },
    );
    assertHealthy();
    signal?.throwIfAborted();
  } catch (error) {
    if (recovering) {
      await stopHeartbeat();
      throw error;
    }
    try {
      await stopHeartbeat();
      await callBroker("release", identity, requestOptions);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "Credential payload hydration and lease release failed.",
      );
    }
    throw error;
  }
  let releasing;
  return {
    payload,
    credentialId: identity.credentialId,
    recovery: { identity, leaseTtlMs, heartbeatIntervalMs },
    whenUnhealthy,
    assertHealthy,
    abandon: async () => {
      invalidate(new Error("Credential lease abandoned; waiting for existing broker expiry."));
      await stopHeartbeat();
    },
    release: () => {
      invalidate(
        Object.assign(new Error("Credential lease released."), { code: "LEASE_RELEASED" }),
      );
      releasing ??= (async () => {
        await stopHeartbeat();
        await callBroker("release", identity, requestOptions);
      })();
      return releasing;
    },
  };
}
