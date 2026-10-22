import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTelegramChatId, lookupTelegramChatId } from "./api-fetch.js";

function getChat(fetchImpl?: typeof fetch) {
  return fetchTelegramChatId({ token: "abc", chatId: "@user", fetchImpl });
}

function abortableResponse(signal: AbortSignal | null | undefined, status: number, chunk?: string) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (chunk) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const proxyMocks = vi.hoisted(() => ({ undiciFetch: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

vi.mock("undici/index.js", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici/index.js");
  return { ...actual, fetch: proxyMocks.undiciFetch };
});

describe("fetchTelegramChatId", () => {
  it("returns null for oversized getChat JSON responses and cancels the stream", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        },
        cancel,
      }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
    vi.spyOn(response, "json").mockRejectedValue(new Error("unbounded json reader was used"));
    await expect(getChat(async () => response)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not wait for a cloned capture branch before returning", async () => {
    let observedSignal: AbortSignal | undefined;
    let captureSettled = false;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      const response = abortableResponse(observedSignal, 503, "service unavailable");
      const clone = response.clone();
      void clone
        .arrayBuffer()
        .catch(() => undefined)
        .finally(() => {
          captureSettled = true;
        });
      return response;
    });

    const result = await Promise.race([
      getChat(fetchImpl),
      new Promise<"stalled">((resolve) => {
        setTimeout(() => resolve("stalled"), 250);
      }),
    ]);

    expect(result).toBeNull();
    await vi.waitFor(() => expect(captureSettled).toBe(true));
    expect(observedSignal?.aborted).toBe(true);
  });

  it("keeps the getChat timeout active until the response body read settles", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return abortableResponse(observedSignal, 200);
    });

    const lookup = getChat(fetchImpl);

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(lookup).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBeInstanceOf(Error);
    expect(observedSignal?.reason).toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
  });
});

it.each(["success", "transport failure"])(
  "lookupTelegramChatId closes its owned transport after %s",
  async (outcome) => {
    proxyMocks.undiciFetch.mockReset();
    const expected = outcome === "success" ? "12345" : null;
    if (expected) {
      proxyMocks.undiciFetch.mockResolvedValueOnce(
        Response.json({ ok: true, result: { id: 12345 } }),
      );
    } else {
      proxyMocks.undiciFetch.mockRejectedValueOnce(new Error("network failed"));
    }

    await expect(
      lookupTelegramChatId({
        token: "abc",
        chatId: "@user",
        network: { autoSelectFamily: false },
      }),
    ).resolves.toBe(expected);

    const init = proxyMocks.undiciFetch.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: { destroyed?: boolean } })
      | undefined;
    expect(init?.dispatcher?.destroyed).toBe(true);
  },
);
