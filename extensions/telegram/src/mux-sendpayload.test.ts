import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";

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

describe("telegram extension mux outbound sendPayload", () => {
  it("telegram sendPayload passes channelData through mux", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      return jsonResponse({ messageId: "mx-tg-1", chatId: "tg-chat-1" });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...baseMuxGatewayConfig(),
      channels: {
        telegram: {
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

    const result = await telegramPlugin.outbound?.sendPayload?.({
      cfg,
      to: "telegram:123",
      text: "ignored",
      accountId: "mux",
      sessionKey: "sess-tg",
      payload: {
        text: "hello",
        channelData: {
          telegram: {
            buttons: [[{ text: "Next", callback_data: "commands_page_2:main" }]],
          },
        },
      },
    });

    expect(result).toMatchObject({ channel: "telegram", messageId: "mx-tg-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      channel?: string;
      sessionKey?: string;
      channelData?: Record<string, unknown>;
    };
    expect(body.channel).toBe("telegram");
    expect(body.sessionKey).toBe("sess-tg");
    expect(body.channelData).toEqual({
      telegram: {
        buttons: [[{ text: "Next", callback_data: "commands_page_2:main" }]],
      },
    });
  });
});
