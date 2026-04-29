import { describe, expect, it, vi } from "vitest";
import { createDiscordRequestClient, DISCORD_REST_TIMEOUT_MS } from "./proxy-request-client.js";

describe("createDiscordRequestClient", () => {
  it("preserves the REST client's abort signal for proxied fetch calls", async () => {
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      expect(init!.signal!.aborted).toBe(false);
      return new Response(JSON.stringify([]), { status: 200 });
    });

    const client = createDiscordRequestClient("Bot test-token", {
      fetch: fetchSpy as never,
      queueRequests: false,
    });

    await client.get("/channels/123/messages");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("lets the REST client abort hanging proxied requests after its timeout", async () => {
    const fetchSpy = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const client = createDiscordRequestClient("Bot test-token", {
      fetch: fetchSpy as never,
      queueRequests: false,
      timeout: 20,
    });

    await expect(client.get("/channels/123/messages")).rejects.toThrow();
  }, 1_000);

  it("lets abortAllRequests cancel active proxied fetches", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchSpy = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const client = createDiscordRequestClient("Bot test-token", {
      fetch: fetchSpy as never,
      queueRequests: false,
      timeout: 5_000,
    });

    const request = client.get("/channels/123/messages");
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    client.abortAllRequests();

    await expect(request).rejects.toThrow();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("provides the REST client's timeout signal even without a caller signal", async () => {
    let receivedSignal: AbortSignal | undefined;

    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const client = createDiscordRequestClient("Bot test-token", {
      fetch: fetchSpy as never,
      queueRequests: false,
    });

    await client.get("/channels/123/messages");

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);
  });

  it("exports a reasonable timeout constant", () => {
    expect(DISCORD_REST_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(DISCORD_REST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
