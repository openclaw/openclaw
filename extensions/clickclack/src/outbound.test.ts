import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileClickClackUnknownSend,
  sendClickClackMedia,
  sendClickClackText,
} from "./outbound.js";
import type { CoreConfig } from "./types.js";

const createChannelMessage = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createThreadReply = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createDirectMessage = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createDirectConversation = vi.hoisted(() => vi.fn(async () => ({ id: "dm_1" })));
const createUpload = vi.hoisted(() => vi.fn(async () => ({ id: "upl_1" })));
const findUploadByNonce = vi.hoisted(() =>
  vi.fn(async () => undefined as { id: string; filename: string } | undefined),
);
const findMessageByNonce = vi.hoisted(() =>
  vi.fn(async () => undefined as { id: string; attachments?: Array<{ id: string }> } | undefined),
);
const attachUpload = vi.hoisted(() => vi.fn(async () => undefined));
const message = vi.hoisted(() =>
  vi.fn(async () => ({ id: "msg_out", attachments: [] as Array<{ id: string }> })),
);
const createClientOptions = vi.hoisted(() => vi.fn());
const loadOutboundMediaFromUrl = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({ loadOutboundMediaFromUrl }));

vi.mock("./accounts.js", () => ({
  resolveClickClackAccount: () => ({
    baseUrl: "https://clickclack.example",
    apiEndpoint: "http://127.0.0.1:8484",
    token: "test-token-placeholder",
    workspace: "wsp_1",
    accountId: "default",
    config: {},
  }),
}));

vi.mock("./http-client.js", () => ({
  createClickClackClient: (options: unknown) => {
    createClientOptions(options);
    return {
      createChannelMessage,
      createThreadReply,
      createDirectMessage,
      createDirectConversation,
      createUpload,
      findUploadByNonce,
      findMessageByNonce,
      attachUpload,
      message,
    };
  },
}));

vi.mock("./resolve.js", () => ({
  resolveWorkspaceId: async () => "wsp_1",
  resolveChannelId: async (_client: unknown, _workspaceId: string, id: string) => id,
}));

const cfg = {} as CoreConfig;

function sendTestMedia(overrides: Partial<Parameters<typeof sendClickClackMedia>[0]> = {}) {
  return sendClickClackMedia({
    cfg,
    to: "channel:general",
    text: "Artifact proof",
    mediaUrl: "/workspace/viewer-proof.ts",
    ...overrides,
  });
}

function reconcile(overrides: Partial<Parameters<typeof reconcileClickClackUnknownSend>[0]> = {}) {
  return reconcileClickClackUnknownSend({
    cfg,
    queueId: "queue-media",
    channel: "clickclack",
    to: "channel:general",
    enqueuedAt: 1,
    retryCount: 0,
    payloads: [{ text: "proof", mediaUrl: "/workspace/proof.ts" }],
    ...overrides,
  });
}

