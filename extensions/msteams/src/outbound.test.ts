// Msteams tests cover outbound plugin behavior.
import assert from "node:assert/strict";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
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

const cfg = {
  channels: {
    msteams: {
      appId: "resolved-app-id",
    },
  },
} as OpenClawConfig;

const { sendText, sendMedia, sendPayload, sendPoll, renderPresentation } = msteamsOutbound;
assert(sendText && sendMedia && sendPayload && sendPoll && renderPresentation);

describe("msteamsOutbound cfg threading", () => {
  beforeEach(() => {
    mocks.sendMessageMSTeams.mockReset();
    mocks.sendAdaptiveCardMSTeams.mockReset();
    mocks.sendPollMSTeams.mockReset();
    mocks.createPoll.mockReset();
    mocks.createMSTeamsPollStoreState.mockReset().mockReturnValue({ createPoll: mocks.createPoll });
    mocks.sendMessageMSTeams.mockResolvedValue({
      messageId: "msg-1",
      conversationId: "conv-1",
    });
    mocks.sendPollMSTeams.mockResolvedValue({
      pollId: "poll-1",
      messageId: "msg-poll-1",
      conversationId: "conv-1",
    });
    mocks.sendAdaptiveCardMSTeams.mockResolvedValue({
      messageId: "msg-card-1",
      conversationId: "conv-card-1",
    });
    mocks.createPoll.mockResolvedValue(undefined);
  });

  it.each([
    { configuredLimit: 1000, expectedLimit: 1000 },
    { configuredLimit: 6000, expectedLimit: 4000 },
  ])(
    "resolves the same capped $configuredLimit-character limit for lightweight and runtime outbound",
    ({ configuredLimit, expectedLimit }) => {
      const configuredCfg = {
        channels: {
          msteams: {
            appId: "resolved-app-id",
            textChunkLimit: configuredLimit,
          },
        },
      } as OpenClawConfig;
      const params = { cfg: configuredCfg, fallbackLimit: configuredLimit };

      expect(msteamsPlugin.outbound?.resolveEffectiveTextChunkLimit?.(params)).toBe(expectedLimit);
      expect(msteamsOutbound.resolveEffectiveTextChunkLimit?.(params)).toBe(expectedLimit);
    },
  );

  it.each([
    {
      title: "forwards thread ids through Graph team/channel targets",
      target: "graph-team/19:channel@thread.tacv2",
      peerKind: "threaded",
      threadId: "thread-root-3",
      expectedTarget: "graph-team/19:channel@thread.tacv2;messageid=thread-root-3",
      expectedPeerKind: "threaded",
    },
    {
      title: "does not append channel thread ids to direct-message targets",
      target: "user:aad-user-1",
      peerKind: "direct",
      threadId: "quoted-parent",
      expectedTarget: "user:aad-user-1",
      expectedPeerKind: "direct",
    },
  ])("$title", async ({ target, peerKind, threadId, expectedTarget, expectedPeerKind }) => {
    await sendText({
      cfg,
      to: target,
      text: peerKind,
      threadId,
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      accountId: "default",
      cfg,
      to: expectedTarget,
      text: expectedPeerKind,
    });
  });

  it("preserves host-owned workspace media access for direct attachments", async () => {
    const readFile = vi.fn(async () => Buffer.from("approved attachment"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      readFile,
      workspaceDir: "/approved/workspace",
    };
    const conflictingReader = vi.fn(async () => Buffer.from("unapproved attachment"));

    await sendMedia({
      cfg,
      to: "conversation:abc",
      text: "photo",
      mediaUrl: "reports/photo.png",
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
      mediaReadFile: conflictingReader,
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledWith({
      accountId: "default",
      cfg,
      to: "conversation:abc",
      text: "photo",
      mediaUrl: "reports/photo.png",
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
      mediaReadFile: conflictingReader,
    });
    expect(mocks.sendMessageMSTeams.mock.calls[0]?.[0]?.mediaAccess).toBe(mediaAccess);
  });

  it("renders and sends presentation payloads as Adaptive Cards", async () => {
    const presentation = {
      title: "Deploy",
      blocks: [
        { type: "text" as const, text: "Finished" },
        {
          type: "buttons" as const,
          buttons: [{ label: "Open", value: "open" }],
        },
      ],
    };
    const payload = {
      text: "Deploy finished",
      presentation,
    };
    const rendered = await renderPresentation({
      payload,
      presentation,
      ctx: {
        cfg,
        to: "conversation:abc",
        text: "Deploy finished",
        payload,
      },
    });

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
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [
            {
              label: "Review",
              action: { type: "url" as const, url: "https://example.com/review" },
            },
            {
              label: "Open app",
              action: { type: "web-app" as const, url: "https://example.com/app" },
            },
            {
              label: "Hosted widget",
              action: {
                type: "web-app" as const,
                widgetId: "AAAAAAAAAAAAAAAAAAAAAA",
              },
            },
            {
              label: "Allow",
              action: {
                type: "approval" as const,
                approvalId: "approval-1",
                approvalKind: "exec" as const,
                decision: "allow-once" as const,
              },
              value: "/approve approval-1 allow-once",
            },
          ],
        },
      ],
    };
    const payload = { presentation };
    const rendered = await renderPresentation({
      payload,
      presentation,
      ctx: {
        cfg,
        to: "conversation:abc",
        text: "",
        payload,
      },
    });

    const card = (rendered?.channelData?.msteams as { presentationCard?: unknown } | undefined)
      ?.presentationCard as { actions?: unknown[] } | undefined;
    expect(card?.actions).toEqual([
      {
        type: "Action.OpenUrl",
        title: "Review",
        url: "https://example.com/review",
      },
      {
        type: "Action.OpenUrl",
        title: "Open app",
        url: "https://example.com/app",
      },
    ]);
    expect(JSON.stringify(card)).not.toContain("approval-1");
    expect(JSON.stringify(card)).not.toContain("/approve");
  });

  it("retains every accepted payload receipt when its observer fails", async () => {
    const failure = new Error("delivery observer unavailable");
    const onDeliveryResult = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-first", conversationId: "conv-1" })
      .mockResolvedValueOnce({ messageId: "msg-second", conversationId: "conv-1" });
    const text = "x".repeat(8001);
    await expect(
      sendPayload({ cfg, to: "conversation:abc", text, payload: { text }, onDeliveryResult }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: failure,
      deliveryResult: {
        messageIds: ["msg-first", "msg-second"],
        receipt: { platformMessageIds: ["msg-first", "msg-second"] },
        visibleReplySent: true,
      },
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenCalledTimes(2);
    expect(onDeliveryResult).toHaveBeenCalledTimes(2);
  });

  it("combines earlier payload receipts with a native partial delivery once", async () => {
    const failure = new Error("second activity failed");
    const child = {
      messageId: "msg-child",
      conversationId: "conv-1",
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
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-first", conversationId: "conv-1" })
      .mockImplementationOnce(async ({ onDeliveryResult }) => {
        await onDeliveryResult?.(child);
        throw partial;
      });
    const onDeliveryResult = vi.fn();
    const text = "x".repeat(4001);
    await expect(
      sendPayload({ cfg, to: "conversation:abc", text, payload: { text }, onDeliveryResult }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: failure,
      deliveryResult: {
        messageIds: ["msg-first", "msg-child"],
        receipt: {
          platformMessageIds: ["msg-first", "msg-child"],
          parts: [
            expect.objectContaining({ platformMessageId: "msg-first" }),
            expect.objectContaining({ platformMessageId: "msg-child", kind: "media" }),
          ],
        },
        visibleReplySent: true,
      },
    });
    expect(onDeliveryResult).toHaveBeenCalledTimes(2);
  });

  it("preserves a refusal before any payload activity is accepted", async () => {
    const refusal = new PlatformMessageNotDispatchedError("caller retired", {
      cause: new Error("caller retired"),
    });
    mocks.sendMessageMSTeams.mockRejectedValueOnce(refusal);
    await expect(
      sendPayload({ cfg, to: "conversation:abc", text: "hello", payload: { text: "hello" } }),
    ).rejects.toBe(refusal);
    expect(mocks.sendMessageMSTeams).toHaveBeenCalledOnce();
  });

  it.each([
    { configuredLimit: 1000, textLength: 1500, expectedChunkLengths: [1000, 500] },
    { configuredLimit: 6000, textLength: 5000, expectedChunkLengths: [4000, 1000] },
    {
      configuredLimit: 1000,
      textLength: 1500,
      expectedChunkLengths: [1000, 500],
      accountId: "support",
    },
  ])(
    "uses the capped $configuredLimit-character configured limit for fallback payloads",
    async ({ configuredLimit, textLength, expectedChunkLengths, accountId }) => {
      const configuredCfg = {
        channels: {
          msteams: {
            appId: "resolved-app-id",
            textChunkLimit: accountId ? 3000 : configuredLimit,
            ...(accountId ? { accounts: { support: { textChunkLimit: configuredLimit } } } : {}),
          },
        },
      } as OpenClawConfig;
      const text = "x".repeat(textLength);

      await sendPayload({
        cfg: configuredCfg,
        accountId,
        to: "conversation:abc",
        text,
        payload: {
          text,
          channelData: { msteams: { traceId: "trace-1" } },
        },
      });

      expect(mocks.sendMessageMSTeams).toHaveBeenCalledTimes(expectedChunkLengths.length);
      for (const [index, chunkLength] of expectedChunkLengths.entries()) {
        expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(index + 1, {
          cfg: configuredCfg,
          accountId: accountId ?? "default",
          to: "conversation:abc",
          text: "x".repeat(chunkLength),
        });
      }
    },
  );

  it("keeps multi-media payloads on the media fallback path", async () => {
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
    };
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-media-1", conversationId: "conv-media" })
      .mockResolvedValueOnce({ messageId: "msg-media-2", conversationId: "conv-media" });

    const result = await sendPayload({
      cfg,
      to: "conversation:abc",
      text: "album",
      payload: {
        text: "album",
        mediaUrls: ["one.png", "reports/two.png"],
        channelData: { msteams: { traceId: "trace-1" } },
      },
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(1, {
      accountId: "default",
      cfg,
      to: "conversation:abc",
      text: "album",
      mediaUrl: "one.png",
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
      mediaReadFile: undefined,
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(2, {
      accountId: "default",
      cfg,
      to: "conversation:abc",
      text: "",
      mediaUrl: "reports/two.png",
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
      mediaReadFile: undefined,
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
    const rendered = await renderPresentation({
      payload,
      presentation: payload.presentation,
      ctx: {
        cfg,
        to: "conversation:abc",
        text: "photo",
        mediaUrl: "file:///tmp/photo.png",
        payload,
      },
    });

    expect(rendered).toBeNull();
  });

  it.each(["Support Team", undefined])(
    "uses one canonical account for poll delivery and state (%s)",
    async (accountId) => {
      const accountCfg: OpenClawConfig = {
        channels: {
          msteams: {
            defaultAccount: "support-team",
            accounts: { "support-team": { appId: "support-app" } },
          },
        },
      };
      await sendPoll({
        cfg: accountCfg,
        accountId,
        to: "conversation:abc",
        poll: { question: "Ship?", options: ["Yes", "No"] },
      });
      expect(mocks.sendPollMSTeams).toHaveBeenCalledWith(
        expect.objectContaining({ cfg: accountCfg, accountId: "support-team" }),
      );
      expect(mocks.createMSTeamsPollStoreState).toHaveBeenCalledWith({ accountId: "support-team" });
      expect(mocks.createPoll).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "poll-1",
          conversationId: "conv-1",
          messageId: "msg-poll-1",
        }),
      );
    },
  );

  it.each(["text", "media", "payload"] as const)(
    "passes the configured account to injected %s delivery",
    async (kind) => {
      const accountCfg: OpenClawConfig = {
        channels: {
          msteams: {
            defaultAccount: "support",
            accounts: { support: { appId: "support-app" } },
          },
        },
      };
      const send = vi.fn(async () => ({ messageId: "injected-id", conversationId: "conv-1" }));
      const ctx = {
        cfg: accountCfg,
        to: "conversation:abc",
        text: "hello",
        deps: { msteams: send },
      };
      if (kind === "text") {
        await sendText(ctx);
      } else if (kind === "media") {
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
    await sendPoll({
      cfg,
      to: "conversation:19:channel@thread.tacv2",
      threadId: "poll-thread-root",
      poll: {
        question: "Ship it?",
        options: ["Yes", "No"],
      },
    });

    expect(mocks.sendPollMSTeams).toHaveBeenCalledWith({
      accountId: "default",
      cfg,
      to: "conversation:19:channel@thread.tacv2;messageid=poll-thread-root",
      question: "Ship it?",
      options: ["Yes", "No"],
      maxSelections: 1,
      assertDirectAdapterHandoff: undefined,
      onPlatformSendDispatch: undefined,
    });
  });
});
