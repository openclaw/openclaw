import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";

export const CODEX_NODE_RESOURCE_READINESS_FEATURE = "private-resource-readiness";

/** Derives a connection-local effect fence from its admitted Gateway delivery owner. */
export function createCodexNodeResourceReadiness(params: {
  required?: boolean;
  repository?: { wait: (signal: AbortSignal) => Promise<void>; assertCurrent: () => void };
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  const settled = createDeferred<void>();
  let status: "pending" | "ready" | "failed" = params.required ? "pending" : "ready";
  const assertReady = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
    if (status !== "ready") {
      throw new Error("Private turn resource preparation is unavailable.");
    }
  };
  return {
    readiness: params.required
      ? {
          async wait(signal: AbortSignal) {
            await Promise.all([
              params.repository?.wait(signal),
              racePromiseWithAbortSignal(settled.promise, signal).then(assertReady),
            ]);
            params.repository?.assertCurrent();
            assertReady();
          },
          assertCurrent() {
            params.repository?.assertCurrent();
            assertReady();
          },
        }
      : params.repository,
    settle(request: unknown) {
      if (!isRecord(request) || request.method !== "openclaw/resources/settle") {
        return undefined;
      }
      params.signal.throwIfAborted();
      params.assertCurrent();
      const next = isRecord(request.params) ? request.params.status : undefined;
      const valid =
        params.required &&
        status === "pending" &&
        (typeof request.id === "string" || Number.isSafeInteger(request.id)) &&
        Object.keys(request).every((key) => ["id", "method", "params", "jsonrpc"].includes(key)) &&
        (request.jsonrpc === undefined || request.jsonrpc === "2.0") &&
        isRecord(request.params) &&
        Object.keys(request.params).length === 1 &&
        (next === "ready" || next === "failed");
      if (valid) {
        status = next;
        settled.resolve();
      }
      return {
        id: request.id,
        ...(valid
          ? { result: {} }
          : { error: { code: -32001, message: "Private resource preparation owner changed." } }),
      };
    },
  };
}
