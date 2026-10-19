import assert from "node:assert/strict";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendAdaptiveCardMSTeams: vi.fn(),
  sendMessageMSTeams: vi.fn(),
  sendPollMSTeams: vi.fn(),
  createPoll: vi.fn(),
  createMSTeamsPollStoreState: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendAdaptiveCardMSTeams: mocks.sendAdaptiveCardMSTeams,
  sendMessageMSTeams: mocks.sendMessageMSTeams,
  sendPollMSTeams: mocks.sendPollMSTeams,
}));

// mock-isolation: outbound tests assert selected-account poll persistence without opening a plugin-state database.
vi.mock("./polls.js", () => ({
  createMSTeamsPollStoreState: mocks.createMSTeamsPollStoreState,
}));

import { msteamsPlugin } from "./channel.js";
import { msteamsOutbound } from "./outbound.js";

const cfg: OpenClawConfig = { channels: { msteams: { appId: "resolved-app-id" } } };
const defaultTarget = { cfg, to: "conversation:abc" };
const sendResult = (messageId: string, conversationId = "conv-1") => ({
  messageId,
  conversationId,
});
const accountConfig = (account: string): OpenClawConfig => ({
  channels: {
    msteams: { defaultAccount: account, accounts: { [account]: { appId: "support-app" } } },
  },
});

const { sendText, sendMedia, sendPayload, sendPoll, renderPresentation } = msteamsOutbound;
assert(sendText && sendMedia && sendPayload && sendPoll && renderPresentation);

const render = (payload: Parameters<typeof renderPresentation>[0]["payload"]) => {
  return renderPresentation({
    payload,
    presentation: payload.presentation!,
    ctx: { ...defaultTarget, text: payload.text ?? "", mediaUrl: payload.mediaUrl, payload },
  });
};

