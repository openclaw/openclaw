import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "./channel.js";

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

describe("discord extension mux outbound sendPayload", () => {
  it("passes channelData through mux", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      return jsonResponse({ messageId: "mx-discord-1", channelId: "dc-channel-1" });
    });
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
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
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
