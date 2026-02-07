import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "./channel.js";

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

describe("whatsapp extension mux outbound sendPayload", () => {
  it("passes channelData and mediaUrls through mux", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ messageId: "mx-wa-1", toJid: "jid-1" }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...baseMuxGatewayConfig(),
      channels: {
        whatsapp: {
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

    const result = await whatsappPlugin.outbound?.sendPayload?.({
      cfg,
      to: "+15555550100",
      text: "ignored",
      accountId: "mux",
      sessionKey: "sess-wa",
      payload: {
        text: "hello",
        mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
        channelData: {
          raw: {
            whatsapp: {
              body: { text: "hello" },
            },
          },
        },
      },
    });

    expect(result).toMatchObject({ channel: "whatsapp", messageId: "mx-wa-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      channel?: string;
      sessionKey?: string;
      mediaUrls?: string[];
      channelData?: Record<string, unknown>;
      raw?: Record<string, unknown>;
    };
    expect(body.channel).toBe("whatsapp");
    expect(body.sessionKey).toBe("sess-wa");
    expect(body.mediaUrls).toEqual(["https://example.com/a.jpg", "https://example.com/b.jpg"]);
    expect(body.channelData).toEqual({
      raw: {
        whatsapp: {
          body: { text: "hello" },
        },
      },
    });
    expect(body.raw).toEqual({
      whatsapp: {
        body: { text: "hello" },
      },
    });
  });
});