describe("msteamsOutbound cfg threading", () => {
  beforeEach(() => {
    mocks.sendMessageMSTeams.mockReset();
    mocks.sendAdaptiveCardMSTeams.mockReset();
    mocks.sendPollMSTeams.mockReset();
    mocks.createPoll.mockReset();
    mocks.createMSTeamsPollStoreState.mockReset().mockReturnValue({ createPoll: mocks.createPoll });
    mocks.sendMessageMSTeams.mockResolvedValue(sendResult("msg-1"));
    mocks.sendPollMSTeams.mockResolvedValue({
      pollId: "poll-1",
      ...sendResult("msg-poll-1"),
    });
    mocks.sendAdaptiveCardMSTeams.mockResolvedValue(sendResult("msg-card-1", "conv-card-1"));
    mocks.createPoll.mockResolvedValue(undefined);
  });

  it("caps lightweight and runtime outbound at 4000 characters", () => {
    const configuredCfg: OpenClawConfig = {
      channels: { msteams: { appId: "resolved-app-id", textChunkLimit: 6000 } },
    };
    const params = { cfg: configuredCfg, fallbackLimit: 6000 };

    expect(msteamsPlugin.outbound?.resolveEffectiveTextChunkLimit?.(params)).toBe(4000);
    expect(msteamsOutbound.resolveEffectiveTextChunkLimit?.(params)).toBe(4000);
  });

  it.each([
    [
      "graph-team/19:channel@thread.tacv2",
      "thread-root-3",
      "graph-team/19:channel@thread.tacv2;messageid=thread-root-3",
    ],
    ["user:aad-user-1", "quoted-parent", "user:aad-user-1"],
  ])("resolves thread target for %s", async (target, threadId, expectedTarget) => {
    await sendText({ cfg, to: target, text: "hello", threadId });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      accountId: "default",
      cfg,
      to: expectedTarget,
      text: "hello",
    });
  });

  it("renders and sends presentation payloads as Adaptive Cards", async () => {
    const presentation: MessagePresentation = {
      title: "Deploy",
      blocks: [
        { type: "text", text: "Finished" },
        { type: "buttons", buttons: [{ label: "Open", value: "open" }] },
      ],
    };
    const payload = { text: "Deploy finished", presentation };
    const rendered = await render(payload);

    expect(rendered?.presentation).toBe(presentation);
    expect(rendered?.channelData?.msteams).toEqual({
      presentationCard: {
        type: "AdaptiveCard",
        version: "1.4",
        body: [
          { type: "TextBlock", text: "Deploy finished", wrap: true },
          { type: "TextBlock", text: "Deploy", weight: "Bolder", size: "Medium", wrap: true },
          { type: "TextBlock", text: "Finished", wrap: true },
        ],
        actions: [{ type: "Action.Submit", title: "Open", data: { value: "open", label: "Open" } }],
      },
    });

    const result = await sendPayload({
      cfg,
      to: "conversation:19:channel@thread.tacv2",
      threadId: "presentation-thread-root",
      text: "Deploy finished",
      payload: rendered!,
    });

    expect(mocks.sendAdaptiveCardMSTeams).toHaveBeenCalledWith({
      accountId: "default",
      cfg,
      to: "conversation:19:channel@thread.tacv2;messageid=presentation-thread-root",
      card: (rendered!.channelData!.msteams as { presentationCard: unknown }).presentationCard,
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-card-1",
      target: { kind: "conversation", id: "conv-card-1" },
    });
  });

  it("renders typed URL actions and omits unresolved approval actions", async () => {
    const presentation: MessagePresentation = {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Review",
              action: { type: "url", url: "https://example.com/review" },
            },
            {
              label: "Open app",
              action: { type: "web-app", url: "https://example.com/app" },
            },
            {
              label: "Widget",
              action: { type: "web-app", widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
            },
            {
              label: "Allow",
              action: {
                type: "approval",
                approvalId: "approval-1",
                approvalKind: "exec",
                decision: "allow-once",
              },
              value: "/approve approval-1 allow-once",
            },
          ],
        },
      ],
    };
    const payload = { presentation };
    const rendered = await render(payload);

    const card = (rendered?.channelData?.msteams as { presentationCard?: unknown } | undefined)
      ?.presentationCard as { actions?: unknown[] } | undefined;
    expect(card?.actions).toEqual([
      { type: "Action.OpenUrl", title: "Review", url: "https://example.com/review" },
      { type: "Action.OpenUrl", title: "Open app", url: "https://example.com/app" },
    ]);
    expect(JSON.stringify(card)).not.toContain("approval-1");
    expect(JSON.stringify(card)).not.toContain("/approve");
  });

  it.each(["observer", "native"] as const)(
    "retains accepted receipts after %s failure",
    async (kind) => {
      const native = kind === "native";
      const failure = new Error(
        native ? "second activity failed" : "delivery observer unavailable",
      );
      const onDeliveryResult = vi.fn();
      mocks.sendMessageMSTeams.mockResolvedValueOnce(sendResult("msg-first"));
      if (native) {
        const child = {
          ...sendResult("msg-child"),
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "msteams", messageId: "msg-child", conversationId: "conv-1" }],
            kind: "media",
          }),
        };
        const partial = createChannelPartialDeliveryError(failure, {
          messageIds: [child.messageId],
          receipt: child.receipt,
          visibleReplySent: true,
        });
        mocks.sendMessageMSTeams.mockImplementationOnce(async ({ onDeliveryResult: report }) => {
          await report?.(child);
          throw partial;
        });
      } else {
        onDeliveryResult.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
        mocks.sendMessageMSTeams.mockResolvedValueOnce(sendResult("msg-second"));
      }
      const text = "x".repeat(native ? 4001 : 8001);
      const messageIds = ["msg-first", native ? "msg-child" : "msg-second"];
      await expect(
        sendPayload({ ...defaultTarget, text, payload: { text }, onDeliveryResult }),
      ).rejects.toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        cause: failure,
        deliveryResult: {
          messageIds,
          visibleReplySent: true,
          receipt: {
            platformMessageIds: messageIds,
            ...(native
              ? {
                  parts: [
                    expect.objectContaining({ platformMessageId: "msg-first" }),
                    expect.objectContaining({ platformMessageId: "msg-child", kind: "media" }),
                  ],
                }
              : {}),
          },
        },
      });
      if (!native) {
        expect(mocks.sendMessageMSTeams).toHaveBeenCalledTimes(2);
      }
      expect(onDeliveryResult).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves a refusal before any payload activity is accepted", async () => {
    const refusal = new PlatformMessageNotDispatchedError("caller retired", {
      cause: new Error("caller retired"),
    });
    mocks.sendMessageMSTeams.mockRejectedValueOnce(refusal);
    await expect(
      sendPayload({ ...defaultTarget, text: "hello", payload: { text: "hello" } }),
    ).rejects.toBe(refusal);
    expect(mocks.sendMessageMSTeams).toHaveBeenCalledOnce();
  });

  it("keeps multi-media payloads on the media fallback path", async () => {
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
    };
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce(sendResult("msg-media-1", "conv-media"))
      .mockResolvedValueOnce(sendResult("msg-media-2", "conv-media"));

    const result = await sendPayload({
      ...defaultTarget,
      text: "album",
      payload: {
        text: "album",
        mediaUrls: ["one.png", "reports/two.png"],
        channelData: { msteams: { traceId: "trace-1" } },
      },
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
    });

    const mediaOptions = {
      accountId: "default",
      ...defaultTarget,
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
      mediaReadFile: undefined,
    };
    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(1, {
      ...mediaOptions,
      text: "album",
      mediaUrl: "one.png",
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(2, {
      ...mediaOptions,
      text: "",
      mediaUrl: "reports/two.png",
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessageMSTeams.mock.calls[0]?.[0]?.mediaAccess).toBe(mediaAccess);
    expect(mocks.sendMessageMSTeams.mock.calls[1]?.[0]?.mediaAccess).toBe(mediaAccess);
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-media-2",
      target: { kind: "conversation", id: "conv-media" },
    });
  });

  it("lets media payloads use text fallback instead of card rendering", async () => {
    const payload = {
      text: "photo",
      mediaUrl: "file:///tmp/photo.png",
      presentation: {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
      },
    };
    const rendered = await render(payload);

    expect(rendered).toBeNull();
  });

  it.each(["media", "payload"] as const)(
    "passes the configured account to injected %s delivery",
    async (kind) => {
      const accountCfg = accountConfig("support");
      const send = vi.fn(async () => sendResult("injected-id"));
      const ctx = {
        cfg: accountCfg,
        to: "conversation:abc",
        text: "hello",
        deps: { msteams: send },
      };
      if (kind === "media") {
        await sendMedia({ ...ctx, mediaUrl: "https://example.com/a.png" });
      } else {
        await sendPayload({ ...ctx, payload: { text: "hello" } });
      }
      expect(send).toHaveBeenCalledWith(
        "conversation:abc",
        "hello",
        expect.objectContaining({ cfg: accountCfg, accountId: "support" }),
      );
    },
  );

  it("forwards resolved channel thread ids to poll sends", async () => {
    const accountCfg = accountConfig("support-team");
    await sendPoll({
      cfg: accountCfg,
      accountId: "Support Team",
      to: "conversation:19:channel@thread.tacv2",
      threadId: "poll-thread-root",
      poll: { question: "Ship it?", options: ["Yes", "No"] },
    });

    expect(mocks.sendPollMSTeams).toHaveBeenCalledWith({
      accountId: "support-team",
      cfg: accountCfg,
      to: "conversation:19:channel@thread.tacv2;messageid=poll-thread-root",
      question: "Ship it?",
      options: ["Yes", "No"],
      maxSelections: 1,
      assertDirectAdapterHandoff: undefined,
      onPlatformSendDispatch: undefined,
    });
    expect(mocks.createMSTeamsPollStoreState).toHaveBeenCalledWith({ accountId: "support-team" });
    expect(mocks.createPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "poll-1",
        conversationId: "conv-1",
        messageId: "msg-poll-1",
      }),
    );
  });
});
