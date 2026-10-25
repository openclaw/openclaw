import path from "node:path";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { ChunkMode, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { beforeEach, expect, it, vi } from "vitest";
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
      return sendResult(
        messageId,
        content.trim(),
        "buttons" in opts && Array.isArray(opts.buttons) && opts.buttons.length ? "card" : "text",
      );
    },
  );
}

function sendResult(
  messageId: string,
  content: string,
  kind: "text" | "card" = "text",
): MattermostSendResult {
  return {
    messageId,
    channelId: "channel-1",
    content,
    receipt: createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId, channelId: "channel-1" }],
      kind,
    }),
  };
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

type Presentation = NonNullable<ReplyPayload["presentation"]>;
const present = (...blocks: Presentation["blocks"]): Pick<ReplyPayload, "presentation"> => ({
  presentation: { blocks },
});
const openControls = present({ type: "buttons", buttons: [{ label: "Open", value: "open" }] });

it.each<[string, ReplyPayload, string, string?]>([
  [
    "presentation-only title",
    { presentation: { title: "Build complete", blocks: [] } },
    "Build complete",
  ],
  [
    "presentation-only text",
    present({ type: "text", text: "Release finished" }),
    "Release finished",
  ],
  ["presentation-only native value button", openControls, "- Open", "open"],
  [
    "presentation-only URL button",
    present({ type: "buttons", buttons: [{ label: "Docs", url: "https://example.com/docs" }] }),
    "- Docs: https://example.com/docs",
  ],
  [
    "presentation-only select",
    present({
      type: "select",
      placeholder: "Environment",
      options: [{ label: "Production", value: "production" }],
    }),
    "Environment:\n- Production",
  ],
  [
    "authored text with native buttons",
    { text: "Deploy finished", ...openControls },
    "Deploy finished\n\n- Open",
    "open",
  ],
  [
    "authored fallback without duplicate presentation text",
    {
      text: "Already formatted",
      presentationTextMode: "fallback",
      ...present({ type: "text", text: "Generated summary" }),
    },
    "Already formatted",
  ],
  [
    "typed callback action stays text-only",
    present({
      type: "buttons",
      buttons: [
        { label: "Inspect", action: { type: "callback", value: "private-callback-token" } },
      ],
    }),
    "- Inspect",
  ],
])(
  "delivers %s through the normal reply owner",
  async (_name, payload, expectedText, expectedButtonValue) => {
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
      ...openControls,
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
  expect(result.receipt?.parts.map((part) => part.platformMessageId)).toEqual(["post-1", "post-2"]);
});

it("keeps multiple-media presentations on the text/media fallback path", async () => {
  await deliver({
    payload: {
      mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
      ...openControls,
    },
  });

  expect(sendMessage).toHaveBeenCalledTimes(2);
  expect(sendMessage.mock.calls[0]![1]).toBe("- Open");
  for (const call of sendMessage.mock.calls) {
    expect("buttons" in call[2]).toBe(false);
  }
});

it.each<ReplyPayload>([
  { text: "hidden", isReasoning: true },
  { text: "  \n Reasoning:\n_hidden_" },
  { text: "> Reasoning:\n> _hidden_" },
])("suppresses reasoning payload %j", async (payload) => {
  const outcome = await deliver({ payload, agentId: "agent-1", replyToId: "root-post" });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(outcome).toEqual({
    outcome: "reasoning_skipped",
    visibleReplySent: false,
    suppression: { reason: "no_visible_result" },
  });
});

it("returns 'empty' for substantive text that produced no send (regression: #80501)", async () => {
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
  const result = await deliver({
    payload: { text: "requested text" },
    sendMessage: vi.fn(async () => sendResult("post-final", "provider-finalized")),
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

  const caught: unknown = await deliver({
    payload: { text: "alpha beta" },
    sendMessage: partialSend,
    replyToId: "root-post",
    textLimit: 6,
  }).catch((error: unknown) => error);
  if (!isChannelPartialDeliveryError(caught)) {
    throw new Error("expected a partial Mattermost delivery error");
  }
  expect(caught.deliveryResult).toMatchObject({
    messageIds: ["post-1"],
    visibleReplySent: true,
    content: "alpha",
  });
});
