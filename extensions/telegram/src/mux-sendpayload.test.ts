import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "./channel.js";

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

describe("telegram extension mux outbound sendPayload", () => {
  it("telegram sendPayload passes channelData through mux", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ messageId: "mx-tg-1", chatId: "tg-chat-1" }));
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
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
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
