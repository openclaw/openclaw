import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "./channel.js";

vi.mock("openclaw/plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk")>();
  return {
    ...actual,
    loadOrCreateDeviceIdentity: () => ({
      deviceId: "openclaw-instance-1",
      publicKeyPem: "test",
      privateKeyPem: "test",
    }),
  };
});

const originalFetch = globalThis.fetch;
const REGISTER_KEY = "test-register-key";
const RUNTIME_TOKEN = "runtime-token-1";

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
            registerKey: REGISTER_KEY,
            inboundUrl: "http://openclaw.local/v1/mux/inbound",
          },
        },
      },
    },
  };
}

function resolveFetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("whatsapp extension mux outbound sendPayload", () => {
  it("passes channelData and mediaUrls through mux", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      return jsonResponse({ messageId: "mx-wa-1", toJid: "jid-1" });
    });
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
    // register call + single send (mediaUrls passed as array) = 2 calls
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      channel?: string;
      sessionKey?: string;
      mediaUrl?: string;
      channelData?: Record<string, unknown>;
      raw?: Record<string, unknown>;
    };
    expect(body.channel).toBe("whatsapp");
    expect(body.sessionKey).toBe("sess-wa");
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
