// Slack enterprise reply tests isolate the listener-scoped direct sender from general delivery.
import { describe, expect, it, vi } from "vitest";

const sendMessageSlack = vi.hoisted(() => vi.fn());
const loadOutboundMediaFromUrl = vi.hoisted(() => vi.fn());
const fetchWithSsrFGuard = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  withTrustedEnvProxyGuardedFetchMode: (value: unknown) => value,
}));
vi.mock("openclaw/plugin-sdk/error-runtime", () => ({
  formatErrorMessage: (error: unknown) => String(error),
}));
vi.mock("openclaw/plugin-sdk/reply-chunking", () => ({
  chunkMarkdownTextWithMode: (text: string) => [text],
  isSilentReplyText: () => false,
  resolveChunkMode: () => "length",
  resolveTextChunkLimit: () => 4_000,
  SILENT_REPLY_TOKEN: "NO_REPLY",
}));
vi.mock("openclaw/plugin-sdk/reply-payload", () => ({
  deliverTextOrMediaReply: async (params: {
    payload: { mediaUrl?: string };
    text: string;
    chunkText?: (text: string) => string[];
    sendText: (text: string) => Promise<void>;
    sendMedia: (params: { mediaUrl: string; caption?: string }) => Promise<void>;
  }) => {
    if (params.payload.mediaUrl) {
      await params.sendMedia({ mediaUrl: params.payload.mediaUrl, caption: params.text });
      return "sent";
    }
    for (const chunk of params.chunkText?.(params.text) ?? [params.text]) {
      await params.sendText(chunk);
    }
    return "sent";
  },
  getReplyPayloadTtsSupplement: () => undefined,
  resolveTextChunksWithFallback: (text: string, chunks: string[]) =>
    chunks.length > 0 ? chunks : text ? [text] : [],
  resolveSendableOutboundReplyParts: (payload: { text?: string; mediaUrl?: string }) => ({
    hasContent: Boolean(payload.text || payload.mediaUrl),
    hasMedia: Boolean(payload.mediaUrl),
    hasText: Boolean(payload.text),
    mediaUrls: payload.mediaUrl ? [payload.mediaUrl] : [],
    text: payload.text ?? "",
    trimmedText: payload.text?.trim() ?? "",
  }),
}));
vi.mock("openclaw/plugin-sdk/reply-reference", () => ({
  createReplyReferencePlanner: () => ({
    hasReplied: () => false,
    markSent: () => {},
    peek: () => undefined,
    use: () => undefined,
  }),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard,
}));
vi.mock("../blocks-fallback.js", () => ({ buildSlackBlocksFallbackText: () => "" }));
vi.mock("../format.js", () => ({
  markdownToSlackMrkdwnChunks: (text: string, limit: number) => {
    const chunks: string[] = [];
    for (let offset = 0; offset < text.length; offset += limit) {
      chunks.push(text.slice(offset, offset + limit));
    }
    return chunks;
  },
}));
vi.mock("../message-sent-hook.js", () => ({ emitSlackMessageSentHooks: () => {} }));
vi.mock("../reply-blocks.js", () => ({ resolveSlackReplyBlocks: () => undefined }));
vi.mock("../runtime-api.js", () => ({ loadOutboundMediaFromUrl }));
vi.mock("../slack-text-chunks.js", () => ({
  resolveSlackTextChunks: ({ text, textLimit }: { text: string; textLimit: number }) => {
    const chunks: string[] = [];
    for (let offset = 0; offset < text.length; offset += textLimit) {
      chunks.push(text.slice(offset, offset + textLimit));
    }
    return chunks;
  },
}));
vi.mock("../truncate.js", () => ({ truncateSlackText: (text: string) => text }));
vi.mock("./send.runtime.js", () => ({ sendMessageSlack }));

const clientDelivery = await import("../client-delivery.js");
const { deliverReplies } = await import("./replies.js");

