import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});

const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
}));

import {
  callZaloApi,
  deleteWebhook,
  getMe,
  getUpdates,
  getWebhookInfo,
  sendChatAction,
  sendMessage,
  sendPhoto,
  type ZaloFetch,
} from "./api.js";
import { ZALO_DEFAULT_REQUEST_TIMEOUT_MS, ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS } from "./timeouts.js";

function oversizedZaloJsonResponse(onCancel: () => void): Response {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
      },
      cancel: onCancel,
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
  Object.defineProperty(response, "json", {
    value: async () => {
      throw new Error("unbounded json reader was used");
    },
  });
  return response;
}

function signalAbortedZaloJsonResponse(signal: AbortSignal, onAbort: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const abortBody = () => {
          onAbort();
          controller.error(new Error("zalo body aborted"));
        };
        if (signal.aborted) {
          abortBody();
          return;
        }
        signal.addEventListener("abort", abortBody, { once: true });
      },
      async pull() {
        await new Promise<void>(() => {});
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

const createOkFetcher = () =>
  vi.fn<ZaloFetch>(async () => new Response(JSON.stringify({ ok: true, result: {} })));

const sendTestPhoto = (photo: string, fetcher: ZaloFetch) =>
  sendPhoto("test-token", { chat_id: "chat-123", photo }, fetcher);

describe("Zalo API request methods", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each([false, true])(
    "rechecks the send caller after effect preparation (retired=%s)",
    async (retired) => {
      const preparing = createDeferred();
      const prepared = createDeferred();
      const dispatched = createDeferred();
      const response = createDeferred<Response>();
      const caller = new AbortController();
      const failure = new Error("Zalo caller retired");
      effectGate.prepare = async () => {
        preparing.resolve();
        await prepared.promise;
      };
      const fetch = vi.fn<ZaloFetch>(() => {
        dispatched.resolve();
        return response.promise;
      });
      const sending = callZaloApi(
        "sendMessage",
        "test-token",
        { chat_id: "chat-123", text: "hello" },
        {
          fetch,
          assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
        },
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          preparing.promise,
          dispatched.promise.then(() => {
            throw new Error("dispatched before preparation");
          }),
        ]);
        expect(fetch).not.toHaveBeenCalled();
        if (retired) {
          caller.abort(failure);
        }
        prepared.resolve();
        if (!retired) {
          await dispatched.promise;
          caller.abort(failure);
        }
        response.resolve(Response.json({ ok: true, result: { message_id: "sent-1" } }));
        expect(await sending).toEqual(
          retired ? { error: failure } : { value: { ok: true, result: { message_id: "sent-1" } } },
        );
        expect(fetch).toHaveBeenCalledTimes(retired ? 0 : 1);
      } finally {
        prepared.resolve();
        response.resolve(Response.json({ ok: true, result: {} }));
        await sending;
        effectGate.prepare = undefined;
      }
    },
  );

  beforeEach(() => {
    vi.unstubAllEnvs();
    resolvePinnedHostnameWithPolicyMock.mockReset();
    resolvePinnedHostnameWithPolicyMock.mockResolvedValue({
      hostname: "example.com",
      addresses: ["93.184.216.34"],
      lookup: vi.fn(),
    });
  });

  it.each([
    ["   ", "must not be empty."],
    ["file:///tmp/zalo", "must use http:// or https://."],
    ["https://proxy.example/zalo#provider", "must not include a query string or fragment."],
  ])("rejects invalid API root %j", async (apiUrl, error) => {
    vi.stubEnv("ZALO_API_URL", apiUrl);
    await expect(
      callZaloApi("getMe", "test-token", undefined, { fetch: createOkFetcher() }),
    ).rejects.toThrow(`ZALO_API_URL ${error}`);
  });

  it.each([getWebhookInfo, deleteWebhook])("uses JSON POST for %s", async (run) => {
    const fetcher = createOkFetcher();
    await run("test-token", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = expectDefined(fetcher.mock.calls[0], "Zalo request");
    expect({ method: init?.method, headers: init?.headers }).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  });

  it("keeps the default request deadline active while reading a hanging send response body", async () => {
    vi.useFakeTimers();
    let bodyAborted = false;
    const fetcher = vi.fn<ZaloFetch>(async (_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("expected Zalo request abort signal");
      }
      return signalAbortedZaloJsonResponse(signal, () => {
        bodyAborted = true;
      });
    });

    const promise = sendMessage("test-token", { chat_id: "chat-123", text: "hello" }, fetcher);
    const rejected = expect(promise).rejects.toThrow("zalo body aborted");

    await vi.advanceTimersByTimeAsync(ZALO_DEFAULT_REQUEST_TIMEOUT_MS);

    await rejected;
    const [, init] = expectDefined(fetcher.mock.calls[0], "Zalo send request");
    expect(init?.signal?.aborted).toBe(true);
    expect(bodyAborted).toBe(true);
  });

  it("caps oversized sendChatAction timeouts before scheduling the timer", async () => {
    const setTimeoutMock = vi.spyOn(globalThis, "setTimeout");
    const fetcher = createOkFetcher();

    await sendChatAction(
      "test-token",
      { chat_id: "chat-123", action: "typing" },
      fetcher,
      MAX_TIMER_TIMEOUT_MS + 1_000_000,
    );

    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("keeps getUpdates on the long-poll request timeout", async () => {
    const setTimeoutMock = vi.spyOn(globalThis, "setTimeout");
    const fetcher = createOkFetcher();

    await getUpdates("test-token", { timeout: 45 }, fetcher);

    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 50_000);
    const [, init] = expectDefined(fetcher.mock.calls[0], "Zalo getUpdates request");
    expect(init?.body).toBe(JSON.stringify({ timeout: "45" }));
  });

  it("keeps URL-only photo sends past the default and bounds the media window", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn<ZaloFetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          requestSignal?.addEventListener("abort", () => reject(new Error("photo aborted")), {
            once: true,
          });
        }),
    );

    const promise = sendTestPhoto("https://example.com/image.png", fetcher);
    await vi.advanceTimersByTimeAsync(ZALO_DEFAULT_REQUEST_TIMEOUT_MS);
    expect(requestSignal?.aborted).toBe(false);

    const rejected = expect(promise).rejects.toThrow("photo aborted");
    await vi.advanceTimersByTimeAsync(
      ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS - ZALO_DEFAULT_REQUEST_TIMEOUT_MS,
    );
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("blocks private-network photo URLs before they reach the Zalo API", async () => {
    const fetcher = createOkFetcher();
    resolvePinnedHostnameWithPolicyMock.mockRejectedValueOnce(
      new Error("Blocked hostname or private/internal/special-use IP address"),
    );

    await expect(
      sendTestPhoto("http://169.254.169.254/latest/meta-data/iam/security-credentials/", fetcher),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["file:///etc/passwd", "must use HTTP or HTTPS"],
    ["not a url", "must be an absolute HTTP or HTTPS URL"],
  ])("rejects photo %j before DNS or fetch", async (photo, error) => {
    const fetcher = createOkFetcher();
    await expect(sendTestPhoto(photo, fetcher)).rejects.toThrow(`Zalo photo URL ${error}`);
    expect(resolvePinnedHostnameWithPolicyMock).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds oversized getMe JSON responses and cancels the stream", async () => {
    let cancelCount = 0;
    const fetcher = vi.fn<ZaloFetch>(async () =>
      oversizedZaloJsonResponse(() => {
        cancelCount += 1;
      }),
    );

    await expect(getMe("test-token", undefined, fetcher)).rejects.toThrow(
      "zalo.getMe: JSON response exceeds 16777216 bytes",
    );
    expect(cancelCount).toBe(1);
  });
});
