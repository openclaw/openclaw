import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  DiscordError,
  RateLimitError,
  RequestClient,
  globalFetchMock,
  proxyFetchMock,
  scheduleRateLimitMock,
  updateBucketFromHeadersMock,
  waitForBucketMock,
  makeProxyFetchMock,
} = vi.hoisted(() => {
  const globalFetchMock = vi.fn();
  const proxyFetchMock = vi.fn();
  const scheduleRateLimitMock = vi.fn();
  const updateBucketFromHeadersMock = vi.fn();
  const waitForBucketMock = vi.fn(async (_routeKey: string) => undefined);
  const makeProxyFetchMock = vi.fn(() => proxyFetchMock);

  class DiscordError extends Error {
    status: number;
    discordCode: number | undefined;
    rawBody: unknown;
    constructor(response: Response, body: { message: string; code?: number }) {
      super(body.message);
      this.status = response.status;
      this.discordCode = body.code;
      this.rawBody = body;
    }
  }

  class RateLimitError extends DiscordError {
    retryAfter: number;
    constructor(response: Response, body: { message: string; retry_after: number; code?: number }) {
      super(response, body);
      this.retryAfter = body.retry_after;
    }
  }

  class RequestClient {
    options = {
      baseUrl: "https://discord.com/api/v10",
      tokenHeader: "Bot" as const,
      timeout: 15_000,
    };
    token: string;
    abortController: AbortController | null = null;
    constructor(token: string) {
      this.token = token;
    }
    async waitForBucket(routeKey: string) {
      await waitForBucketMock(routeKey);
    }
    scheduleRateLimit(routeKey: string, path: string, error: unknown) {
      scheduleRateLimitMock(routeKey, path, error);
    }
    updateBucketFromHeaders(routeKey: string, path: string, response: Response) {
      updateBucketFromHeadersMock(routeKey, path, response);
    }
    async executeRequest(_request: unknown) {
      throw new Error("unpatched");
    }
    async get(path: string) {
      return await this.executeRequest({
        method: "GET",
        path,
        routeKey: `GET ${path}`,
        resolve: vi.fn(),
        reject: vi.fn(),
      });
    }
    async put(path: string, data?: { body?: unknown }) {
      return await this.executeRequest({
        method: "PUT",
        path,
        data,
        routeKey: `PUT ${path}`,
        resolve: vi.fn(),
        reject: vi.fn(),
      });
    }
  }

  return {
    DiscordError,
    RateLimitError,
    RequestClient,
    globalFetchMock,
    makeProxyFetchMock,
    proxyFetchMock,
    scheduleRateLimitMock,
    updateBucketFromHeadersMock,
    waitForBucketMock,
  };
});

vi.mock("@buape/carbon", () => ({
  DiscordError,
  RateLimitError,
  RequestClient,
}));

vi.mock("../../../src/infra/net/proxy-fetch.js", () => ({
  makeProxyFetch: makeProxyFetchMock,
}));

vi.mock("../../../src/infra/fetch.js", () => ({
  wrapFetchWithAbortSignal: (fetchImpl: typeof fetch) => fetchImpl,
}));

