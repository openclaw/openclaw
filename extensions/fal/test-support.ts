import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { vi } from "vitest";

type FalTestApi = {
  setImageFetchGuard: (impl: typeof fetchWithSsrFGuard | null) => void;
  setVideoFetchGuard: (impl: typeof fetchWithSsrFGuard | null) => void;
};

function getFalTestApi(): FalTestApi {
  const api = Reflect.get(globalThis, Symbol.for("openclaw.falTestApi"));
  if (!api) {
    throw new Error("Fal test API is unavailable");
  }
  return api as FalTestApi;
}

export function setFalFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  getFalTestApi().setImageFetchGuard(impl);
}

export function setFalVideoFetchGuardForTesting(impl: typeof fetchWithSsrFGuard | null): void {
  getFalTestApi().setVideoFetchGuard(impl);
}

/**
 * Builds a captured streaming response whose body cancellation stays pending
 * until the caller resolves `cancelGate`, mirroring a debug-capture clone that
 * keeps the response tee open. Providers must surface the malformed-body error
 * without awaiting cancellation; callers release the gate after asserting.
 */
export function releasedCapturedStream(params: {
  contentType: string;
  cancelGate: Promise<void>;
  onCancel?: (body: ReadableStream<Uint8Array>) => void;
}): { response: Response; release: () => Promise<void> } {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
  });
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": params.contentType },
  });
  const responseBody = response.body;
  if (!responseBody) {
    throw new Error("expected a streaming response body");
  }
  vi.spyOn(responseBody, "cancel").mockImplementation(() => {
    params.onCancel?.(responseBody);
    return params.cancelGate as unknown as Promise<undefined>;
  });
  return { response, release: vi.fn(async () => {}) };
}
