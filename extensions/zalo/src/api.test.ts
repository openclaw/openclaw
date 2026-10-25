import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForEffectPreparation } from "../../test-support/effect-preparation.test-support.js";

const effectGate = await vi.hoisted(async () =>
  (
    await import("../../test-support/effect-preparation.test-support.js")
  ).createEffectPreparationGate(),
);
// mock-isolation: Share the export-preserving factory, but keep the preparation gate suite-local.
vi.mock("openclaw/plugin-sdk/fetch-runtime", effectGate.mockRuntime);

const { resolvePinnedHostnameWithPolicyMock } = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicyMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: (...args: unknown[]) =>
    resolvePinnedHostnameWithPolicyMock(...args),
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

const ZALO_JSON_CAP_BYTES = 16 * 1024 * 1024;

function oversizedZaloJsonResponse(onCancel: () => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(ZALO_JSON_CAP_BYTES + 1));
      },
      cancel: onCancel,
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

function signalAbortedZaloJsonResponse(signal: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const abortBody = () => {
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

function createOkFetcher() {
  return vi.fn<ZaloFetch>(async () => Response.json({ ok: true, result: {} }));
}

const text = { chat_id: "chat-123", text: "hello" };
const photo = (url: string) => ({ chat_id: "chat-123", photo: url });

describe("Zalo API request methods", () => {
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
      const sending = callZaloApi("sendMessage", "test-token", text, {
        fetch,
        assertDirectAdapterHandoff: () => caller.signal.throwIfAborted(),
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await waitForEffectPreparation(preparing.promise, dispatched.promise);
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
    ["   ", "must not be empty"],
    ["file:///tmp/zalo", "must use http:// or https://"],
    ["https://proxy.example/zalo#provider", "must not include a query string or fragment"],
  ])("rejects invalid API root %j", async (apiUrl, expectedError) => {
    vi.stubEnv("ZALO_API_URL", apiUrl);

    await expect(
      callZaloApi("getMe", "test-token", undefined, { fetch: createOkFetcher() }),
    ).rejects.toThrow(`ZALO_API_URL ${expectedError}.`);
  });

  it.each([getWebhookInfo, deleteWebhook])("uses JSON POST for %s", async (run) => {
    const fetcher = createOkFetcher();
    await run("test-token", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it.each(["body", "photo"] as const)(
    "keeps the %s deadline active until completion",
    async (kind) => {
      vi.useFakeTimers();
      try {
        let requestSignal: AbortSignal | undefined;
        const fetcher = vi.fn<ZaloFetch>(async (_input, init) => {
          const signal = expectDefined(init?.signal, "Zalo request abort signal");
          requestSignal = signal;
          return signalAbortedZaloJsonResponse(signal);
        });
        const promise =
          kind === "body"
            ? sendMessage("test-token", text, fetcher)
            : sendPhoto("test-token", photo("https://example.com/image.png"), fetcher);
        const rejected = expect(promise).rejects.toThrow("zalo body aborted");
        await vi.advanceTimersByTimeAsync(ZALO_DEFAULT_REQUEST_TIMEOUT_MS);
        if (kind === "photo") {
          expect(requestSignal?.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(
            ZALO_SEND_PHOTO_REQUEST_TIMEOUT_MS - ZALO_DEFAULT_REQUEST_TIMEOUT_MS,
          );
        }
        await rejected;
        expect(requestSignal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("caps oversized sendChatAction timeouts before scheduling the timer", async () => {
    using setTimeoutMock = vi.spyOn(globalThis, "setTimeout");
    await sendChatAction(
      "test-token",
      { chat_id: "chat-123", action: "typing" },
      createOkFetcher(),
      MAX_TIMER_TIMEOUT_MS + 1_000_000,
    );

    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("keeps getUpdates on the long-poll request timeout", async () => {
    using setTimeoutMock = vi.spyOn(globalThis, "setTimeout");
    const fetcher = createOkFetcher();

    await getUpdates("test-token", { timeout: 45 }, fetcher);

    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 50_000);
    const [, init] = expectDefined(fetcher.mock.calls[0], "Zalo getUpdates request");
    expect(init?.body).toBe(JSON.stringify({ timeout: "45" }));
  });

  it("blocks private-network photo URLs before they reach the Zalo API", async () => {
    const fetcher = createOkFetcher();
    resolvePinnedHostnameWithPolicyMock.mockRejectedValueOnce(
      new Error("Blocked hostname or private/internal/special-use IP address"),
    );

    await expect(
      sendPhoto(
        "test-token",
        photo("http://169.254.169.254/latest/meta-data/iam/security-credentials/"),
        fetcher,
      ),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["file:///etc/passwd", "Zalo photo URL must use HTTP or HTTPS"],
    ["not a url", "Zalo photo URL must be an absolute HTTP or HTTPS URL"],
  ])("rejects invalid photo URL %j", async (photoUrl, expectedError) => {
    const fetcher = createOkFetcher();

    await expect(sendPhoto("test-token", photo(photoUrl), fetcher)).rejects.toThrow(expectedError);

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
