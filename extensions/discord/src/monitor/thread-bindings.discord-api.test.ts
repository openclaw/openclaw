import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const hoisted = vi.hoisted(() => {
  const restGet = vi.fn();
  const sendMessageDiscord = vi.fn();
  const sendWebhookMessageDiscord = vi.fn();
  const createDiscordRestClient = vi.fn(() => ({
    rest: {
      get: restGet,
    },
  }));
  return {
    restGet,
    sendMessageDiscord,
    sendWebhookMessageDiscord,
    createDiscordRestClient,
  };
});

vi.mock("../client.js", () => ({
  createDiscordRestClient: hoisted.createDiscordRestClient,
}));

vi.mock("../send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => hoisted.sendMessageDiscord(...args),
  sendWebhookMessageDiscord: (...args: unknown[]) => hoisted.sendWebhookMessageDiscord(...args),
}));

const { maybeSendBindingMessage, resolveChannelIdForBinding } =
  await import("./thread-bindings.discord-api.js");

describe("resolveChannelIdForBinding", () => {
  beforeEach(() => {
    hoisted.restGet.mockClear();
    hoisted.createDiscordRestClient.mockClear();
    hoisted.sendMessageDiscord.mockClear().mockResolvedValue({});
    hoisted.sendWebhookMessageDiscord.mockClear().mockResolvedValue({});
  });

  it("returns explicit channelId without resolving route", async () => {
    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "thread-1",
      channelId: "channel-explicit",
    });

    expect(resolved).toBe("channel-explicit");
    expect(hoisted.createDiscordRestClient).not.toHaveBeenCalled();
    expect(hoisted.restGet).not.toHaveBeenCalled();
  });

  it("returns parent channel for thread channels", async () => {
    hoisted.restGet.mockResolvedValueOnce({
      id: "thread-1",
      type: ChannelType.PublicThread,
      parent_id: "channel-parent",
    });

    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "thread-1",
    });

    expect(resolved).toBe("channel-parent");
  });

  it("forwards cfg when resolving channel id through Discord client", async () => {
    const cfg = {
      channels: { discord: { token: "tok" } },
    } as OpenClawConfig;
    hoisted.restGet.mockResolvedValueOnce({
      id: "thread-1",
      type: ChannelType.PublicThread,
      parent_id: "channel-parent",
    });

    await resolveChannelIdForBinding({
      cfg,
      accountId: "default",
      threadId: "thread-1",
    });

    const createDiscordRestClientCalls = hoisted.createDiscordRestClient.mock.calls as unknown[][];
    expect(createDiscordRestClientCalls[0]?.[1]).toBe(cfg);
  });

  it("keeps non-thread channel id even when parent_id exists", async () => {
    hoisted.restGet.mockResolvedValueOnce({
      id: "channel-text",
      type: ChannelType.GuildText,
      parent_id: "category-1",
    });

    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "channel-text",
    });

    expect(resolved).toBe("channel-text");
  });

  it("keeps forum channel id instead of parent category", async () => {
    hoisted.restGet.mockResolvedValueOnce({
      id: "forum-1",
      type: ChannelType.GuildForum,
      parent_id: "category-1",
    });

    const resolved = await resolveChannelIdForBinding({
      accountId: "default",
      threadId: "forum-1",
    });

    expect(resolved).toBe("forum-1");
  });
});

describe("maybeSendBindingMessage", () => {
  beforeEach(() => {
    hoisted.sendMessageDiscord.mockClear().mockResolvedValue({});
    hoisted.sendWebhookMessageDiscord.mockClear().mockResolvedValue({});
  });

  it("forwards cfg to webhook send path", async () => {
    const cfg = {
      channels: { discord: { token: "tok" } },
    } as OpenClawConfig;
    const record = {
      accountId: "default",
      channelId: "parent-1",
      threadId: "thread-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:test",
      agentId: "main",
      boundBy: "test",
      boundAt: Date.now(),
      lastActivityAt: Date.now(),
      webhookId: "wh_1",
      webhookToken: "tok_1",
    } satisfies ThreadBindingRecord;

    await maybeSendBindingMessage({
      cfg,
      record,
      text: "hello webhook",
    });

    expect(hoisted.sendWebhookMessageDiscord).toHaveBeenCalledTimes(1);
    expect(hoisted.sendWebhookMessageDiscord.mock.calls[0]?.[1]).toMatchObject({
      cfg,
      webhookId: "wh_1",
      webhookToken: "tok_1",
      accountId: "default",
      threadId: "thread-1",
    });
    expect(hoisted.sendMessageDiscord).not.toHaveBeenCalled();
  });
});
