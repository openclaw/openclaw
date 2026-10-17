// Mattermost tests cover reply delivery plugin behavior.
import path from "node:path";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { ChunkMode, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import type { MattermostSendResult } from "./send.js";

type DeliverMattermostReplyPayloadParams = Parameters<typeof deliverMattermostReplyPayload>[0];
type SendMattermostMessageOptions = Parameters<
  DeliverMattermostReplyPayloadParams["sendMessage"]
>[2];
function createReplyDeliveryCore(): DeliverMattermostReplyPayloadParams["core"] {
  return {
    channel: {
      text: {
        convertMarkdownTables: vi.fn((text: string) => text),
        resolveChunkMode: vi.fn<() => ChunkMode>(() => "length"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as PluginRuntime;
}

function createSendMessageMock() {
  let sendCount = 0;
  return vi.fn(
    async (
      _to: string,
      content: string,
      opts: SendMattermostMessageOptions,
    ): Promise<MattermostSendResult> => {
      const messageId = `post-${++sendCount}`;
      return {
        messageId,
        channelId: "channel-1",
        content: content.trim(),
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "mattermost", messageId, channelId: "channel-1" }],
          kind:
            "buttons" in opts && Array.isArray(opts.buttons) && opts.buttons.length
              ? "card"
              : "text",
        }),
      };
    },
  );
}

let sendMessage: ReturnType<typeof createSendMessageMock>;
let core: DeliverMattermostReplyPayloadParams["core"];
beforeEach(() => {
  sendMessage = createSendMessageMock();
  core = createReplyDeliveryCore();
});

function deliver(
  options: Pick<DeliverMattermostReplyPayloadParams, "payload"> &
    Partial<DeliverMattermostReplyPayloadParams>,
) {
  return deliverMattermostReplyPayload({
    core,
    sendMessage,
    cfg: {},
    channelId: "town-square",
    accountId: "default",
    textLimit: 4000,
    tableMode: "off",
    ...options,
  });
}

describe("deliverMattermostReplyPayload", () => {
  it.each<{
    name: string;
    payload: ReplyPayload;
    expectedText: string;
    expectedButtonValue?: string;
  }>([
    {
      name: "presentation-only title",
      payload: { presentation: { title: "Build complete", blocks: [] } },
      expectedText: "Build complete",
    },
    {
      name: "presentation-only text",
      payload: { presentation: { blocks: [{ type: "text", text: "Release finished" }] } },
      expectedText: "Release finished",
    },
    {
      name: "presentation-only native value button",
      payload: {
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
      },
      expectedText: "- Open",
      expectedButtonValue: "open",
    },
    {
      name: "presentation-only URL button",
      payload: {
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Docs", url: "https://example.com/docs" }],
            },
          ],
        },
      },
      expectedText: "- Docs: https://example.com/docs",
    },
    {
      name: "presentation-only select",
      payload: {
        presentation: {
          blocks: [
            {
              type: "select",
              placeholder: "Environment",
              options: [{ label: "Production", value: "production" }],
            },
          ],
        },
      },
      expectedText: "Environment:\n- Production",
    },
    {
      name: "authored text with native buttons",
      payload: {
        text: "Deploy finished",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
      },
      expectedText: "Deploy finished\n\n- Open",
      expectedButtonValue: "open",
    },
    {
      name: "authored fallback without duplicate presentation text",
      payload: {
        text: "Already formatted",
        presentationTextMode: "fallback",
        presentation: { blocks: [{ type: "text", text: "Generated summary" }] },
      },
      expectedText: "Already formatted",
    },
    {
      name: "typed callback action stays text-only",
      payload: {
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Inspect",
                  action: { type: "callback", value: "private-callback-token" },
                },
              ],
            },
          ],
        },
      },
      expectedText: "- Inspect",
    },
  ])(
    "delivers $name through the normal reply owner",
    async ({ payload, expectedText, expectedButtonValue }) => {
      const result = await deliver({
        payload,
        replyToId: "root-post",
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "channel:town-square",
        expectedText,
        expect.objectContaining({ accountId: "default", replyToId: "root-post" }),
      );
      const options = sendMessage.mock.calls[0]![2];
      if (expectedButtonValue) {
        expect(options).toMatchObject({
          buttons: [[{ id: expectedButtonValue, callback_data: expectedButtonValue }]],
        });
      } else {
        expect("buttons" in options ? options.buttons : undefined).toBeUndefined();
      }
      expect(result).toMatchObject({ outcome: "text", visibleReplySent: true });
      expect(result.receipt?.parts[0]?.kind).toBe(expectedButtonValue ? "card" : "text");
    },
  );

  it("attaches presentation controls only to the first visible text chunk", async () => {
    core.channel.text.chunkMarkdownTextWithMode = vi.fn(() => ["alpha", "beta"]);

    const result = await deliver({
      payload: {
        text: "alpha beta",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
      },
      textLimit: 6,
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]![2]).toMatchObject({
      buttons: [[{ id: "open", callback_data: "open" }]],
    });
    expect("buttons" in sendMessage.mock.calls[1]![2]).toBe(false);
    expect(result).toMatchObject({
      outcome: "text",
      messageIds: ["post-1", "post-2"],
      visibleReplySent: true,
      content: "alpha\nbeta",
    });
    expect(result.receipt?.parts.map((part) => part.platformMessageId)).toEqual([
      "post-1",
      "post-2",
    ]);
  });

  it("keeps multiple-media presentations on the text/media fallback path", async () => {
    await deliver({
      payload: {
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]![1]).toBe("- Open");
    for (const call of sendMessage.mock.calls) {
      expect("buttons" in call[2]).toBe(false);
    }
  });

  it("suppresses payloads flagged as reasoning", async () => {
    const outcome = await deliver({
      payload: { text: "hidden", isReasoning: true },
      agentId: "agent-1",
      replyToId: "root-post",
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      outcome: "reasoning_skipped",
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
  });

  it("returns 'empty' for substantive text that produced no send (regression: #80501)", async () => {
    // Make the markdown table converter strip the text to empty so
    // deliverTextOrMediaReply sees an empty chunked text and returns "empty".
    core.channel.text.convertMarkdownTables = vi.fn(() => "");
    core.channel.text.chunkMarkdownTextWithMode = vi.fn(() => []);

    const outcome = await deliver({
      payload: { text: "non-trivial input that the converter strips" },
      agentId: "agent-1",
      replyToId: "root-post",
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      outcome: "empty",
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
  });

  it("suppresses reasoning-prefixed payloads even without an explicit flag", async () => {
    await deliver({
      payload: { text: "  \n Reasoning:\n_hidden_" },
      agentId: "agent-1",
      replyToId: "root-post",
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses reasoning payloads formatted as a Mattermost blockquote", async () => {
    await deliver({
      payload: { text: "> Reasoning:\n> _hidden_" },
      agentId: "agent-1",
      replyToId: "root-post",
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("passes agent-scoped mediaLocalRoots when sending media paths", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-mm-state-",
    });
    const stateDir = openClawState.stateDir;

    try {
      const agentId = "agent-1";
      const mediaUrl = `file://${path.join(stateDir, `workspace-${agentId}`, "photo.png")}`;
      const cfg = {} satisfies OpenClawConfig;
      await deliver({
        cfg,
        payload: { text: "caption", mediaUrl },
        agentId,
        replyToId: "root-post",
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "channel:town-square",
        "caption",
        expect.objectContaining({
          cfg,
          accountId: "default",
          mediaUrl,
          // Local (non-http) media must require a successful upload so a
          // failure surfaces instead of silently posting the caption alone.
          requireMediaUpload: true,
          replyToId: "root-post",
          mediaLocalRoots: expect.arrayContaining([
            path.join(stateDir, "media"),
            path.join(stateDir, "canvas"),
            path.join(stateDir, "workspace"),
            path.join(stateDir, `workspace-${agentId}`),
          ]),
        }),
      );
      const sendOptions = sendMessage.mock.calls[0]?.[2];
      expect(sendOptions?.mediaLocalRoots).not.toContain(path.join(stateDir, "sandboxes"));
    } finally {
      await openClawState.cleanup();
    }
  });

  it("returns provider-finalized visible content instead of the requested text", async () => {
    const finalizedSend = vi.fn(async (): Promise<MattermostSendResult> => ({
      messageId: "post-final",
      channelId: "channel-1",
      content: "provider-finalized",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "mattermost", messageId: "post-final", channelId: "channel-1" }],
        kind: "text",
      }),
    }));

    const result = await deliver({
      payload: { text: "requested text" },
      sendMessage: finalizedSend,
    });

    expect(result).toMatchObject({
      messageIds: ["post-final"],
      visibleReplySent: true,
      content: "provider-finalized",
    });
  });

  it("preserves the accepted post when a later chunk fails", async () => {
    const firstResult = createSendMessageMock();
    const partialSend = vi
      .fn<DeliverMattermostReplyPayloadParams["sendMessage"]>()
      .mockImplementationOnce(firstResult)
      .mockRejectedValueOnce(new Error("second chunk failed"));
    core.channel.text.chunkMarkdownTextWithMode = vi.fn(() => ["alpha", "beta"]);

    let caught: unknown;
    try {
      await deliver({
        payload: { text: "alpha beta" },
        sendMessage: partialSend,
        replyToId: "root-post",
        textLimit: 6,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial Mattermost delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["post-1"],
      visibleReplySent: true,
      content: "alpha",
    });
  });
});