function batchPlan(
  text: string,
  mediaUrls: string[] = [],
): NonNullable<Parameters<typeof reconcile>[0]>["renderedBatchPlan"] {
  return {
    payloadCount: 1,
    textCount: 1,
    mediaCount: mediaUrls.length,
    voiceCount: 0,
    presentationCount: 0,
    interactiveCount: 0,
    channelDataCount: 0,
    items: [{ index: 0, kinds: mediaUrls.length ? ["text", "media"] : ["text"], text, mediaUrls }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createUpload.mockReset().mockResolvedValue({ id: "upl_1" });
  findUploadByNonce.mockReset().mockResolvedValue(undefined);
  findMessageByNonce.mockReset().mockResolvedValue(undefined);
  attachUpload.mockReset().mockResolvedValue(undefined);
  message.mockReset().mockResolvedValue({ id: "msg_out", attachments: [] });
  loadOutboundMediaFromUrl.mockReset();
});

describe("sendClickClackText routing", () => {
  it("marks dispatch immediately before a durable text platform write", async () => {
    const order: string[] = [];
    const onPlatformSendDispatch = vi.fn(async () => {
      order.push("dispatch");
    });
    createChannelMessage.mockImplementationOnce(async () => {
      order.push("message");
      return { id: "msg_out" };
    });

    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "durable",
      deliveryQueueId: "queue-text",
      deliveryPartIndex: 0,
      onPlatformSendDispatch,
    });

    expect(order).toEqual(["dispatch", "message"]);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "durable",
      expect.objectContaining({
        nonce: "openclaw-text:4a171ee0c18d243d8d3c510320ab1b1d317afd95b0204abec18312e57307fb24",
      }),
    );
  });

  it("sanitizes replies inside a genuine thread", async () => {
    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      threadId: "msg_thread_root",
      replyToId: "msg_root",
    });

    expect(createThreadReply).toHaveBeenCalledWith("msg_thread_root", "Done.", expect.anything());
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("sanitizes leaked tool XML in a DM quote-reply", async () => {
    await sendClickClackText({
      cfg,
      to: "dm:usr_1",
      text: '<tool_call>{"name":"exec"}</tool_call>Deploy finished.',
      replyToId: "msg_root",
    });

    expect(createDirectMessage).toHaveBeenCalledWith(
      "dm_1",
      "Deploy finished.",
      expect.objectContaining({ quotedMessageId: "msg_root" }),
    );
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("suppresses replies containing only internal scaffolding", async () => {
    await expect(
      sendClickClackText({
        cfg,
        to: "channel:general",
        text: "⚠️ 🛠️ `search repos (agent)` failed",
      }),
    ).resolves.toEqual({ outcome: "not_sent" });

    expect(createClientOptions).not.toHaveBeenCalled();
  });
});

