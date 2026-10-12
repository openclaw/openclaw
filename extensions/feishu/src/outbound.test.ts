import fs from "node:fs/promises";
import path from "node:path";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  adaptMessagePresentationForChannel,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, ReplyPayload } from "../runtime-api.js";
import {
  FEISHU_SELECTED_SECRET_ENV,
  FEISHU_SIBLING_SECRET_ENV,
  createFeishuSecretRefPolicyConfig,
  feishuSecretRefPolicyCases,
} from "./bot.test-support.js";
import type { FeishuClientCredentials } from "./client.js";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() =>
  vi.fn((_account: FeishuClientCredentials) => ({ request: vi.fn() })),
);
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const cleanupAmbientCommentTypingReactionMock = vi.hoisted(() =>
  vi.fn<typeof import("./comment-reaction.js").cleanupAmbientCommentTypingReaction>(
    async () => false,
  ),
);
const shouldSuppressFeishuTextForVoiceMediaMock = vi.hoisted(
  () =>
    (params: {
      mediaUrl?: string;
      audioAsVoice?: boolean;
      ttsSupplement?: { visibleTextAlreadyDelivered?: boolean };
    }) =>
      params.ttsSupplement
        ? params.ttsSupplement.visibleTextAlreadyDelivered === true
        : params.audioAsVoice === true || /\.(?:ogg|opus)(?:[?#]|$)/i.test(params.mediaUrl ?? ""),
);
const resolvePinnedHostnameWithPolicyMock = vi.hoisted(() =>
  vi.fn(async (hostname: string) => {
    if (hostname === "files.example.test") {
      throw new Error("Blocked: resolves to private/internal/special-use IP address");
    }
    return {
      hostname,
      addresses: ["93.184.216.34"],
      lookup: vi.fn(),
    };
  }),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: resolvePinnedHostnameWithPolicyMock,
  };
});

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
  sendStickerFeishu: vi.fn(),
  shouldSuppressFeishuTextForVoiceMedia: shouldSuppressFeishuTextForVoiceMediaMock,
}));

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  editMessageFeishu: vi.fn(),
  getMessageFeishu: vi.fn(),
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("./comment-reaction.js", () => ({
  cleanupAmbientCommentTypingReaction: cleanupAmbientCommentTypingReactionMock,
}));

import { withTempDir } from "openclaw/plugin-sdk/test-env";
import {
  FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER,
  feishuOutbound,
  type FeishuOutboundSendMedia,
} from "./outbound.js";

type TextContext = Parameters<NonNullable<typeof feishuOutbound.sendText>>[0];
type PayloadContext = Parameters<NonNullable<typeof feishuOutbound.sendPayload>>[0];
const cfg: ClawdbotConfig = {};
const context = { cfg, to: "chat_1", accountId: "main" };
const commentTarget = "comment:docx:doxcn123:7623358762119646411";
const imageUrl = "https://example.com/image.png";
const voiceUrl = "https://example.com/reply.mp3";
const expandedText = "a\n".repeat(2_200).trimEnd();
const implicitReply = {
  replyToId: "om_reply",
  replyToIdSource: "implicit",
  replyToMode: "first",
} as const;
const card = {
  schema: "2.0",
  header: { title: { tag: "plain_text", content: "Raw card" } },
  body: { elements: [{ tag: "markdown", content: "hello" }] },
};
const nativeCardText = JSON.stringify(card);
const propagation = { feishu: { [FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER]: true } };

function sendText(text: string, options: Partial<TextContext> = {}) {
  return feishuOutbound.sendText?.({ ...context, text, ...options });
}

function sendMedia(options: Partial<Parameters<FeishuOutboundSendMedia>[0]> = {}) {
  return feishuOutbound.sendMedia?.({ ...context, text: "", mediaUrl: imageUrl, ...options });
}

function sendPayload(payload: ReplyPayload, options: Partial<PayloadContext> = {}) {
  return feishuOutbound.sendPayload?.({
    ...context,
    text: payload.text ?? "",
    payload,
    ...options,
  });
}

async function render(
  payload: ReplyPayload & { presentation: MessagePresentation },
  to = context.to,
) {
  const rendered = await feishuOutbound.renderPresentation?.({
    payload,
    presentation: payload.presentation,
    ctx: { ...context, to, text: "", payload },
  });
  if (!rendered) {
    throw new Error("Expected a rendered Feishu payload");
  }
  const { presentation: _presentation, ...result } = rendered;
  return result;
}

