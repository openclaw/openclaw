import { request as httpRequest } from "node:http";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { sleep } from "../../utils/sleep.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import { readNativeHookRelayClientBridgeRecord } from "./native-hook-relay-client-store.js";
import { DEFAULT_RELAY_TIMEOUT_MS } from "./native-hook-relay-constants.js";
import { codexNativeHookRelayResponseCodec } from "./native-hook-relay-response-codec.js";
import type {
  InvokeNativeHookRelayBridgeParams,
  InvokeNativeHookRelayParams,
  NativeHookRelayProcessResponse,
} from "./native-hook-relay-types.js";
import {
  normalizePositiveInteger,
  readNativeHookRelayEvent,
  readNativeHookRelayProvider,
  readNonEmptyString,
} from "./native-hook-relay-utils.js";

const MAX_NATIVE_HOOK_BRIDGE_RESPONSE_BYTES = 5_000_000;
const NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS = 25;
export const NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS = 250;
export const NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR =
  "native hook relay bridge stale registration";

/** Invoke a registered native relay through its read-only SQLite locator. */
export async function invokeNativeHookRelayBridge(
  params: InvokeNativeHookRelayBridgeParams,
): Promise<NativeHookRelayProcessResponse> {
  const provider = readNativeHookRelayProvider(params.provider);
  const relayId = readNonEmptyString(params.relayId, "relayId");
  const event = readNativeHookRelayEvent(params.event);
  const timeoutMs = normalizePositiveInteger(params.timeoutMs, DEFAULT_RELAY_TIMEOUT_MS);
  const registrationTimeoutMs = normalizePositiveInteger(params.registrationTimeoutMs, timeoutMs);
  const startedAt = performance.now();
  const deadline = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadline.signal])
    : deadline.signal;
  const timer = setSafeTimeout(
    () => deadline.abort(new Error("native hook relay bridge timed out")),
    timeoutMs,
  );
  timer.unref();
  let lastError: unknown = new Error("native hook relay bridge not found");
  try {
    while (performance.now() - startedAt < timeoutMs) {
      signal.throwIfAborted();
      try {
        const record = await readNativeHookRelayClientBridgeRecord({
          relayId,
          stateDbPath: params.stateDbPath,
          signal,
        });
        signal.throwIfAborted();
        if (!record || isPidDefinitelyDead(record.pid)) {
          throw new Error("native hook relay bridge not found");
        }
        if (Date.now() > record.expiresAtMs) {
          throw new Error("native hook relay bridge expired");
        }
        if (performance.now() - startedAt >= timeoutMs) {
          throw new Error("native hook relay bridge timed out");
        }
        const response = await postNativeHookRelayBridgeRecord({
          record,
          signal,
          payload: {
            provider,
            relayId,
            event,
            generation: params.generation,
            rawPayload: params.rawPayload,
          },
        });
        signal.throwIfAborted();
        if (performance.now() - startedAt >= timeoutMs) {
          throw new Error("native hook relay bridge timed out");
        }
        return response;
      } catch (error) {
        signal.throwIfAborted();
        lastError = error;
        const elapsedMs = performance.now() - startedAt;
        if (
          error instanceof Error &&
          error.message === "native hook relay bridge not found" &&
          elapsedMs >= registrationTimeoutMs
        ) {
          break;
        }
        if (!isRetryableNativeHookRelayBridgeLookupError({ error, elapsedMs })) {
          break;
        }
        await sleep(Math.min(NATIVE_HOOK_BRIDGE_RETRY_INTERVAL_MS, timeoutMs - elapsedMs), signal);
      }
    }
    signal.throwIfAborted();
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  } finally {
    clearTimeout(timer);
  }
}

