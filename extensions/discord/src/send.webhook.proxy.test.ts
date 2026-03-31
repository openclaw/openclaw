import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { sendWebhookMessageDiscord } from "./send.outbound.js";

const makeProxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/infra-runtime")>();
  return {
    ...actual,
    makeProxyFetch: makeProxyFetchMock,
  };
});

describe("sendWebhookMessageDiscord proxy support", () => {
  it("uses proxy fetch when a Discord proxy is configured", async () => {
    const proxiedFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: "msg-1" }), { status: 200 }));
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

    expect(globalFetchMock).toHaveBeenCalledOnce();
    globalFetchMock.mockRestore();
  });
});