function buildSlackIdentityError(error: string, needed?: string): Error {
  return Object.assign(new Error(`Slack API error: ${error}`), {
    data: { error, ...(needed ? { needed } : {}) },
  });
}

describe("enterprise immediate replies", () => {
  it("uses the validated listener client without entering general Slack send", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: "123.456", channel: "C123" });
    const listenerClient = { chat: { postMessage } } as never;
    const deliverySpy = vi.spyOn(clientDelivery, "postSlackMessageBestEffort");

    try {
      const result = await deliverReplies({
        cfg: { channels: { slack: { enterpriseOrgInstall: true, unfurlMedia: true } } },
        replies: [{ text: "hello" }],
        target: "C123",
        token: "must-not-be-used",
        accountId: "enterprise",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        textLimit: 4_000,
        replyToMode: "off",
        eventScope: {
          apiAppId: "A1",
          enterpriseId: "E1",
          isEnterpriseInstall: true,
          teamId: "T1",
          client: listenerClient,
        },
      });

      expect(sendMessageSlack).not.toHaveBeenCalled();
      expect(deliverySpy.mock.calls[0]?.[0].client).toBe(listenerClient);
      expect(postMessage).toHaveBeenCalledOnce();
      expect(postMessage).toHaveBeenCalledWith({
        channel: "C123",
        text: "hello",
        unfurl_links: false,
        unfurl_media: true,
      });
      expect(result).toMatchObject({ messageId: "123.456", channelId: "C123" });
    } finally {
      deliverySpy.mockRestore();
    }
  });

  it("plans all text chunks inside the listener-scoped sender and returns one receipt", async () => {
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: "123.001", channel: "C123" })
      .mockResolvedValueOnce({ ok: true, ts: "123.002", channel: "C123" })
      .mockResolvedValueOnce({ ok: true, ts: "123.003", channel: "C123" });

    const result = await deliverReplies({
      cfg: { channels: { slack: { enterpriseOrgInstall: true } } },
      replies: [{ text: "12345678Z" }],
      target: "C123",
      token: "must-not-be-used",
      accountId: "enterprise",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      textLimit: 4,
      replyToMode: "off",
      eventScope: {
        apiAppId: "A1",
        enterpriseId: "E1",
        isEnterpriseInstall: true,
        teamId: "T1",
        client: { chat: { postMessage } } as never,
      },
    });

    expect(sendMessageSlack).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenNthCalledWith(1, {
      channel: "C123",
      text: "1234",
      unfurl_links: false,
    });
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      text: "5678",
      unfurl_links: false,
    });
    expect(postMessage).toHaveBeenNthCalledWith(3, {
      channel: "C123",
      text: "Z",
      unfurl_links: false,
    });
    expect(result).toMatchObject({
      messageId: "123.003",
      channelId: "C123",
      receipt: {
        primaryPlatformMessageId: "123.001",
        platformMessageIds: ["123.001", "123.002", "123.003"],
      },
    });
  });

  it("retries transient DNS failures through the shared listener-client post primitive", async () => {
    const dnsError = Object.assign(new Error("getaddrinfo EAI_AGAIN slack.com"), {
      code: "EAI_AGAIN",
    });
    const postMessage = vi
      .fn()
      .mockRejectedValueOnce(dnsError)
      .mockResolvedValueOnce({ ok: true, ts: "123.456", channel: "C123" });
    const { sendImmediateEnterpriseSlackReply } = await import("./immediate-enterprise-reply.js");

    const result = await sendImmediateEnterpriseSlackReply(
      {
        apiAppId: "A1",
        enterpriseId: "E1",
        isEnterpriseInstall: true,
        teamId: "T1",
        client: { chat: { postMessage } } as never,
      },
      {
        target: "C123",
        text: "hello",
        cfg: { channels: { slack: { enterpriseOrgInstall: true } } },
        textLimit: 4_000,
      },
    );

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ messageId: "123.456", channelId: "C123" });
  });

  it("preserves unfurl privacy defaults for block replies", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ok: true, ts: "123.456", channel: "C123" });
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hello" } }] as never;
    const { sendImmediateEnterpriseSlackReply } = await import("./immediate-enterprise-reply.js");

    await sendImmediateEnterpriseSlackReply(
      {
        apiAppId: "A1",
        enterpriseId: "E1",
        isEnterpriseInstall: true,
        teamId: "T1",
        client: { chat: { postMessage } } as never,
      },
      {
        target: "C123",
        text: "fallback",
        blocks,
        cfg: { channels: { slack: { enterpriseOrgInstall: true } } },
        textLimit: 4_000,
        unfurlMedia: false,
      },
    );

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "fallback",
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it("retries without identity when the listener client lacks chat:write.customize", async () => {
    const postMessage = vi
      .fn()
      .mockRejectedValueOnce(buildSlackIdentityError("missing_scope", "chat:write.customize"))
      .mockResolvedValueOnce({ ok: true, ts: "123.456", channel: "C123" });
    const { sendImmediateEnterpriseSlackReply } = await import("./immediate-enterprise-reply.js");

    await sendImmediateEnterpriseSlackReply(
      {
        apiAppId: "A1",
        enterpriseId: "E1",
        isEnterpriseInstall: true,
        teamId: "T1",
        client: { chat: { postMessage } } as never,
      },
      {
        target: "C123",
        text: "hello",
        identity: { username: "OpenClaw", iconEmoji: ":robot_face:" },
        cfg: { channels: { slack: { enterpriseOrgInstall: true } } },
        textLimit: 4_000,
      },
    );

    expect(postMessage).toHaveBeenNthCalledWith(1, {
      channel: "C123",
      text: "hello",
      username: "OpenClaw",
      icon_emoji: ":robot_face:",
      unfurl_links: false,
    });
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      text: "hello",
      unfurl_links: false,
    });
  });

  it("retries with username only when Slack rejects the listener-scoped custom icon", async () => {
    const postMessage = vi
      .fn()
      .mockRejectedValueOnce(buildSlackIdentityError("invalid_arguments"))
      .mockResolvedValueOnce({ ok: true, ts: "123.456", channel: "C123" });
    const { sendImmediateEnterpriseSlackReply } = await import("./immediate-enterprise-reply.js");

    await sendImmediateEnterpriseSlackReply(
      {
        apiAppId: "A1",
        enterpriseId: "E1",
        isEnterpriseInstall: true,
        teamId: "T1",
        client: { chat: { postMessage } } as never,
      },
      {
        target: "C123",
        text: "hello",
        identity: { username: "OpenClaw", iconUrl: "https://example.com/icon.png" },
        cfg: { channels: { slack: { enterpriseOrgInstall: true } } },
        textLimit: 4_000,
      },
    );

    expect(postMessage).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      text: "hello",
      username: "OpenClaw",
      unfurl_links: false,
    });
  });

  it("drops identity when Slack also rejects the listener-scoped username retry", async () => {
    const postMessage = vi
      .fn()
      .mockRejectedValueOnce(buildSlackIdentityError("invalid_arg_name"))
      .mockRejectedValueOnce(buildSlackIdentityError("invalid_arguments"))
      .mockResolvedValueOnce({ ok: true, ts: "123.456", channel: "C123" });
    const { sendImmediateEnterpriseSlackReply } = await import("./immediate-enterprise-reply.js");

    await sendImmediateEnterpriseSlackReply(
      {
        apiAppId: "A1",
        enterpriseId: "E1",
        isEnterpriseInstall: true,
        teamId: "T1",
        client: { chat: { postMessage } } as never,
      },
      {
        target: "C123",
        text: "hello",
        identity: { username: "OpenClaw", iconEmoji: ":robot_face:" },
        cfg: { channels: { slack: { enterpriseOrgInstall: true } } },
        textLimit: 4_000,
      },
    );

    expect(postMessage).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      text: "hello",
      username: "OpenClaw",
      unfurl_links: false,
    });
    expect(postMessage).toHaveBeenNthCalledWith(3, {
      channel: "C123",
      text: "hello",
      unfurl_links: false,
    });
  });

  it("uploads media through the same listener-scoped client", async () => {
    loadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("image"),
      contentType: "image/png",
      fileName: "image.png",
    });
    const release = vi.fn().mockResolvedValue(undefined);
    fetchWithSsrFGuard.mockResolvedValue({ response: { ok: true, status: 200 }, release });
    const getUploadURLExternal = vi.fn().mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload",
      file_id: "F123",
    });
    const completeUploadExternal = vi.fn().mockResolvedValue({ ok: true });
    const postMessage = vi.fn();

    const result = await deliverReplies({
      cfg: { channels: { slack: { enterpriseOrgInstall: true } } },
      replies: [{ text: "caption", mediaUrl: "https://example.com/image.png" }],
      target: "C123",
      token: "must-not-be-used",
      accountId: "enterprise",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      textLimit: 4_000,
      mediaMaxBytes: 20 * 1024 * 1024,
      replyToMode: "off",
      eventScope: {
        apiAppId: "A1",
        enterpriseId: "E1",
        isEnterpriseInstall: true,
        teamId: "T1",
        client: {
          chat: { postMessage },
          files: { getUploadURLExternal, completeUploadExternal },
        } as never,
      },
    });

    expect(sendMessageSlack).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(getUploadURLExternal).toHaveBeenCalledWith({ filename: "image.png", length: 5 });
    expect(completeUploadExternal).toHaveBeenCalledWith({
      files: [{ id: "F123", title: "image.png" }],
      channel_id: "C123",
      initial_comment: "caption",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ messageId: "F123", channelId: "C123" });
  });

  it("uses the first Slack-safe caption chunk for upload and posts the remainder", async () => {
    loadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("image"),
      contentType: "image/png",
      fileName: "image.png",
    });
    fetchWithSsrFGuard.mockResolvedValue({
      response: { ok: true, status: 200 },
      release: vi.fn().mockResolvedValue(undefined),
    });
    const getUploadURLExternal = vi.fn().mockResolvedValue({
      ok: true,
      upload_url: "https://files.slack.com/upload",
      file_id: "F123",
    });
    const completeUploadExternal = vi.fn().mockResolvedValue({ ok: true });
    const postMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, ts: "123.001", channel: "C123" })
      .mockResolvedValueOnce({ ok: true, ts: "123.002", channel: "C123" });

    const result = await deliverReplies({
      cfg: { channels: { slack: { enterpriseOrgInstall: true } } },
      replies: [{ text: "12345678abcdefghZ", mediaUrl: "https://example.com/image.png" }],
      target: "C123",
      token: "must-not-be-used",
      accountId: "enterprise",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      textLimit: 8,
      replyToMode: "off",
      eventScope: {
        apiAppId: "A1",
        enterpriseId: "E1",
        isEnterpriseInstall: true,
        teamId: "T1",
        client: {
          chat: { postMessage },
          files: { getUploadURLExternal, completeUploadExternal },
        } as never,
      },
    });

    expect(sendMessageSlack).not.toHaveBeenCalled();
    expect(completeUploadExternal).toHaveBeenCalledWith({
      files: [{ id: "F123", title: "image.png" }],
      channel_id: "C123",
      initial_comment: "12345678",
    });
    expect(postMessage).toHaveBeenNthCalledWith(1, {
      channel: "C123",
      text: "abcdefgh",
      unfurl_links: false,
    });
    expect(postMessage).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      text: "Z",
      unfurl_links: false,
    });
    expect(result).toMatchObject({
      messageId: "123.002",
      channelId: "C123",
      receipt: {
        primaryPlatformMessageId: "F123",
        platformMessageIds: ["F123", "123.001", "123.002"],
      },
    });
  });
});