function buttons(
  entries: Extract<MessagePresentation["blocks"][number], { type: "buttons" }>["buttons"],
): MessagePresentation {
  return { blocks: [{ type: "buttons", buttons: entries }] };
}

function tablePresentation(rows = 400, width = 80): MessagePresentation {
  return {
    blocks: [
      {
        type: "table",
        caption: "Pipeline",
        headers: ["Account", "Stage"],
        rows: Array.from({ length: rows }, (_, index) => [
          "account-" + index + "-" + "x".repeat(width),
          "Review",
        ]),
      },
    ],
  };
}

function oversizedPresentation() {
  return adaptMessagePresentationForChannel({
    presentation: tablePresentation(),
    capabilities: feishuOutbound.presentationCapabilities,
  });
}

function textCall(index = 0) {
  return sendMessageFeishuMock.mock.calls[index]?.[0];
}
function mediaCall(index = 0) {
  return sendMediaFeishuMock.mock.calls[index]?.[0];
}
function cardCall() {
  return sendCardFeishuMock.mock.calls[0]?.[0]?.card;
}
function commentCall(index = 0) {
  return deliverCommentThreadTextMock.mock.calls[index]?.[1];
}
function deliveredText() {
  return sendMessageFeishuMock.mock.calls.map(([params]) => params.text).join("\n");
}

function expectResult(result: unknown, messageId: string) {
  expect(result).toMatchObject({ channel: "feishu", messageId });
}

