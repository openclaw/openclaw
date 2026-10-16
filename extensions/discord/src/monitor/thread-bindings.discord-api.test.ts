import { ChannelType } from "discord-api-types/v10";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RequestClient } from "../internal/rest.js";
import * as discordRequestClient from "../proxy-request-client.js";
import * as discordSend from "../send.js";
import { createDiscordSendReceipt } from "../send.receipt.js";
import {
  isDiscordThreadGoneError,
  maybeSendBindingMessage,
  resolveChannelIdForBinding,
} from "./thread-bindings.discord-api.js";
import { resolveThreadBindingPersona } from "./thread-bindings.persona.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const cfg = { channels: { discord: { token: "synthetic-token" } } };
const record: ThreadBindingRecord = {
  accountId: "default",
  channelId: "parent-1",
  threadId: "thread-1",
  targetKind: "subagent",
  targetSessionKey: "agent:main:subagent:test",
  agentId: "main",
  boundBy: "test",
  boundAt: 1,
  lastActivityAt: 1,
};
const sent = {
  messageId: "msg-1",
  channelId: "thread-1",
  receipt: createDiscordSendReceipt({
    platformMessageIds: ["msg-1"],
    channelId: "thread-1",
    kind: "text",
  }),
};
function fixture() {
  const rest = new RequestClient("synthetic-token", {
    fetch: async () => {
      throw new Error("Unexpected network request");
    },
  });
  vi.spyOn(discordRequestClient, "createDiscordRequestClient").mockReturnValue(rest);
  return {
    get: vi.spyOn(rest, "get"),
    bot: vi.spyOn(discordSend, "sendMessageDiscord").mockResolvedValue(sent),
    webhook: vi.spyOn(discordSend, "sendWebhookMessageDiscord").mockResolvedValue(sent),
  };
}
let mocks: ReturnType<typeof fixture>;
beforeEach(() => {
  mocks = fixture();
});
afterEach(() => {
  vi.restoreAllMocks();
});

it("strips the channel prefix before requesting its route", async () => {
  mocks.get.mockResolvedValueOnce({ id: "123456789012345678", type: ChannelType.GuildText });
  expect(
    await resolveChannelIdForBinding({
      cfg,
      accountId: "default",
      threadId: "channel:123456789012345678",
    }),
  ).toBe("123456789012345678");
  expect(mocks.get.mock.calls[0]?.[0]).toBe("/channels/123456789012345678");
});

it("keeps a forum id instead of its parent category", async () => {
  mocks.get.mockResolvedValueOnce({
    id: "forum-1",
    type: ChannelType.GuildForum,
    parent_id: "category-1",
  });
  expect(await resolveChannelIdForBinding({ cfg, accountId: "default", threadId: "forum-1" })).toBe(
    "forum-1",
  );
});

it("rejects fractional Discord status values", () => {
  expect(isDiscordThreadGoneError({ status: 403.5 })).toBe(false);
  expect(isDiscordThreadGoneError({ statusCode: "404.5" })).toBe(false);
  expect(isDiscordThreadGoneError({ statusCode: "+404" })).toBe(true);
});

it.each([false, true])("blocks revoked binding notices (webhook=%s)", async (webhook) => {
  await maybeSendBindingMessage({
    cfg,
    record: { ...record, ...(webhook ? { webhookId: "wh-1", webhookToken: "tok-1" } : {}) },
    text: "Binding ready",
    assertCurrent: () => {
      throw new Error("Command owner was revoked");
    },
  });
  expect(mocks.bot).not.toHaveBeenCalled();
  expect(mocks.webhook).not.toHaveBeenCalled();
});

it("sends the binding notice through its configured webhook with the agent persona", async () => {
  await maybeSendBindingMessage({
    cfg,
    record: { ...record, webhookId: "wh-1", webhookToken: "tok-1" },
    text: "hello webhook",
  });
  expect(mocks.webhook).toHaveBeenCalledExactlyOnceWith("hello webhook", {
    cfg,
    webhookId: "wh-1",
    webhookToken: "tok-1",
    accountId: "default",
    threadId: "thread-1",
    username: "⚙️ main",
  });
  expect(mocks.bot).not.toHaveBeenCalled();
});

it("does not split the persona's surrogate pair at the length limit", () => {
  const prefix = "a".repeat(76);
  expect(resolveThreadBindingPersona({ label: `${prefix}😀tail`, agentId: "codex" })).toBe(
    `⚙️ ${prefix}`,
  );
});
