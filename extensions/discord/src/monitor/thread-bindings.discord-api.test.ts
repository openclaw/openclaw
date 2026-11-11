import { ChannelType } from "discord-api-types/v10";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as discordRest from "../internal/rest.js";
import * as discordSend from "../send.js";
import { createDiscordSendReceipt } from "../send.receipt.js";
import {
  createWebhookForChannel,
  maybeSendBindingMessage,
  resolveChannelIdForBinding,
} from "./thread-bindings.discord-api.js";
import { resolveThreadBindingPersona } from "./thread-bindings.persona.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

const cfg = { channels: { discord: { token: "synthetic-token" } } };
const account = { cfg, accountId: "default" };
const webhook = { webhookId: "wh-1", webhookToken: "tok-1" };
const revoked = () => {
  throw new Error("Command owner was revoked");
};
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
  const rest = new discordRest.RequestClient("synthetic-token", {
    fetch: async () => {
      throw new Error("Unexpected network request");
    },
  });
  vi.spyOn(discordRest, "RequestClient").mockImplementation(function () {
    return rest;
  });
  return {
    get: vi.spyOn(rest, "get"),
    post: vi.spyOn(rest, "post"),
    bot: vi.spyOn(discordSend, "sendMessageDiscord").mockResolvedValue(sent),
    webhook: vi.spyOn(discordSend, "sendWebhookMessageDiscord").mockResolvedValue(sent),
  };
}
let mocks: ReturnType<typeof fixture>;
beforeEach(() => {
  mocks = fixture();
});
afterEach(() => vi.restoreAllMocks());

it.each([
  [
    { id: " wh1 ", token: " token1 " },
    { webhookId: "wh1", webhookToken: "token1" },
  ],
  [null, {}],
  [[], {}],
  [{ id: "wh1" }, {}],
  [{ id: 1, token: "token1" }, {}],
])("creates binding webhooks from the Discord response %j", async (response, expected) => {
  mocks.post.mockResolvedValueOnce(response);
  expect(await createWebhookForChannel({ ...account, channelId: "c1" })).toEqual(expected);
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/channels/c1/webhooks", {
    body: { name: "OpenClaw Agents" },
  });
});

it("blocks revoked webhook creation before posting", async () => {
  expect(
    await createWebhookForChannel({
      ...account,
      channelId: "c1",
      assertCreateAllowed: revoked,
    }),
  ).toEqual({});
  expect(mocks.post).not.toHaveBeenCalled();
});

it.each([
  ["channel:123456789012345678", "123456789012345678", ChannelType.GuildText],
  ["forum-1", "forum-1", ChannelType.GuildForum],
] as const)(
  "resolves non-thread channel %s without using its category",
  async (threadId, id, type) => {
    mocks.get.mockResolvedValueOnce({ id, type, parent_id: "category-1" });
    expect(await resolveChannelIdForBinding({ ...account, threadId })).toBe(id);
    expect(mocks.get.mock.calls[0]?.[0]).toBe(`/channels/${id}`);
  },
);

it.each([false, true])("blocks revoked binding notices (webhook=%s)", async (useWebhook) => {
  await maybeSendBindingMessage({
    cfg,
    record: { ...record, ...(useWebhook ? webhook : {}) },
    text: "Binding ready",
    assertCurrent: revoked,
  });
  expect(mocks.bot).not.toHaveBeenCalled();
  expect(mocks.webhook).not.toHaveBeenCalled();
});

it("sends the binding notice through its configured webhook with the agent persona", async () => {
  await maybeSendBindingMessage({
    cfg,
    record: { ...record, ...webhook },
    text: "hello webhook",
  });
  expect(mocks.webhook).toHaveBeenCalledExactlyOnceWith("hello webhook", {
    ...account,
    ...webhook,
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