describe("carbon rest proxy", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", globalFetchMock);
    globalFetchMock.mockReset();
    makeProxyFetchMock.mockClear().mockReturnValue(proxyFetchMock);
    proxyFetchMock.mockReset();
    scheduleRateLimitMock.mockReset();
    updateBucketFromHeadersMock.mockReset();
    waitForBucketMock.mockReset();
  });

  it("routes Carbon request client calls through the provided fetch", async () => {
    const { attachFetchToCarbonRequestClient } = await import("./carbon-rest-proxy.js");
    const rest = new RequestClient("token-123");
    proxyFetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ id: "user-1" }),
    } as Response);

    attachFetchToCarbonRequestClient(
      rest as unknown as Parameters<typeof attachFetchToCarbonRequestClient>[0],
      proxyFetchMock as unknown as typeof fetch,
    );
    const result = await rest.get("/users/@me");

    expect(result).toEqual({ id: "user-1" });
    expect(proxyFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const headers = proxyFetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bot token-123");
    expect(globalFetchMock).not.toHaveBeenCalled();
    expect(updateBucketFromHeadersMock).toHaveBeenCalledWith(
      "GET /users/@me",
      "/users/@me",
      expect.anything(),
    );
  });

  it("preserves RateLimitError handling for proxied requests", async () => {
    const { attachFetchToCarbonRequestClient } = await import("./carbon-rest-proxy.js");
    const rest = new RequestClient("token-123");
    proxyFetchMock.mockResolvedValue({
      status: 429,
      headers: new Headers(),
      text: async () => JSON.stringify({ message: "slow down", retry_after: 0.5 }),
    } as Response);

    attachFetchToCarbonRequestClient(
      rest as unknown as Parameters<typeof attachFetchToCarbonRequestClient>[0],
      proxyFetchMock as unknown as typeof fetch,
    );

    await expect(rest.put("/applications/app-id/commands", { body: [] })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(scheduleRateLimitMock).toHaveBeenCalledWith(
      "PUT /applications/app-id/commands",
      "/applications/app-id/commands",
      expect.any(RateLimitError),
    );
  });

  it("keeps empty files payloads on the JSON request path", async () => {
    const { attachFetchToCarbonRequestClient } = await import("./carbon-rest-proxy.js");
    const rest = new RequestClient("token-123");
    proxyFetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ ok: true }),
    } as Response);

    attachFetchToCarbonRequestClient(
      rest as unknown as Parameters<typeof attachFetchToCarbonRequestClient>[0],
      proxyFetchMock as unknown as typeof fetch,
    );
    await rest.put("/channels/123/messages", { body: { content: "hello", files: [] } });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/123/messages",
      expect.objectContaining({
        body: JSON.stringify({ content: "hello", files: [] }),
      }),
    );
    const headers = proxyFetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("serializes nested data.files payloads without flattening interaction callback bodies", async () => {
    const { attachFetchToCarbonRequestClient } = await import("./carbon-rest-proxy.js");
    const rest = new RequestClient("token-123");
    proxyFetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ ok: true }),
    } as Response);

    attachFetchToCarbonRequestClient(
      rest as unknown as Parameters<typeof attachFetchToCarbonRequestClient>[0],
      proxyFetchMock as unknown as typeof fetch,
    );
    await rest.put("/channels/123/messages", {
      body: {
        type: 4,
        data: {
          content: "hello",
          files: [{ data: "test payload", name: "hello.txt" }],
        },
      },
    });

    const requestBody = proxyFetchMock.mock.calls[0]?.[1]?.body;
    expect(requestBody).toBeInstanceOf(FormData);
    const formData = requestBody as FormData;
    expect(formData.get("payload_json")).toBe(
      JSON.stringify({
        type: 4,
        data: {
          content: "hello",
          attachments: [{ id: 0, filename: "hello.txt", description: undefined }],
        },
      }),
    );
  });

  it("preserves contentType as Blob MIME type in multipart file uploads", async () => {
    const { attachFetchToCarbonRequestClient } = await import("./carbon-rest-proxy.js");
    const rest = new RequestClient("token-123");
    proxyFetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ ok: true }),
    } as Response);

    attachFetchToCarbonRequestClient(
      rest as unknown as Parameters<typeof attachFetchToCarbonRequestClient>[0],
      proxyFetchMock as unknown as typeof fetch,
    );
    await rest.put("/guilds/123/stickers", {
      body: {
        name: "test",
        files: [{ data: new Uint8Array([1, 2, 3]), name: "sticker", contentType: "image/png" }],
      },
    });

    const requestBody = proxyFetchMock.mock.calls[0]?.[1]?.body;
    expect(requestBody).toBeInstanceOf(FormData);
    const formData = requestBody as FormData;
    const fileEntry = formData.get("files[0]");
    expect(fileEntry).toBeInstanceOf(Blob);
    expect((fileEntry as Blob).type).toBe("image/png");
  });

  it("falls back to the unpatched request client when the proxy URL is malformed", async () => {
    const { attachProxyToCarbonRequestClient } = await import("./carbon-rest-proxy.js");
    const rest = new RequestClient("token-123");

    const result = attachProxyToCarbonRequestClient(
      rest as unknown as Parameters<typeof attachProxyToCarbonRequestClient>[0],
      "bad-proxy",
    );

    expect(result).toBe(rest);
    expect(makeProxyFetchMock).not.toHaveBeenCalled();
    await expect(rest.get("/users/@me")).rejects.toThrow("unpatched");
  });

  it("falls back to the unpatched request client when the proxy protocol is unsupported", async () => {
    const { attachProxyToCarbonRequestClient } = await import("./carbon-rest-proxy.js");
    const rest = new RequestClient("token-123");

    const result = attachProxyToCarbonRequestClient(
      rest as unknown as Parameters<typeof attachProxyToCarbonRequestClient>[0],
      "socks5://127.0.0.1:1080",
    );

    expect(result).toBe(rest);
    expect(makeProxyFetchMock).not.toHaveBeenCalled();
    await expect(rest.get("/users/@me")).rejects.toThrow("unpatched");
  });
});
