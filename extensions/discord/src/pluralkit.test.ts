import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { fetchPluralKitMessageInfo } from "./pluralkit.js";

function lookup(
  fetcher: typeof fetch,
  options: Partial<Parameters<typeof fetchPluralKitMessageInfo>[0]> = {},
) {
  return fetchPluralKitMessageInfo({
    messageId: "123",
    config: { enabled: true },
    ...options,
    fetcher,
  });
}

const rejection = (pending: Promise<unknown>) =>
  pending.then(
    () => undefined,
    (error: unknown) => {
      if (!(error instanceof Error)) {
        throw error;
      }
      return error;
    },
  );

afterEach(() => vi.useRealTimers());

describe("fetchPluralKitMessageInfo", () => {
  it("returns null when disabled", async () => {
    const fetcher = vi.fn();
    const result = await lookup(fetcher, { config: { enabled: false } });
    expect(result).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns null on 404", async () => {
    const tracked = cancelTrackedTextResponse("missing", { status: 404 });
    const fetcher = vi.fn(async () => tracked.response);
    const result = await lookup(fetcher);
    expect(result).toBeNull();
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("returns payload and sends token when configured", async () => {
    let receivedHeaders: Record<string, string> | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      receivedHeaders = init?.headers as Record<string, string> | undefined;
      return Response.json({ member: { id: "mem_1" } });
    });
    const result = await lookup(fetcher, { config: { enabled: true, token: "pk_test" } });
    expect(result?.member?.id).toBe("mem_1");
    expect(receivedHeaders?.Authorization).toBe("pk_test");
  });

  it("aborts PluralKit response body reads that exceed the lookup timeout", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          observedSignal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("PluralKit lookup timed out", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    const lookupPromise = lookup(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(observedSignal?.aborted).toBe(false);
    const lookupRejection = expect(lookupPromise).rejects.toThrow(/timed out|abort/i);
    await vi.advanceTimersByTimeAsync(10_000);
    await lookupRejection;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("relays parent cancellation to the PluralKit request", async () => {
    const parent = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      observedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => {
            const reason = observedSignal?.reason;
            reject(reason instanceof Error ? reason : new Error("PluralKit request aborted"));
          },
          { once: true },
        );
      });
    });
    const lookupPromise = lookup(fetcher, { signal: parent.signal });
    parent.abort(new Error("preflight stopped"));
    await expect(lookupPromise).rejects.toThrow("preflight stopped");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("redacts reflected PluralKit credentials from a real HTTP error body", async () => {
    const uniqueSecret = "pluralkit-loopback-secret";
    const token = `proof-prefix-${uniqueSecret}-proof-suffix`;
    let authorization: string | undefined;
    let requestUrl: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      requestUrl = request.url;
      response.writeHead(502, { "content-type": "text/plain" });
      response.end(`proxy failure Authorization: ${authorization}; request rejected`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an ephemeral loopback address");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return fetch(new URL(`${url.pathname}${url.search}`, origin), init);
    };
    let caught: Error | undefined;
    try {
      caught = await rejection(
        lookup(fetcher, { messageId: "boom", config: { enabled: true, token } }),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) => (closeError ? reject(closeError) : resolve()));
      });
    }
    expect(requestUrl).toBe("/v2/messages/boom");
    expect(authorization).toBe(token);
    expect(caught?.message).toContain("PluralKit API failed (502)");
    expect(caught?.message).toContain("proxy failure");
    expect(caught?.message).toContain("Authorization:");
    expect(caught?.message).not.toContain(token);
    expect(caught?.message).not.toContain(uniqueSecret);
  });

  it("bounds PluralKit API error bodies without using response.text()", async () => {
    const tracked = cancelTrackedTextResponse(`${"plural failure ".repeat(1024)}tail`, {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    const fetcher = vi.fn(async () => tracked.response);
    const caught = await rejection(lookup(fetcher));
    expect(caught?.message).toContain("PluralKit API failed (500): plural failure");
    expect(caught?.message).not.toContain("tail");
    expect(caught?.message.length).toBeLessThan(8_400);
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
