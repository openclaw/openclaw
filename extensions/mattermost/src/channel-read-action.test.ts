// Mattermost tests cover the message read action through the plugin adapter.
import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const { mockFetchGuard } = vi.hoisted(() => ({
  mockFetchGuard: vi.fn(async (p: { url: string; init?: RequestInit }) => {
    const response = await globalThis.fetch(p.url, p.init);
    return { response, release: async () => {}, finalUrl: p.url };
  }),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/ssrf-runtime")) as Record<
    string,
    unknown
  >;
  return { ...original, fetchWithSsrFGuard: mockFetchGuard };
});

import { mattermostPlugin } from "./channel.js";
import {
  createMattermostTestConfig,
  withMockedGlobalFetch,
} from "./mattermost/reactions.test-helpers.js";

type MattermostActionContext = Parameters<
  NonNullable<NonNullable<typeof mattermostPlugin.actions>["handleAction"]>
>[0];

function createMattermostActionContext(
  overrides: Partial<MattermostActionContext>,
): MattermostActionContext {
  return {
    channel: "mattermost",
    action: "read",
    params: {},
    cfg: createMattermostTestConfig(),
    ...overrides,
  };
}

describe("mattermostPlugin read action", () => {
  let readActionSequence = 0;

  it("blocks read when the selected account disables messages", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          actions: { messages: true },
          accounts: {
            default: {
              enabled: true,
              botToken: "test-token-placeholder",
              baseUrl: "https://chat.example.com",
              actions: { messages: false },
            },
          },
        },
      },
    };
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      withMockedGlobalFetch(fetchImpl, async () =>
        mattermostPlugin.actions?.handleAction?.(
          createMattermostActionContext({
            action: "read",
            params: { target: "channel:CURRENT" },
            cfg,
            accountId: "default",
            conversationReadOrigin: "direct-operator",
          }),
        ),
      ),
    ).rejects.toThrow("Mattermost message reads are disabled in config");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks read when actions.messages is not configured", async () => {
    const cfg = createMattermostTestConfig(`read-disabled-${++readActionSequence}`);
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      withMockedGlobalFetch(fetchImpl, async () =>
        mattermostPlugin.actions?.handleAction?.(
          createMattermostActionContext({
            action: "read",
            params: { target: "channel:CURRENT" },
            cfg,
            accountId: "default",
            conversationReadOrigin: "direct-operator",
          }),
        ),
      ),
    ).rejects.toThrow("Mattermost message reads are disabled in config");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads posts into the shared JSON result with normalized timestamps", async () => {
    const cfg = createMattermostTestConfig(`read-action-${++readActionSequence}`);
    const mattermostConfig = cfg.channels?.mattermost;
    if (!mattermostConfig) {
      throw new Error("expected Mattermost config fixture");
    }
    mattermostConfig.actions = { messages: true };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (!url.includes("/api/v4/channels/CURRENT/posts?per_page=2")) {
        throw new Error(`Unexpected Mattermost request: ${url}`);
      }
      return Response.json({
        order: ["post-2", "post-1"],
        posts: {
          "post-1": { id: "post-1", message: "older", create_at: 1_700_000_001_000 },
          "post-2": { id: "post-2", message: "newer", create_at: 1_700_000_002_000 },
        },
      });
    });

    const result = await withMockedGlobalFetch(fetchImpl, async () =>
      mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "read",
          params: { target: "channel:CURRENT", to: "channel:CURRENT", limit: 2 },
          cfg,
          accountId: "default",
          requesterAccountId: "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelProvider: "mattermost",
            currentChannelId: "channel:CURRENT",
          },
        }),
      ),
    );

    expect(result?.details).toMatchObject({
      ok: true,
      channelId: "CURRENT",
      messages: [
        { id: "post-2", message: "newer", timestampMs: 1_700_000_002_000 },
        { id: "post-1", message: "older", timestampMs: 1_700_000_001_000 },
      ],
      hasMore: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reads the exact post named by messageId", async () => {
    const cfg = createMattermostTestConfig(`read-exact-${++readActionSequence}`);
    const mattermostConfig = cfg.channels?.mattermost;
    if (!mattermostConfig) {
      throw new Error("expected Mattermost config fixture");
    }
    mattermostConfig.actions = { messages: true };
    const older = {
      id: "post-1",
      channel_id: "CURRENT",
      message: "older",
      create_at: 1_700_000_001_000,
    };
    const newer = { id: "post-2", channel_id: "CURRENT", message: "newer" };
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/api/v4/channels/CURRENT/posts?per_page=1&after=post-1")) {
        return Response.json({ order: ["post-2"], posts: { "post-2": newer } });
      }
      if (url.includes("/api/v4/channels/CURRENT/posts?per_page=60&before=post-2")) {
        return Response.json({ order: ["post-1"], posts: { "post-1": older } });
      }
      throw new Error(`Unexpected Mattermost request: ${url}`);
    });

    const result = await withMockedGlobalFetch(fetchImpl, async () =>
      mattermostPlugin.actions?.handleAction?.(
        createMattermostActionContext({
          action: "read",
          params: { target: "channel:CURRENT", messageId: "post-1" },
          cfg,
          accountId: "default",
          conversationReadOrigin: "direct-operator",
        }),
      ),
    );

    expect(result?.details).toEqual({
      ok: true,
      channelId: "CURRENT",
      messages: [
        {
          id: "post-1",
          channel_id: "CURRENT",
          message: "older",
          create_at: 1_700_000_001_000,
          timestampMs: 1_700_000_001_000,
          timestampUtc: new Date(1_700_000_001_000).toISOString(),
        },
      ],
      hasMore: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid read cursors and limits before provider access", async () => {
    const cfg = createMattermostTestConfig(`read-validation-${++readActionSequence}`);
    const mattermostConfig = cfg.channels?.mattermost;
    if (!mattermostConfig) {
      throw new Error("expected Mattermost config fixture");
    }
    mattermostConfig.actions = { messages: true };
    const fetchImpl = vi.fn<typeof fetch>();

    for (const params of [
      { target: "channel:CURRENT", before: "p1", after: "p2" },
      { target: "channel:CURRENT", limit: 0 },
    ]) {
      await expect(
        withMockedGlobalFetch(fetchImpl, async () =>
          mattermostPlugin.actions?.handleAction?.(
            createMattermostActionContext({
              action: "read",
              params,
              cfg,
              accountId: "default",
              conversationReadOrigin: "direct-operator",
            }),
          ),
        ),
      ).rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
