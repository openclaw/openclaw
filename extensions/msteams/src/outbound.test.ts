// Msteams tests cover outbound plugin behavior.
import assert from "node:assert/strict";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendAdaptiveCardMSTeams: vi.fn(),
  sendMessageMSTeams: vi.fn(),
  sendPollMSTeams: vi.fn(),
  createPoll: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendAdaptiveCardMSTeams: mocks.sendAdaptiveCardMSTeams,
  sendMessageMSTeams: mocks.sendMessageMSTeams,
  sendPollMSTeams: mocks.sendPollMSTeams,
}));

vi.mock("./polls.js", () => ({
  createMSTeamsPollStoreState: () => ({
    createPoll: mocks.createPoll,
  }),
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

type PollRecord = Record<string, unknown> & { createdAt: string };

function firstPollRecord(): PollRecord {
  const [call] = mocks.createPoll.mock.calls;
  if (!call) {
    throw new Error("expected createPoll call");
  }
  const [pollRecord] = call;
  if (!pollRecord || typeof pollRecord !== "object" || Array.isArray(pollRecord)) {
    throw new Error("expected createPoll record");
  }
  if (typeof (pollRecord as { createdAt?: unknown }).createdAt !== "string") {
    throw new Error("expected createPoll record timestamp");
  }
  return pollRecord as PollRecord;
}

describe("msteamsOutbound cfg threading", () => {
  beforeEach(() => {
    mocks.sendMessageMSTeams.mockReset();
    mocks.sendAdaptiveCardMSTeams.mockReset();
    mocks.sendPollMSTeams.mockReset();
    mocks.createPoll.mockReset();
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

  it("advertises durable payload delivery for presentation cards", () => {
    expect(msteamsOutbound.deliveryCapabilities?.durableFinal).toMatchObject({
      text: true,
      media: true,
      payload: true,
      messageSendingHooks: true,
    });
  });

  it.each([
    { configuredLimit: 6000, expectedLimit: 4000 },
    { configuredLimit: 1000, expectedLimit: 1000 },
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
      title: "forwards resolved channel thread ids through the Teams target",
      target: "conversation:19:channel@thread.tacv2",
      peerKind: "threaded",
      threadId: "thread-root-2",
      expectedTarget: "conversation:19:channel@thread.tacv2;messageid=thread-root-2",
      expectedPeerKind: "threaded",
    },
    {
      title: "preserves explicit Teams thread targets",
      target: "conversation:19:channel@thread.tacv2;messageid=explicit-root",
      peerKind: "threaded",
      threadId: "ambient-root",
      expectedTarget: "conversation:19:channel@thread.tacv2;messageid=explicit-root",
      expectedPeerKind: "threaded",
    },
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

  it("chunks text fallback payloads that only carry channel metadata", async () => {
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-text-1", conversationId: "conv-text" })
      .mockResolvedValueOnce({ messageId: "msg-text-2", conversationId: "conv-text" });
    const text = "x".repeat(4001);

    const result = await sendPayload({
      cfg,
      to: "conversation:abc",
      text,
      payload: {
        text,
        channelData: { msteams: { traceId: "trace-1" } },
      },
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(1, {
      cfg,
      to: "conversation:abc",
      text: "x".repeat(4000),
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(2, {
      cfg,
      to: "conversation:abc",
      text: "x",
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-text-2",
      target: { kind: "conversation", id: "conv-text" },
    });
  });

  it.each([
    { configuredLimit: 6000, textLength: 5000, expectedChunkLengths: [4000, 1000] },
    { configuredLimit: 1000, textLength: 1500, expectedChunkLengths: [1000, 500] },
  ])(
    "uses the capped $configuredLimit-character configured limit for fallback payloads",
    async ({ configuredLimit, textLength, expectedChunkLengths }) => {
      const configuredCfg = {
        channels: {
          msteams: {
            appId: "resolved-app-id",
            textChunkLimit: configuredLimit,
          },
        },
      } as OpenClawConfig;
      const text = "x".repeat(textLength);

      await sendPayload({
        cfg: configuredCfg,
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
          to: "conversation:abc",
          text: "x".repeat(chunkLength),
        });
      }
    },
  );

  it("keeps multi-media payloads on the media fallback path", async () => {
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-media-1", conversationId: "conv-media" })
      .mockResolvedValueOnce({ messageId: "msg-media-2", conversationId: "conv-media" });

    const result = await sendPayload({
      cfg,
      to: "conversation:abc",
      text: "album",
      payload: {
        text: "album",
        mediaUrls: ["file:///tmp/one.png", "file:///tmp/two.png"],
        channelData: { msteams: { traceId: "trace-1" } },
      },
      mediaLocalRoots: ["/tmp"],
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(1, {
      cfg,
      to: "conversation:abc",
      text: "album",
      mediaUrl: "file:///tmp/one.png",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile: undefined,
    });
    expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(2, {
      cfg,
      to: "conversation:abc",
      text: "",
      mediaUrl: "file:///tmp/two.png",
      mediaLocalRoots: ["/tmp"],
      mediaReadFile: undefined,
    });
    expect(result).toEqual({
      channel: "msteams",
      messageId: "msg-media-2",
      target: { kind: "conversation", id: "conv-media" },
    });
  });

  it("preserves host media authority for every workspace-relative payload attachment", async () => {
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
    };
    mocks.sendMessageMSTeams
      .mockResolvedValueOnce({ messageId: "msg-media-1", conversationId: "conv-media" })
      .mockResolvedValueOnce({ messageId: "msg-media-2", conversationId: "conv-media" });

    await sendPayload({
      cfg,
      to: "conversation:abc",
      text: "album",
      payload: { text: "album", mediaUrls: ["one.png", "reports/two.png"] },
      mediaAccess,
      mediaLocalRoots: ["/unapproved/workspace"],
    });

    expect(mocks.sendMessageMSTeams).toHaveBeenCalledTimes(2);
    for (const [index, mediaUrl] of ["one.png", "reports/two.png"].entries()) {
      expect(mocks.sendMessageMSTeams).toHaveBeenNthCalledWith(index + 1, {
        cfg,
        to: "conversation:abc",
        text: index === 0 ? "album" : "",
        mediaUrl,
        mediaAccess,
        mediaLocalRoots: ["/unapproved/workspace"],
        mediaReadFile: undefined,
      });
      expect(mocks.sendMessageMSTeams.mock.calls[index]?.[0]?.mediaAccess).toBe(mediaAccess);
    }
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

  it("passes resolved cfg to sendPollMSTeams and stores poll metadata", async () => {
    const assertDirectAdapterHandoff = vi.fn();
    const onPlatformSendDispatch = vi.fn(async () => {});
    const cfgLocal = {
      channels: {
        msteams: {
          appId: "resolved-app-id",
        },
      },
    } as OpenClawConfig;

    await sendPoll({
      cfg: cfgLocal,
      to: "conversation:abc",
      assertDirectAdapterHandoff,
      onPlatformSendDispatch,
      poll: {
        question: "Snack?",
        options: ["Pizza", "Sushi"],
      },
    });

    expect(mocks.sendPollMSTeams).toHaveBeenCalledWith({
      cfg: cfgLocal,
      to: "conversation:abc",
      question: "Snack?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      assertDirectAdapterHandoff,
      onPlatformSendDispatch,
    });
    const pollRecord = firstPollRecord();
    expect(pollRecord).toEqual({
      id: "poll-1",
      question: "Snack?",
      options: ["Pizza", "Sushi"],
      maxSelections: 1,
      createdAt: pollRecord?.createdAt,
      conversationId: "conv-1",
      messageId: "msg-poll-1",
      votes: {},
    });
    expect(Number.isNaN(Date.parse(pollRecord?.createdAt))).toBe(false);
  });

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
      cfg,
      to: "conversation:19:channel@thread.tacv2;messageid=poll-thread-root",
      question: "Ship it?",
      options: ["Yes", "No"],
      maxSelections: 1,
      assertDirectAdapterHandoff: undefined,
      onPlatformSendDispatch: undefined,
    });
  });

  it("chunks outbound text without requiring MSTeams runtime initialization", () => {
    const chunker = msteamsOutbound.chunker;
    if (!chunker) {
      throw new Error("msteams outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });
});
