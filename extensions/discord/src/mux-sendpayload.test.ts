import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "./channel.js";

const originalFetch = globalThis.fetch;
const TENANT_TOKEN = "tenant-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function baseMuxGatewayConfig(): Pick<OpenClawConfig, "gateway"> {
  return {
    gateway: {
      http: {
        endpoints: {
          mux: {
            baseUrl: "http://mux.local",
            token: TENANT_TOKEN,
          },
        },
      },
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("discord extension mux outbound sendPayload", () => {
  it("passes channelData through mux", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ messageId: "mx-discord-1", channelId: "dc-channel-1" }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...baseMuxGatewayConfig(),
      channels: {
        discord: {
          accounts: {
            mux: {
              mux: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = await discordPlugin.outbound?.sendPayload?.({
      cfg,
      to: "channel:123",
      text: "ignored",
      accountId: "mux",
      sessionKey: "sess-discord",
      payload: {
        text: "hello",
        channelData: {
          raw: {
            discord: {
              body: { content: "hello" },
            },
          },
        },
      },
    });

    expect(result).toMatchObject({ channel: "discord", messageId: "mx-discord-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      channel?: string;
      sessionKey?: string;
      channelData?: Record<string, unknown>;
      raw?: Record<string, unknown>;
    };
    expect(body.channel).toBe("discord");
    expect(body.sessionKey).toBe("sess-discord");
    expect(body.channelData).toEqual({
      raw: {
        discord: {
          body: { content: "hello" },
        },
      },
    });
    expect(body.raw).toEqual({
      discord: {
        body: { content: "hello" },
      },
    });
  });
});