async function withImage(run: (file: string, dir: string) => Promise<void>) {
  await withTempDir("openclaw-feishu-outbound-", async (dir) => {
    const file = path.join(dir, "sample.heic");
    await fs.writeFile(file, "image-data");
    await run(file, dir);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
  sendCardFeishuMock.mockResolvedValue({ messageId: "native_card_msg" });
  sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
  deliverCommentThreadTextMock.mockResolvedValue({
    delivery_mode: "reply_comment",
    reply_id: "reply_msg",
  });
  cleanupAmbientCommentTypingReactionMock.mockResolvedValue(false);
});

afterAll(() => {
  vi.doUnmock("./media.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./drive.js");
  vi.doUnmock("./comment-reaction.js");
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("Feishu text delivery", () => {
  it("routes a local image payload through approved media access without exposing its path", async () => {
    await withImage(async (file, dir) => {
      const readFile = vi.fn(async () => Buffer.from("approved image"));
      const mediaAccess = { localRoots: [dir], workspaceDir: dir, readFile };
      const result = await sendPayload(
        { text: file },
        {
          mediaAccess,
          mediaLocalRoots: [dir],
          mediaReadFile: readFile,
        },
      );
      expect(mediaCall()).toMatchObject({
        to: "chat_1",
        accountId: "main",
        mediaUrl: file,
        mediaAccess,
        mediaLocalRoots: [dir],
        mediaReadFile: readFile,
      });
      expect(mediaCall()?.mediaAccess).toBe(mediaAccess);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expectResult(result, "media_msg");
    });
  });

  it("redacts an image path when its upload fails", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    await withImage(async (file) => {
      await sendText(file);
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      expect(textCall()?.text).toBe("Media upload failed. Please try again.");
      expect(textCall()?.text).not.toContain(file);
    });
  });

  it("does not emit fallback after an accepted local image loses its receipt", async () => {
    const error = createChannelPartialDeliveryError(new Error("missing receipt"), {
      messageIds: [],
      visibleReplySent: true,
    });
    sendMediaFeishuMock.mockRejectedValueOnce(error);
    await withImage(async (file, dir) => {
      await expect(sendText(file, { mediaLocalRoots: [dir] })).rejects.toBe(error);
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    });
  });

  it("does not emit fallback when accepted local-image progress cannot be persisted", async () => {
    const onDeliveryResult = vi.fn().mockRejectedValueOnce(new Error("progress write failed"));
    await withImage(async (file, dir) => {
      await expect(sendText(file, { mediaLocalRoots: [dir], onDeliveryResult })).rejects.toThrow(
        "progress write failed",
      );
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(onDeliveryResult).toHaveBeenCalledOnce();
    });
  });

  it("sends wrapped interactive JSON as a native card", async () => {
    const text = JSON.stringify({ type: "interactive", card });
    expectResult(await sendText(text, { replyToId: "om_reply" }), "native_card_msg");
    expect(cardCall()?.body.elements).toEqual(card.body.elements);
    expect(sendCardFeishuMock.mock.calls[0]?.[0]).toMatchObject({
      to: "chat_1",
      accountId: "main",
      replyToMessageId: "om_reply",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });
});

describe("Feishu TTS supplements", () => {
  it("delivers a structured card before its voice supplement", async () => {
    await sendPayload({
      text: "Readable answer",
      mediaUrl: voiceUrl,
      audioAsVoice: true,
      ttsSupplement: { spokenText: "Readable answer" },
      channelData: { feishu: { card } },
    });
    expect(cardCall()).toMatchObject(card);
    expect(mediaCall()).toMatchObject({ mediaUrl: voiceUrl, audioAsVoice: true });
    expect(sendCardFeishuMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMediaFeishuMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    { route: "core", controls: true, visible: true },
    { route: "direct", controls: false, visible: false },
    { route: "core", controls: false, visible: true },
  ])(
    "preserves oversized presentation TTS: $route, controls=$controls, visible=$visible",
    async ({ route, controls, visible }) => {
      const presentation: MessagePresentation = {
        blocks: controls
          ? [
              ...Array.from({ length: 196 }, () => ({ type: "divider" as const })),
              { type: "text", text: "Presentation detail" },
              {
                type: "buttons",
                buttons: [
                  { label: "Help", action: { type: "command", command: "/help" } },
                  { label: "Inspect", action: { type: "callback", value: "opaque-tts" } },
                ],
              },
            ]
          : Array.from({ length: 201 }, () => ({ type: "divider" as const })),
      };
      const original = {
        text: controls || route === "core" ? "Spoken summary" : undefined,
        mediaUrl: voiceUrl,
        audioAsVoice: true,
        presentation,
        ttsSupplement: { spokenText: "Spoken summary", visibleTextAlreadyDelivered: visible },
      };
      const onDeliveryResult = vi.fn();
      await sendPayload(route === "core" ? await render(original) : original, {
        ...implicitReply,
        onDeliveryResult,
      });
      const sendsText = controls || !visible;
      const text = deliveredText();
      if (controls) {
        expect(text).toContain("Presentation detail");
        expect(text).toContain("- Help: `/help`");
        expect(text).toContain("- Inspect");
        expect(text).not.toContain("opaque-tts");
      } else {
        expect(text).toBe(visible ? "" : "Spoken summary");
      }
      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMessageFeishuMock).toHaveBeenCalledTimes(sendsText ? 1 : 0);
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      expect(onDeliveryResult).toHaveBeenCalledTimes(sendsText ? 2 : 1);
      expect(textCall()?.replyToMessageId).toBe(sendsText ? "om_reply" : undefined);
      expect(mediaCall()?.replyToMessageId).toBe(sendsText ? undefined : "om_reply");
      if (sendsText) {
        expect(sendMessageFeishuMock.mock.invocationCallOrder[0]).toBeLessThan(
          sendMediaFeishuMock.mock.invocationCallOrder[0] ?? 0,
        );
      }
    },
  );
});

describe("Feishu native presentation delivery", () => {
  it("renders a presentation-only payload for core delivery", async () => {
    const presentation: MessagePresentation = {
      title: "Approval",
      tone: "success",
      blocks: [
        { type: "text", text: "Approve the request?" },
        {
          type: "buttons",
          buttons: [
            { label: "Approve", value: "/approve req_1 allow-once", style: "success" },
            {
              label: "Deny",
              action: { type: "command", command: "/approve req_1 deny" },
              url: "https://example.com/stale",
              webApp: { url: "https://example.com/stale-app" },
              style: "danger",
            },
          ],
        },
      ],
    };
    const rendered = await render({ presentation });
    expect(rendered.text).toBe(
      "Approval\n\nApprove the request?\n\n- Approve\n- Deny: `/approve req_1 deny`",
    );
    expectResult(await sendPayload(rendered), "native_card_msg");
    expect(cardCall()?.header).toEqual({
      title: { tag: "plain_text", content: "Approval" },
      template: "green",
    });
    expect(cardCall()?.body.elements).toEqual([
      { tag: "markdown", content: "Approve the request?" },
      ...[
        { label: "Approve", type: "primary", command: "/approve req_1 allow-once" },
        { label: "Deny", type: "danger", command: "/approve req_1 deny" },
      ].map(({ label, type, command }) => ({
        tag: "button",
        text: { tag: "plain_text", content: label },
        type,
        behaviors: [
          {
            type: "callback",
            value: {
              oc: "ocf1",
              k: "quick",
              a: "feishu.payload.button",
              q: command,
            },
          },
        ],
      })),
    ]);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("preserves the full authored presentation title", async () => {
    const title = "x".repeat(3999) + " \n  TAIL_NOT_DELIVERED";
    const presentation = adaptMessagePresentationForChannel({
      presentation: { title, blocks: [] },
      capabilities: feishuOutbound.presentationCapabilities,
    });
    const rendered = await render({ presentation });
    expect(rendered.text).toBe(title);
    await sendPayload(rendered);
    const sent = cardCall();
    expect(
      [
        sent?.header?.title?.content ?? "",
        ...(sent?.body?.elements ?? []).map((element: { content?: string }) =>
          (element.content ?? "").replace(/<\/?font[^>]*>/gu, ""),
        ),
      ].join(""),
    ).toBe(title);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("sends approved media before the native card and consumes its implicit reply once", async () => {
    const readFile = vi.fn(async () => Buffer.from("approved image"));
    const mediaAccess = {
      localRoots: ["/approved/workspace"],
      workspaceDir: "/approved/workspace",
      readFile,
    };
    const result = await sendPayload(
      { text: nativeCardText, mediaUrls: ["image.png", "summary.png"] },
      {
        ...implicitReply,
        mediaAccess,
        mediaLocalRoots: ["/legacy/workspace"],
        mediaReadFile: readFile,
      },
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(2);
    for (const [index, mediaUrl] of ["image.png", "summary.png"].entries()) {
      expect(mediaCall(index)).toMatchObject({
        to: "chat_1",
        accountId: "main",
        mediaUrl,
        mediaAccess,
        mediaLocalRoots: ["/legacy/workspace"],
        mediaReadFile: readFile,
        replyToMessageId: index === 0 ? "om_reply" : undefined,
      });
      expect(mediaCall(index)?.mediaAccess).toBe(mediaAccess);
      expect(sendMediaFeishuMock.mock.invocationCallOrder[index]).toBeLessThan(
        sendCardFeishuMock.mock.invocationCallOrder[0] ?? 0,
      );
    }
    expect(sendCardFeishuMock.mock.calls[0]?.[0]?.replyToMessageId).toBeUndefined();
    expectResult(result, "native_card_msg");
  });

  it("keeps typed approval actions out of callback envelopes", async () => {
    const rendered = await render({
      presentation: buttons([
        {
          label: "Allow",
          action: {
            type: "approval",
            approvalId: "approval-1",
            approvalKind: "plugin",
            decision: "allow-once",
          },
          value: "/approve approval-1 allow-once",
        },
      ]),
    });
    expect(rendered.text).toBe("- Allow");
    await sendPayload(rendered);
    expect(cardCall()?.body.elements).toEqual([{ tag: "markdown", content: "- Allow" }]);
  });

  it("escapes generated markup and rejects unsafe button URLs", async () => {
    await sendPayload({
      text: 'Choose <at id="ou_1">',
      presentation: {
        blocks: [
          { type: "context", text: '</font><at id="ou_2">Injected</at>' },
          {
            type: "buttons",
            buttons: [
              { label: "Open", webApp: { url: "https://example.com/path" } },
              { label: "Bad", url: "javascript:alert(1)" },
            ],
          },
        ],
      },
    });
    expect(cardCall()?.body.elements).toEqual([
      { tag: "markdown", content: 'Choose &lt;at id="ou_1"&gt;' },
      {
        tag: "markdown",
        content: "<font color='grey'>&lt;/font&gt;&lt;at id=\"ou_2\"&gt;Injected&lt;/at&gt;</font>",
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Open" },
        type: "default",
        behaviors: [{ type: "open_url", default_url: "https://example.com/path" }],
      },
      { tag: "markdown", content: "- Bad" },
    ]);
    expect(JSON.stringify(cardCall())).not.toContain("javascript:");
  });

  it("sanitizes caller-supplied legacy card content and actions", async () => {
    await sendPayload({
      text: "fallback",
      channelData: {
        feishu: {
          card: {
            schema: "2.0",
            header: {
              title: { tag: "plain_text", content: "Unsafe card" },
              template: "not-a-template",
            },
            body: {
              elements: [
                { tag: "img", img_key: "image-secret" },
                { tag: "markdown", content: '<at id="ou_1">ping</at>' },
                {
                  tag: "action",
                  actions: [
                    {
                      tag: "button",
                      text: { tag: "plain_text", content: "Promote" },
                      type: "success",
                      url: "https://example.com/promote",
                    },
                    {
                      tag: "button",
                      text: { tag: "plain_text", content: "Bad link" },
                      url: "file:///etc/passwd",
                    },
                    {
                      tag: "button",
                      text: { tag: "plain_text", content: "Good link" },
                      url: "https://example.com",
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    });
    expect(cardCall()?.header.template).toBe("blue");
    expect(cardCall()?.body.elements).toEqual([
      { tag: "markdown", content: '&lt;at id="ou_1"&gt;ping&lt;/at&gt;' },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Promote" },
        type: "primary",
        behaviors: [{ type: "open_url", default_url: "https://example.com/promote" }],
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Good link" },
        type: "default",
        behaviors: [{ type: "open_url", default_url: "https://example.com" }],
      },
    ]);
    expect(JSON.stringify(cardCall())).not.toContain("file://");
    expect(JSON.stringify(cardCall())).not.toContain("image-secret");
  });

  it("keeps unsupported native element shapes on the text fallback path", async () => {
    const text = JSON.stringify({
      elements: [
        { tag: "img", img_key: "image-secret" },
        { tag: "div", text: { tag: "unsupported", content: "Unsupported text" } },
      ],
    });
    expectResult(await sendPayload({ text }), "text_msg");
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(textCall()?.text).toBe(text);
  });

  it("prefers structured interactive content over raw card JSON", async () => {
    await sendPayload({
      text: nativeCardText,
      interactive: { blocks: [{ type: "text", text: "Interactive body" }] },
    });
    expect(cardCall()?.header).toBeUndefined();
    expect(cardCall()?.body.elements).toEqual([{ tag: "markdown", content: "Interactive body" }]);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("rejects oversized native cards without leaking JSON as text", async () => {
    await expect(
      sendPayload({
        text: "safe fallback",
        channelData: {
          feishu: {
            card: {
              schema: "2.0",
              body: { elements: [{ tag: "markdown", content: "x".repeat(31 * 1024) }] },
            },
          },
        },
      }),
    ).rejects.toThrow("Feishu native card exceeds the 30 KB or 200-element API limit");
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("sends oversized presentation media once before complete safe fallback text", async () => {
    const presentation = oversizedPresentation();
    presentation.blocks.push({
      type: "buttons",
      buttons: [
        { label: "Unavailable link", url: "javascript:alert(1)" },
        { label: "Docs", action: { type: "url", url: "https://example.com/docs" } },
        { label: "Help", action: { type: "command", command: "/help" } },
        {
          label: "[Inspect](https://example.com/label)",
          action: { type: "callback", value: "opaque-inspect" },
        },
        { label: "Disabled", disabled: true, action: { type: "command", command: "/disabled" } },
      ],
    });
    const payload = { text: nativeCardText, presentation, mediaUrl: imageUrl };
    const rendered = await render(payload);
    expect(rendered.text).not.toContain(nativeCardText);
    for (const candidate of [payload, rendered]) {
      sendMessageFeishuMock.mockClear();
      sendMediaFeishuMock.mockClear();
      expectResult(
        await sendPayload(candidate, { replyToId: " ", threadId: "om_thread" }),
        "text_msg",
      );
      const text = deliveredText();
      expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
      expect(mediaCall()).toMatchObject({
        mediaUrl: imageUrl,
        replyToMessageId: "om_thread",
        replyInThread: true,
      });
      expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(1);
      for (const [params] of sendMessageFeishuMock.mock.calls) {
        expect(params.text.length).toBeLessThanOrEqual(4000);
        expect(params).toMatchObject({ replyToMessageId: "om_thread", replyInThread: true });
      }
      expect(text).toContain("account-0-");
      expect(text).toContain("account-399-");
      expect(text).not.toContain(nativeCardText);
      expect(text).toContain("- Unavailable link");
      expect(text).not.toContain("javascript:");
      expect(text).toContain("- Docs: https://example.com/docs");
      expect(text).toContain("- Help: `/help`");
      expect(text).toContain("- \\[Inspect\\]\\(https://example.com/label\\)");
      expect(text).not.toContain("opaque-inspect");
      expect(text).toContain("- Disabled");
      expect(text).not.toContain("/disabled");
      expect(sendMediaFeishuMock.mock.invocationCallOrder[0]).toBeLessThan(
        sendMessageFeishuMock.mock.invocationCallOrder[0] ?? 0,
      );
    }
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });
});

describe("Feishu document comments", () => {
  it("reports the accepted comment ID when a reply falls back to add_comment", async () => {
    const onDeliveryResult = vi.fn();
    deliverCommentThreadTextMock.mockResolvedValueOnce({
      delivery_mode: "add_comment",
      comment_id: "comment_msg",
      reply_id: "reply_from_add_comment",
    });
    expectResult(
      await sendText("whole-comment follow-up", {
        to: commentTarget,
        onDeliveryResult,
      }),
      "comment_msg",
    );
    expect(commentCall()).toMatchObject({
      file_token: "doxcn123",
      file_type: "docx",
      comment_id: "7623358762119646411",
      content: "whole-comment follow-up",
    });
    expect(onDeliveryResult.mock.calls[0]?.[0]?.messageId).toBe("comment_msg");
  });

  it("separates media from complete chunked presentation fallback", async () => {
    const presentation = tablePresentation(90, 48);
    const rendered = await render({ presentation });
    expect(rendered.channelData?.feishu).toHaveProperty("card");
    expectResult(
      await sendPayload(
        {
          presentation,
          mediaUrl: voiceUrl,
          audioAsVoice: true,
          ttsSupplement: { spokenText: "Readable answer" },
          channelData: propagation,
        },
        { to: commentTarget },
      ),
      "reply_msg",
    );
    const chunks = deliverCommentThreadTextMock.mock.calls.map(([, params]) => params.content);
    expect(chunks[0]).toBe(voiceUrl);
    expect(chunks.slice(1).length).toBeGreaterThan(1);
    expect(chunks.every((chunk: string) => Array.from(chunk).length <= 4000)).toBe(true);
    expect(chunks.join("\n")).toContain("account-89-");
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });

  it("preserves select command guidance through core-rendered document comments", async () => {
    const presentation: MessagePresentation = {
      blocks: [
        {
          type: "select",
          placeholder: "Choose deployment",
          options: [{ label: "Deploy", action: { type: "command", command: "/deploy staging" } }],
        },
      ],
    };
    expectResult(
      await sendPayload(await render({ presentation }, commentTarget), { to: commentTarget }),
      "reply_msg",
    );
    expect(commentCall()?.content).toBe(
      "Choose deployment:\n- Deploy: `/deploy staging`\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.",
    );
  });

  it("rejects card-only document comments instead of reporting empty delivery", async () => {
    await expect(sendPayload({ text: nativeCardText }, { to: commentTarget })).rejects.toThrow(
      "Feishu native cards cannot be sent to document comments without a text or media fallback.",
    );
    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it.each(
    feishuSecretRefPolicyCases.filter(
      ({ name }) =>
        name === "provider allowlist excluding the selected credential" ||
        name === "configured env provider allowing the selected credential",
    ),
  )("respects document-comment SecretRef policy: $name", async (testCase) => {
    vi.stubEnv(FEISHU_SELECTED_SECRET_ENV, "selected-secret");
    vi.stubEnv(FEISHU_SIBLING_SECRET_ENV, "sibling-secret");
    createFeishuClientMock.mockImplementationOnce((account) => {
      if (!account.appId || !account.appSecret) {
        throw new Error(
          'Feishu credentials not configured for account "' + account.accountId + '"',
        );
      }
      return { request: vi.fn() };
    });
    try {
      const result = sendText("handled in thread", {
        cfg: createFeishuSecretRefPolicyConfig(testCase),
        to: commentTarget,
        accountId: "selected",
      });
      if (!testCase.configured) {
        await expect(result).rejects.toThrow(
          'Feishu credentials not configured for account "selected"',
        );
        expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
        expect(sendMessageFeishuMock).not.toHaveBeenCalled();
        expect(sendMediaFeishuMock).not.toHaveBeenCalled();
      } else {
        expectResult(await result, "reply_msg");
        expect(createFeishuClientMock).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: "selected",
            appId: "selected-app",
            appSecret: "selected-secret", // pragma: allowlist secret
            configured: true,
          }),
        );
        expect(deliverCommentThreadTextMock).toHaveBeenCalledOnce();
        expect(commentCall()?.content).toBe("handled in thread");
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sends comment replies without waiting for ambient typing cleanup", async () => {
    let release: ((value: boolean) => void) | undefined;
    cleanupAmbientCommentTypingReactionMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const result = sendText("handled in thread", {
      to: commentTarget,
      replyToId: "reply_ambient_1",
    });
    try {
      const completed = await Promise.race([
        Promise.resolve(result).then(() => true),
        new Promise<false>((resolve) => {
          setImmediate(() => resolve(false));
        }),
      ]);
      expect(completed).toBe(true);
      expect(deliverCommentThreadTextMock).toHaveBeenCalled();
      expect(cleanupAmbientCommentTypingReactionMock.mock.calls[0]?.[0]).toMatchObject({
        client: expect.anything(),
        deliveryContext: { channel: "feishu", to: commentTarget, threadId: "reply_ambient_1" },
      });
    } finally {
      release?.(false);
      await result;
    }
  });

  it("redacts private media in document-comment fallbacks", async () => {
    const mediaUrl = "http://127.0.0.1:3000/private.mp3";
    expectResult(
      await sendMedia({ to: commentTarget, text: "see attachment", mediaUrl }),
      "reply_msg",
    );
    expect(commentCall()?.content).toBe("see attachment\n\nMedia upload failed. Please try again.");
    expect(commentCall()?.content).not.toContain(mediaUrl);
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });
});

describe("Feishu chunked delivery and media receipts", () => {
  it("sends and records text-only media requests once", async () => {
    const onDeliveryResult = vi.fn();
    expectResult(
      await sendMedia({
        text: "text without an attachment",
        mediaUrl: undefined,
        onDeliveryResult,
      }),
      "text_msg",
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.messageId)).toEqual([
      "text_msg",
    ]);
  });

  it.each([
    {
      name: "implicit first",
      reply: implicitReply,
      target: "om_reply",
      sticky: false,
      thread: false,
    },
    {
      name: "explicit first",
      reply: { ...implicitReply, replyToIdSource: "explicit" as const, threadId: "om_other_topic" },
      target: "om_reply",
      sticky: true,
      thread: false,
    },
  ])(
    "records all caption chunks and media with $name reply semantics",
    async ({ reply, target, sticky, thread }) => {
      sendMessageFeishuMock.mockImplementation(async () => ({
        messageId: "caption_" + sendMessageFeishuMock.mock.calls.length,
      }));
      const onDeliveryResult = vi.fn();
      const result = await sendMedia({ text: expandedText, ...reply, onDeliveryResult });
      expect(sendMessageFeishuMock.mock.calls.length).toBeGreaterThan(1);
      const ids = sendMessageFeishuMock.mock.calls.map((_, index) => "caption_" + (index + 1));
      expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.messageId)).toEqual([
        ...ids,
        "media_msg",
      ]);
      expect(result?.receipt?.parts.map((part) => part.platformMessageId)).toEqual([
        ...ids,
        "media_msg",
      ]);
      expect(result?.receipt?.primaryPlatformMessageId).toBe("media_msg");
      expect(result?.messageId).toBe("media_msg");
      expect(deliveredText()).toContain("a  \na");
      for (const [index, [params]] of sendMessageFeishuMock.mock.calls.entries()) {
        expect(params.preparedPostText).toBe(true);
        expect(params.text.length).toBeLessThanOrEqual(4000);
        expect(params.replyToMessageId).toBe(sticky || index === 0 ? target : undefined);
        expect(params.replyInThread).toBe(thread ? true : index === 0 ? false : undefined);
      }
      expect(mediaCall()?.replyToMessageId).toBe(sticky ? target : undefined);
    },
  );

  it("stops caption fanout and media when accepted progress cannot be persisted", async () => {
    const onDeliveryResult = vi.fn().mockRejectedValueOnce(new Error("progress write failed"));
    await expect(sendMedia({ text: expandedText, onDeliveryResult })).rejects.toThrow(
      "progress write failed",
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(onDeliveryResult).toHaveBeenCalledOnce();
  });

  it("does not emit fallback after accepted media loses its receipt", async () => {
    const error = createChannelPartialDeliveryError(new Error("missing receipt"), {
      messageIds: [],
      visibleReplySent: true,
    });
    sendMediaFeishuMock.mockRejectedValueOnce(error);
    await expect(sendMedia()).rejects.toBe(error);
    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });

  it("does not resend accepted media when delivery persistence fails", async () => {
    const onDeliveryResult = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("progress write failed"));
    await expect(sendMedia({ text: "caption text", onDeliveryResult })).rejects.toThrow(
      "progress write failed",
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.messageId)).toEqual([
      "text_msg",
      "media_msg",
    ]);
  });

  it("consumes an implicit reply on degraded voice media before sending skipped text", async () => {
    sendMediaFeishuMock.mockResolvedValueOnce({
      messageId: "file_msg",
      voiceIntentDegradedToFile: true,
    });
    await sendMedia({
      text: "spoken reply",
      mediaUrl: voiceUrl,
      audioAsVoice: true,
      ...implicitReply,
    });
    expect(mediaCall()).toMatchObject({
      mediaUrl: voiceUrl,
      audioAsVoice: true,
      replyToMessageId: "om_reply",
    });
    expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    expect(textCall()).toMatchObject({ text: "spoken reply", replyToMessageId: undefined });
  });

  it("records a caption before upload failure and consumes its reply only once", async () => {
    sendMessageFeishuMock
      .mockResolvedValueOnce({ messageId: "caption_msg" })
      .mockResolvedValueOnce({ messageId: "fallback_msg" });
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    const onDeliveryResult = vi.fn();
    const result = await sendMedia({ text: "caption text", ...implicitReply, onDeliveryResult });
    expect(textCall()).toMatchObject({ text: "caption text", replyToMessageId: "om_reply" });
    expect(textCall(1)).toMatchObject({ text: "📎 " + imageUrl, replyToMessageId: undefined });
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.messageId)).toEqual([
      "caption_msg",
      "fallback_msg",
    ]);
    expectResult(result, "fallback_msg");
  });

  it.each([
    ["local path", "/tmp/openclaw-feishu-local-voice.mp3"],
    ["file URL", "file:///tmp/openclaw-feishu-local-voice.mp3"],
    ["loopback URL", "http://127.0.0.1:3000/private.mp3"],
    ["private-DNS URL", "https://files.example.test/voice.mp3"],
    ["credentialed URL", "https://user@example.com/voice.mp3"],
    ["control-character URL", "https://example.com/\nhttp://127.0.0.1/private"],
  ])("redacts a %s from upload failure text", async (_, mediaUrl) => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    await sendMedia({ text: "spoken reply", mediaUrl, audioAsVoice: true });
    expect(sendMessageFeishuMock).toHaveBeenCalledOnce();
    expect(textCall()?.text).toBe("spoken reply\n\nMedia upload failed. Please try again.");
    expect(textCall()?.text).not.toContain(mediaUrl);
  });

  it("preserves all accepted card caption chunks in propagated upload failures", async () => {
    sendStructuredCardFeishuMock.mockImplementation(async () => ({
      messageId: "caption_" + sendStructuredCardFeishuMock.mock.calls.length,
      chatId: "chat_1",
    }));
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    const fence = "```";
    const error = await sendMedia({
      text: fence + "text\n" + "x".repeat(8500) + "\n" + fence,
      propagateMediaUploadFailure: true,
    })?.catch((cause: unknown) => cause);
    expect(isChannelPartialDeliveryError(error)).toBe(true);
    if (!isChannelPartialDeliveryError(error)) {
      throw new Error("Expected partial delivery");
    }
    expect(error.deliveryResult.visibleReplySent).toBe(true);
    expect(new Set(error.deliveryResult.messageIds)).toEqual(
      new Set(["caption_1", "caption_2", "caption_3"]),
    );
    expect(error.deliveryResult.receipt?.parts.map((part) => part.platformMessageId)).toEqual([
      "caption_1",
      "caption_2",
      "caption_3",
    ]);
    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
  });

  it("propagates upload failure through payload fallback without claiming delivery", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    const error = await sendPayload({
      text: "see attachment",
      mediaUrl: imageUrl,
      channelData: propagation,
    })?.catch((cause: unknown) => cause);
    expect(isChannelPartialDeliveryError(error)).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Feishu send could not deliver the requested media attachment");
    expect(sendMediaFeishuMock).toHaveBeenCalledOnce();
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
