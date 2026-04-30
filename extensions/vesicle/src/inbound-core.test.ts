import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { describe, expect, it, vi } from "vitest";
import { handleVesicleInboundMessage } from "./inbound-core.js";
import type { ResolvedVesicleAccount } from "./types.js";

const cfg = {
  channels: {
    vesicle: {
      serverUrl: "http://127.0.0.1:1234",
      authToken: "token",
    },
  },
} as OpenClawConfig;

const account: ResolvedVesicleAccount = {
  accountId: "default",
  enabled: true,
  configured: true,
  baseUrl: "http://127.0.0.1:1234",
  config: {
    serverUrl: "http://127.0.0.1:1234",
    authToken: "token",
    dmPolicy: "allowlist",
    allowFrom: ["+15551234567"],
  },
};

describe("handleVesicleInboundMessage", () => {
  it("routes direct messages through the native chat GUID target and sends replies there", async () => {
    const runtime = createPluginRuntimeMock();
    const sendText = vi.fn(async () => undefined);
    const dispatchMock = vi.fn(
      async (params: Parameters<typeof dispatchInboundReplyWithBase>[0]) => {
        await params.deliver({ text: "pong" });
      },
    );
    const dispatch = dispatchMock as unknown as typeof dispatchInboundReplyWithBase;

    await handleVesicleInboundMessage({
      account,
      config: cfg,
      runtime,
      dispatchInboundReplyWithBase: dispatch,
      sendText,
      message: {
        messageGuid: "msg-1",
        chatGuid: "iMessage;-;+15551234567",
        sender: "+15551234567",
        text: "ping",
        date: 1_777_000_000,
      },
    });

    expect(runtime.channel.routing.resolveAgentRoute).toHaveBeenCalledWith({
      cfg,
      channel: "vesicle",
      accountId: "default",
      peer: {
        kind: "direct",
        id: "+15551234567",
      },
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock.mock.calls[0]?.[0].ctxPayload).toMatchObject({
      BodyForAgent: "ping",
      To: "chat_guid:iMessage;-;+15551234567",
      From: "vesicle:+15551234567",
      ChatType: "direct",
      MessageSid: "msg-1",
      Timestamp: 1_777_000_000_000,
    });
    expect(sendText).toHaveBeenCalledWith({
      to: "chat_guid:iMessage;-;+15551234567",
      text: "pong",
    });
  });

  it("drops direct messages from senders outside the allowlist", async () => {
    const dispatchMock = vi.fn();
    const dispatch = dispatchMock as unknown as typeof dispatchInboundReplyWithBase;

    await handleVesicleInboundMessage({
      account: {
        ...account,
        config: {
          ...account.config,
          dmPolicy: "allowlist",
          allowFrom: ["+15550001111"],
        },
      },
      config: cfg,
      runtime: createPluginRuntimeMock(),
      dispatchInboundReplyWithBase: dispatch,
      sendText: vi.fn(),
      message: {
        messageGuid: "msg-1",
        chatGuid: "iMessage;-;+15551234567",
        sender: "+15551234567",
        text: "ping",
      },
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("allows direct messages from configured senders", async () => {
    const dispatchMock = vi.fn(async () => undefined);
    const dispatch = dispatchMock as unknown as typeof dispatchInboundReplyWithBase;

    await handleVesicleInboundMessage({
      account: {
        ...account,
        config: {
          ...account.config,
          dmPolicy: "allowlist",
          allowFrom: ["+15551234567"],
        },
      },
      config: cfg,
      runtime: createPluginRuntimeMock(),
      dispatchInboundReplyWithBase: dispatch,
      sendText: vi.fn(),
      message: {
        messageGuid: "msg-1",
        chatGuid: "iMessage;-;+15551234567",
        sender: "+15551234567",
        text: "ping",
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("allows group messages when the chat GUID is allowlisted", async () => {
    const dispatchMock = vi.fn(async () => undefined);
    const dispatch = dispatchMock as unknown as typeof dispatchInboundReplyWithBase;
    const chatGuid = "any;+;group-123";

    await handleVesicleInboundMessage({
      account: {
        ...account,
        config: {
          ...account.config,
          groupPolicy: "allowlist",
          groupAllowFrom: [chatGuid],
        },
      },
      config: cfg,
      runtime: createPluginRuntimeMock(),
      dispatchInboundReplyWithBase: dispatch,
      sendText: vi.fn(),
      message: {
        messageGuid: "msg-1",
        chatGuid,
        isGroup: true,
        sender: "+15551234567",
        text: "@openclaw ping",
      },
    });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("drops group messages when neither sender nor chat is allowlisted", async () => {
    const dispatchMock = vi.fn();
    const dispatch = dispatchMock as unknown as typeof dispatchInboundReplyWithBase;

    await handleVesicleInboundMessage({
      account: {
        ...account,
        config: {
          ...account.config,
          groupPolicy: "allowlist",
          groupAllowFrom: ["other-group"],
        },
      },
      config: cfg,
      runtime: createPluginRuntimeMock(),
      dispatchInboundReplyWithBase: dispatch,
      sendText: vi.fn(),
      message: {
        messageGuid: "msg-1",
        chatGuid: "any;+;group-123",
        isGroup: true,
        sender: "+15551234567",
        text: "@openclaw ping",
      },
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("drops messages sent by the local Vesicle account", async () => {
    const dispatchMock = vi.fn();
    const dispatch = dispatchMock as unknown as typeof dispatchInboundReplyWithBase;

    await handleVesicleInboundMessage({
      account,
      config: cfg,
      runtime: createPluginRuntimeMock(),
      dispatchInboundReplyWithBase: dispatch,
      sendText: vi.fn(),
      message: {
        messageGuid: "msg-1",
        chatGuid: "iMessage;-;+15551234567",
        sender: "+15551234567",
        text: "ping",
        isFromMe: true,
      },
    });

    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
