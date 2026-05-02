import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendWebhookMessageDiscord } from "./send.webhook.js";

const { envProxyAgentCtor, makeProxyFetchMock, proxyAgentCtor, undiciFetchMock } = vi.hoisted(
  () => ({
    envProxyAgentCtor: vi.fn(),
    makeProxyFetchMock: vi.fn(),
    proxyAgentCtor: vi.fn(),
    undiciFetchMock: vi.fn(),
  }),
);

vi.mock("undici", () => {
  class Agent {
    async destroy() {}
  }
  class EnvHttpProxyAgent {
    constructor(options?: Record<string, unknown>) {
      envProxyAgentCtor(options);
    }
    async destroy() {}
  }
  class ProxyAgent {
    constructor(options?: Record<string, unknown> | string) {
      proxyAgentCtor(options);
    }
    async destroy() {}
  }
  return {
    Agent,
    EnvHttpProxyAgent,
    ProxyAgent,
    fetch: undiciFetchMock,
  };
});

vi.mock("openclaw/plugin-sdk/fetch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/fetch-runtime")>(
    "openclaw/plugin-sdk/fetch-runtime",
  );
  return {
    ...actual,
    makeProxyFetch: makeProxyFetchMock,
  };
});

describe("sendWebhookMessageDiscord proxy support", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const key of [
      "OPENCLAW_DEBUG_PROXY_ENABLED",
      "OPENCLAW_DEBUG_PROXY_URL",
      "OPENCLAW_PROXY_URL",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
    ]) {
      vi.stubEnv(key, undefined);
    }
    envProxyAgentCtor.mockClear();
    makeProxyFetchMock.mockReset();
    proxyAgentCtor.mockClear();
    undiciFetchMock.mockReset();
    vi.restoreAllMocks();
  });

  it("falls back to global fetch when the Discord proxy URL is invalid", async () => {
    makeProxyFetchMock.mockImplementation(() => {
      throw new Error("bad proxy");
    });
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-0" }), { status: 200 }));

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "bad-proxy",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(makeProxyFetchMock).not.toHaveBeenCalledWith("bad-proxy");
    expect(globalFetchMock).toHaveBeenCalled();
    globalFetchMock.mockRestore();
  });

  it("uses proxy fetch when a Discord proxy is configured", async () => {
    const proxiedFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }));
    makeProxyFetchMock.mockReturnValue(proxiedFetch);

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://127.0.0.1:8080",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://127.0.0.1:8080");
    expect(proxiedFetch).toHaveBeenCalledOnce();
  });

  it("uses proxy fetch when the Discord proxy URL is remote", async () => {
    const proxiedFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-remote" }), { status: 200 }));
    makeProxyFetchMock.mockReturnValue(proxiedFetch);

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
          proxy: "http://proxy.test:8080",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(proxiedFetch).toHaveBeenCalledOnce();
  });

  it("uses managed OPENCLAW_PROXY_URL when no Discord proxy is configured", async () => {
    vi.stubEnv("OPENCLAW_PROXY_URL", "http://proxy.test:8080");
    undiciFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "msg-managed" }), {
        status: 200,
      }),
    );

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(proxyAgentCtor).toHaveBeenCalledWith(
      expect.objectContaining({ uri: "http://proxy.test:8080" }),
    );
    expect(undiciFetchMock).toHaveBeenCalledOnce();
  });

  it("uses global fetch when no proxy is configured", async () => {
    makeProxyFetchMock.mockReturnValue(undefined);
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-2" }), { status: 200 }));

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    await sendWebhookMessageDiscord("hello", {
      cfg,
      accountId: "default",
      webhookId: "123",
      webhookToken: "abc",
      wait: true,
    });

    expect(globalFetchMock).toHaveBeenCalled();
    globalFetchMock.mockRestore();
  });

  it("throws typed rate limit errors for webhook 429 responses", async () => {
    const globalFetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Slow down", retry_after: 0.25, global: false }), {
        status: 429,
      }),
    );

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    await expect(
      sendWebhookMessageDiscord("hello", {
        cfg,
        accountId: "default",
        webhookId: "123",
        webhookToken: "abc",
        wait: true,
      }),
    ).rejects.toMatchObject({
      name: "RateLimitError",
      status: 429,
      retryAfter: 0.25,
    });
    globalFetchMock.mockRestore();
  });

  it("throws typed status errors for webhook server failures", async () => {
    const globalFetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("upstream unavailable", { status: 503 }));

    const cfg = {
      channels: {
        discord: {
          token: "Bot test-token",
        },
      },
    } as OpenClawConfig;

    await expect(
      sendWebhookMessageDiscord("hello", {
        cfg,
        accountId: "default",
        webhookId: "123",
        webhookToken: "abc",
        wait: true,
      }),
    ).rejects.toMatchObject({
      name: "DiscordError",
      status: 503,
    });
    globalFetchMock.mockRestore();
  });
});