describe("sendClickClackMedia", () => {
  beforeEach(() => {
    loadOutboundMediaFromUrl.mockResolvedValue({
      buffer: Buffer.from("const proof = true;"),
      contentType: "text/typescript",
      fileName: "viewer-proof.ts",
    });
  });

  it("keeps the generic fallback when MIME type is missing", async () => {
    loadOutboundMediaFromUrl.mockResolvedValueOnce({ buffer: Buffer.from("opaque bytes") });

    await sendTestMedia({
      text: "",
      mediaUrl: "https://files.example/missing-type",
    });

    expect(createUpload).toHaveBeenCalledWith({
      workspaceId: "wsp_1",
      buffer: Buffer.from("opaque bytes"),
      filename: "attachment",
      contentType: "application/octet-stream",
    });
    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "attachment",
      expect.objectContaining({ quotedMessageId: undefined }),
    );
  });

  it("uses the filename as the minimal media-only body and routes DMs", async () => {
    const messageId = await sendTestMedia({
      to: "dm:usr_1",
      text: "",
      mediaUrl: "https://files.example/viewer-proof.ts",
    });

    expect(createDirectConversation).toHaveBeenCalledWith("wsp_1", ["usr_1"]);
    expect(createDirectMessage).toHaveBeenCalledWith(
      "dm_1",
      "viewer-proof.ts",
      expect.objectContaining({ quotedMessageId: undefined }),
    );
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_1");
    expect(messageId).toBe("msg_out");
  });

  it("routes explicit thread targets before attaching the upload", async () => {
    await sendTestMedia({ to: "thread:msg_root", text: "Thread artifact" });

    expect(createThreadReply).toHaveBeenCalledWith(
      "msg_root",
      "Thread artifact",
      expect.anything(),
    );
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_1");
  });

  it("reuses a persisted durable upload without another multipart write", async () => {
    findUploadByNonce.mockResolvedValueOnce({
      id: "upl_existing",
      filename: "viewer-proof.ts",
    });

    await expect(sendTestMedia({ deliveryQueueId: "queue-1", deliveryPartIndex: 0 })).resolves.toBe(
      "msg_out",
    );

    expect(createUpload).not.toHaveBeenCalled();
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_existing");
  });

  it("marks dispatch once after upload and before visible message creation", async () => {
    const order: string[] = [];
    const onPlatformSendDispatch = vi.fn(async () => {
      order.push("dispatch");
    });
    createUpload.mockImplementationOnce(async () => {
      order.push("upload");
      return { id: "upl_1", filename: "viewer-proof.ts" };
    });
    createChannelMessage.mockImplementationOnce(async () => {
      order.push("message");
      return { id: "msg_out" };
    });

    await sendTestMedia({
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 0,
      onPlatformSendDispatch,
    });

    expect(order).toEqual(["upload", "dispatch", "message"]);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("rejects a durable send without a stable part index before reading media", async () => {
    await expect(sendTestMedia({ deliveryQueueId: "queue-1" })).rejects.toThrow(
      "requires a stable delivery part index",
    );

    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(createClientOptions).not.toHaveBeenCalled();
  });

  it("still rejects when attachment association and its bounded retry both fail", async () => {
    attachUpload.mockRejectedValue(new Error("attachment rejected"));

    await expect(sendTestMedia()).rejects.toThrow("attachment rejected");

    expect(createUpload).toHaveBeenCalledTimes(1);
    expect(createChannelMessage).toHaveBeenCalledTimes(1);
    expect(attachUpload).toHaveBeenCalledTimes(2);
  });
});

describe("reconcileClickClackUnknownSend", () => {
  it("reconciles a text send only when its durable message exists", async () => {
    findMessageByNonce.mockResolvedValueOnce({ id: "msg_text" });

    const result = await reconcile({
      queueId: "queue-text",
      payloads: [{ text: "recovered text" }],
      renderedBatchPlan: batchPlan("recovered text"),
    });

    expect(result).toMatchObject({
      status: "sent",
      receipt: { platformMessageIds: ["msg_text"] },
    });
    expect(findMessageByNonce).toHaveBeenCalledWith({
      workspaceId: "wsp_1",
      nonce: "openclaw-text:4a171ee0c18d243d8d3c510320ab1b1d317afd95b0204abec18312e57307fb24",
    });
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(createUpload).not.toHaveBeenCalled();
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
  });

  it("replays text through the normal sender when no durable message exists", async () => {
    const result = await reconcile({
      queueId: "queue-text",
      payloads: [{ text: "recovered text" }],
    });

    expect(result).toEqual({ status: "not_sent" });
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("proves media was not sent when its durable message is absent", async () => {
    const result = await reconcile({
      renderedBatchPlan: batchPlan("proof", ["/workspace/proof.ts"]),
    });

    expect(result).toEqual({ status: "not_sent" });
    expect(findUploadByNonce).toHaveBeenCalledWith({
      workspaceId: "wsp_1",
      nonce: "openclaw-upload:b7ec5953ddec187b357faecde36f1abf0ef8590b1cda47c199c562b9e2e24432",
    });
    expect(findMessageByNonce).toHaveBeenCalledWith({
      workspaceId: "wsp_1",
      nonce: "openclaw-media:b7ec5953ddec187b357faecde36f1abf0ef8590b1cda47c199c562b9e2e24432",
    });
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(attachUpload).not.toHaveBeenCalled();
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
  });

  it("repairs attachments only after every nonce-keyed message exists", async () => {
    findUploadByNonce
      .mockResolvedValueOnce({ id: "upl_first", filename: "first.png" })
      .mockResolvedValueOnce({ id: "upl_second", filename: "second.png" });
    findMessageByNonce
      .mockResolvedValueOnce({ id: "msg_first", attachments: [] })
      .mockResolvedValueOnce({ id: "msg_second", attachments: [{ id: "upl_second" }] });

    const result = await reconcile({
      effectiveReplyToId: "msg_source",
      payloads: [{ text: "proof", mediaUrls: ["/workspace/first.png", "/workspace/second.png"] }],
      renderedBatchPlan: batchPlan("proof", ["/workspace/first.png", "/workspace/second.png"]),
    });

    expect(result).toMatchObject({
      status: "sent",
      receipt: { platformMessageIds: ["msg_first", "msg_second"] },
    });
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(attachUpload).toHaveBeenCalledExactlyOnceWith("msg_first", "upl_first");
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
  });

  it("refuses to acknowledge a message whose nonce-keyed upload is missing", async () => {
    findMessageByNonce.mockResolvedValueOnce({ id: "msg_orphan", attachments: [] });

    const result = await reconcile();

    expect(result).toEqual({
      status: "unresolved",
      error: "ClickClack message msg_orphan exists without its nonce-keyed upload",
      retryable: false,
    });
    expect(attachUpload).not.toHaveBeenCalled();
  });
});