function postNativeHookRelayBridgeRecord(params: {
  record: {
    hostname: "127.0.0.1";
    port: number;
    token: string;
  };
  signal: AbortSignal;
  payload: InvokeNativeHookRelayParams;
}): Promise<NativeHookRelayProcessResponse> {
  params.signal.throwIfAborted();
  const body = JSON.stringify(params.payload);
  return new Promise((resolve, reject) => {
    let outcome:
      | { ok: true; value: NativeHookRelayProcessResponse }
      | { ok: false; error: Error }
      | undefined;
    const fail = (error: unknown) => {
      outcome ??= { ok: false, error: toErrorObject(error, "Non-Error rejection") };
      req.destroy();
    };
    const req = httpRequest(
      {
        hostname: params.record.hostname,
        method: "POST",
        path: "/invoke",
        port: params.record.port,
        // A relay owns one request, not an idle pooled socket beyond completion.
        agent: false,
        signal: params.signal,
        headers: {
          authorization: `Bearer ${params.record.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseText = "";
        let responseBytes = 0;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          const chunkText = typeof chunk === "string" ? chunk : String(chunk);
          responseBytes += Buffer.byteLength(chunkText);
          if (responseBytes > MAX_NATIVE_HOOK_BRIDGE_RESPONSE_BYTES) {
            fail(new Error("native hook relay bridge response too large"));
            return;
          }
          responseText += chunkText;
        });
        res.on("error", fail);
        res.on("end", () => {
          if (outcome) {
            return;
          }
          try {
            const parsed = JSON.parse(responseText) as
              | { ok: true; result: NativeHookRelayProcessResponse }
              | { ok: false; error?: string };
            if (parsed.ok) {
              outcome = { ok: true, value: parsed.result };
            } else {
              fail(new Error(parsed.error || "native hook relay bridge failed"));
            }
          } catch (error) {
            fail(error);
          }
        });
      },
    );
    req.on("error", fail);
    // Abort/error delivery precedes physical socket closure. Do not let the CLI
    // emit its terminal response or start a fallback while this transport lives.
    req.once("close", () => {
      if (outcome?.ok) {
        resolve(outcome.value);
      } else {
        reject(outcome?.error ?? new Error("native hook relay bridge closed before its response"));
      }
    });
    req.end(body);
  });
}

function isRetryableNativeHookRelayBridgeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ENOENT" ||
    code === "ECONNREFUSED" ||
    code === "EAGAIN" ||
    isSqliteLockError(error) ||
    (error instanceof Error && error.message === "native hook relay bridge not found")
  );
}

export function isRetryableNativeHookRelayBridgeLookupError(params: {
  error: unknown;
  elapsedMs: number;
}): boolean {
  return (
    isRetryableNativeHookRelayBridgeError(params.error) ||
    (params.elapsedMs < NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS &&
      isNativeHookRelayBridgeStaleRegistrationError(params.error))
  );
}

/** Detect a stale locator response that must not fall back to the Gateway. */
export function isNativeHookRelayBridgeStaleRegistrationError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR
  );
}

/** Render the provider response used when both relay transports are unavailable. */
export function renderNativeHookRelayUnavailableResponse(params: {
  provider: unknown;
  event: unknown;
  preToolUseUnavailable?: unknown;
  message?: string;
}): NativeHookRelayProcessResponse {
  readNativeHookRelayProvider(params.provider);
  const event = readNativeHookRelayEvent(params.event);
  const message = params.message?.trim() || "Native hook relay unavailable";
  if (event === "pre_tool_use") {
    // The cold CLI cannot reconstruct relay policy after lookup fails. Fail
    // closed unless the generated command recorded that no local policy exists.
    if (params.preToolUseUnavailable === "noop") {
      return codexNativeHookRelayResponseCodec.renderNoopResponse();
    }
    return codexNativeHookRelayResponseCodec.renderPreToolUseBlockResponse(message);
  }
  if (event === "permission_request") {
    return codexNativeHookRelayResponseCodec.renderPermissionDecisionResponse("deny", message);
  }
  return codexNativeHookRelayResponseCodec.renderNoopResponse();
}
