import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import { sendMessageMattermost } from "./send.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let currentConfig: OpenClawConfig = {};
const recordActivity = vi.fn();

const runtimeStub = {
  config: {
    loadConfig: () => currentConfig,
  },
  logging: {
    getChildLogger: () => ({
      debug: vi.fn(),
    }),
    shouldLogVerbose: () => false,
  },
  media: {
    loadWebMedia: vi.fn(),
  },
  channel: {
    text: {
      resolveMarkdownTableMode: () => "off",
      convertMarkdownTables: (text: string) => text,
    },
    activity: {
      record: recordActivity,
    },
  },
} as unknown as PluginRuntime;

describe("sendMessageMattermost target resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMattermostRuntime(runtimeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves channel:<name> via team channel lookup before posting", async () => {
    currentConfig = {
      channels: {
        mattermost: {
          enabled: true,
          botToken: "token-name-lookup",
          baseUrl: "https://chat.example.com",
        },
      },
    };

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v4/users/me/teams") {
        return jsonResponse([{ id: "team-1" }]);
      }
      if (url.pathname === "/api/v4/teams/team-1/channels/name/private-notes") {
        return jsonResponse({ id: "uzuybrkzk3y3fjr9ufgcdumtzy", name: "private-notes" });
      }
      if (url.pathname === "/api/v4/posts") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          channel_id?: string;
          message?: string;
        };
        expect(body.channel_id).toBe("uzuybrkzk3y3fjr9ufgcdumtzy");
        expect(body.message).toBe("hello from test");
        return jsonResponse({ id: "post-1", channel_id: body.channel_id });
      }
      throw new Error(`Unexpected fetch URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await sendMessageMattermost("channel:private-notes", "hello from test");
    expect(result).toEqual({
      messageId: "post-1",
      channelId: "uzuybrkzk3y3fjr9ufgcdumtzy",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps id-like channel targets as direct ids", async () => {
    currentConfig = {
      channels: {
        mattermost: {
          enabled: true,
          botToken: "token-id-direct",
          baseUrl: "https://chat.example.com",
        },
      },
    };

    const targetId = "jr5g74ppopgwpkymb45u57myxe";
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v4/posts") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { channel_id?: string };
        expect(body.channel_id).toBe(targetId);
        return jsonResponse({ id: "post-2", channel_id: targetId });
      }
      throw new Error(`Unexpected fetch URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const result = await sendMessageMattermost(targetId, "id route");
    expect(result.channelId).toBe(targetId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a clear error when channel name cannot be resolved", async () => {
    currentConfig = {
      channels: {
        mattermost: {
          enabled: true,
          botToken: "token-missing-name",
          baseUrl: "https://chat.example.com",
        },
      },
    };

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v4/users/me/teams") {
        return jsonResponse([{ id: "team-1" }]);
      }
      if (url.pathname === "/api/v4/teams/team-1/channels/name/not-found") {
        return jsonResponse(
          {
            id: "app.channel.get_by_name.missing.app_error",
            message: "Channel does not exist.",
            status_code: 404,
          },
          404,
        );
      }
      throw new Error(`Unexpected fetch URL: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(sendMessageMattermost("not-found", "hello")).rejects.toThrow(
      'Mattermost channel "not-found" was not found for this bot account.',
    );
  });
});
