import type { ComfyBridgeError, ComfyGenerateRequest, ComfyGenerateResponse } from "./types.js";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (normalized === "127.0.0.1") {
    return true;
  }
  return normalized.startsWith("127.");
}

export function assertLoopbackBridgeUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`bridgeUrl must use http or https: ${rawUrl}`);
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(`bridgeUrl must resolve to loopback host: ${rawUrl}`);
  }
  return url;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toBridgeError(payload: unknown): ComfyBridgeError | undefined {
  if (!isObject(payload)) {
    return undefined;
  }
  if (payload.ok !== false) {
    return undefined;
  }
  if (typeof payload.message !== "string") {
    return undefined;
  }
  return {
    ok: false,
    code: typeof payload.code === "string" ? payload.code : undefined,
    message: payload.message,
    details: payload.details,
  };
}

function toSuccess(payload: unknown): ComfyGenerateResponse | undefined {
  if (!isObject(payload)) {
    return undefined;
  }
  if (payload.ok !== true) {
    return undefined;
  }
  if (typeof payload.job_id !== "string" || typeof payload.image_path !== "string") {
    return undefined;
  }
  return {
    ok: true,
    job_id: payload.job_id,
    image_path: payload.image_path,
    width: typeof payload.width === "number" ? payload.width : undefined,
    height: typeof payload.height === "number" ? payload.height : undefined,
    seed: typeof payload.seed === "number" ? payload.seed : undefined,
    model: typeof payload.model === "string" ? payload.model : undefined,
    timings_ms: isObject(payload.timings_ms)
      ? Object.fromEntries(
          Object.entries(payload.timings_ms)
            .filter((entry): entry is [string, number] => typeof entry[1] === "number")
            .map(([key, value]) => [key, value]),
        )
      : undefined,
  };
}

export async function requestComfyGenerateSync(params: {
  bridgeUrl: string;
  timeoutMs: number;
  request: ComfyGenerateRequest;
}): Promise<ComfyGenerateResponse> {
  const baseUrl = assertLoopbackBridgeUrl(params.bridgeUrl);
  const target = new URL("/v1/generate-sync", baseUrl);
  const signal = AbortSignal.timeout(Math.max(1000, Math.floor(params.timeoutMs)));
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params.request),
    signal,
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`bridge returned non-JSON response (${response.status})`);
  }

  const bridgeError = toBridgeError(payload);
  if (!response.ok || bridgeError) {
    if (bridgeError) {
      const prefix = bridgeError.code ? `${bridgeError.code}: ` : "";
      throw new Error(`${prefix}${bridgeError.message}`);
    }
    throw new Error(`bridge HTTP error (${response.status})`);
  }

  const success = toSuccess(payload);
  if (!success) {
    throw new Error("bridge returned unexpected response payload");
  }
  return success;
}
