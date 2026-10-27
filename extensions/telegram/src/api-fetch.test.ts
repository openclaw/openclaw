import { afterEach, expect, it, vi } from "vitest";
import { fetchTelegramChatId, lookupTelegramChatId } from "./api-fetch.js";

const getChat = (fetchImpl?: typeof fetch) =>
  fetchTelegramChatId({ token: "abc", chatId: "@user", fetchImpl });

const proxyMocks = vi.hoisted(() => ({ undiciFetch: vi.fn() }));

afterEach(() => vi.useRealTimers());

vi.mock("undici/index.js", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici/index.js");
  return { ...actual, fetch: proxyMocks.undiciFetch };
});

it("returns null for oversized getChat JSON responses and cancels the stream", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
      cancel,
    }),
  );
  await expect(getChat(async () => response)).resolves.toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});

it("keeps the getChat timeout active until the response body read settles", async () => {
  vi.useFakeTimers();
  let observedSignal: AbortSignal | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const signal = init?.signal;
    observedSignal = signal ?? undefined;
    return new Response(
      new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), {
            once: true,
          });
        },
      }),
    );
  });

  const lookup = getChat(fetchImpl);

  await vi.advanceTimersByTimeAsync(15_000);

  await expect(lookup).resolves.toBeNull();
  expect(observedSignal?.aborted).toBe(true);
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
