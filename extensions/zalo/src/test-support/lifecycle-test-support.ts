import { request as httpRequest } from "node:http";
import {
  createPluginRuntimeMediaMock,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { expect, vi } from "vitest";
import type { ResolvedZaloAccount } from "../types.js";

type Channel = PluginRuntime["channel"];

type LifecycleMonitorSetupParams = {
  accountId: string;
  dmPolicy: "open" | "pairing";
  allowFrom?: string[];
  webhookUrl?: string;
  webhookSecret?: string;
  mediaMaxMb?: number;
};

export function createLifecycleMonitorSetup(params: LifecycleMonitorSetupParams) {
  const allowFrom = params.allowFrom ?? (params.dmPolicy === "open" ? ["*"] : undefined);
  const accountConfig = {
    webhookUrl: params.webhookUrl ?? "https://example.com/hooks/zalo",
    webhookSecret: params.webhookSecret ?? "supersecret", // pragma: allowlist secret
    dmPolicy: params.dmPolicy,
    ...(allowFrom ? { allowFrom } : {}),
    // Preserve the resolver's absent-key branch.
    ...(params.mediaMaxMb === undefined ? {} : { mediaMaxMb: params.mediaMaxMb }),
  };
  const account: ResolvedZaloAccount = {
    accountId: params.accountId,
    enabled: true,
    token: "zalo-token",
    tokenSource: "config",
    config: accountConfig,
  };
  const config: OpenClawConfig = {
    channels: {
      zalo: {
        enabled: true,
        accounts: {
          [params.accountId]: { enabled: true, ...accountConfig },
        },
      },
    },
  };
  return { account, config };
}

export function createTextUpdate(params: {
  messageId: string;
  userId: string;
  userName: string;
  chatId: string;
  text?: string;
}) {
  return {
    event_name: "message.text.received",
    message: {
      from: { id: params.userId, name: params.userName },
      chat: { id: params.chatId, chat_type: "PRIVATE" as const },
      message_id: params.messageId,
      date: Math.floor(Date.now() / 1000),
      text: params.text ?? "hello from zalo",
    },
  };
}

export function createImageUpdate(params?: {
  messageId?: string;
  userId?: string;
  displayName?: string;
  chatId?: string;
  photoUrl?: string;
  caption?: string;
  date?: number;
}) {
  return {
    event_name: "message.image.received",
    message: {
      date: params?.date ?? 1774086023728,
      chat: { chat_type: "PRIVATE" as const, id: params?.chatId ?? "chat-123" },
      caption: params?.caption ?? "",
      message_id: params?.messageId ?? "msg-123",
      message_type: "CHAT_PHOTO",
      from: {
        id: params?.userId ?? "user-123",
        is_bot: false,
        display_name: params?.displayName ?? "Test User",
      },
      photo_url: params?.photoUrl ?? "https://example.com/test-image.jpg",
    },
  };
}

export function createImageLifecycleCore() {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const buildChannelInboundEventContextMock = vi.fn(
    (params: Parameters<Channel["inbound"]["buildContext"]>[0]) =>
      finalizeInboundContextMock({
        Body: params.message.body ?? params.message.rawBody,
        BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
        RawBody: params.message.rawBody,
        CommandBody: params.message.commandBody ?? params.message.rawBody,
        From: params.from,
        To: params.reply.to,
        SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
        AccountId: params.route.accountId ?? params.accountId,
        ChatType: params.conversation.kind,
        ConversationLabel: params.conversation.label,
        SenderName: params.sender.name,
        SenderId: params.sender.id,
        Provider: params.channel,
        Surface: params.channel,
        MessageSid: params.messageId,
        Timestamp: params.timestamp,
        media: params.media,
        OriginatingChannel: params.channel,
        OriginatingTo: params.reply.originatingTo,
        ...params.extra,
      }),
  );
  const recordInboundSessionMock = vi.fn(async () => undefined);
  const readRemoteMediaBufferMock = vi.fn(async () => ({
    buffer: Buffer.from("image-bytes"),
    contentType: "image/jpeg",
  }));
  // Preserve the timeout-inspecting mockImplementation signature.
  const saveRemoteMediaMock = vi.fn<Channel["media"]["saveRemoteMedia"]>(async (_params) => ({
    id: "zalo-photo.jpg",
    path: "/tmp/zalo-photo.jpg",
    size: Buffer.byteLength("image-bytes"),
    contentType: "image/jpeg",
  }));
  const saveMediaBufferMock = vi.fn(async () => ({
    path: "/tmp/zalo-photo.jpg",
    contentType: "image/jpeg",
  }));
  const dispatchReplyWithBufferedBlockDispatcherMock = vi.fn(async () => undefined);
  const core = createPluginRuntimeMock({
    channel: {
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIRCODE", created: true })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/zalo-sessions.json"),
        readSessionUpdatedAtAsync: vi.fn(async () => undefined),
        recordInboundSession: recordInboundSessionMock,
      },
      text: {
        resolveMarkdownTableMode: vi.fn(() => "code" as const),
      },
      media: createPluginRuntimeMediaMock({
        readRemoteMediaBuffer:
          readRemoteMediaBufferMock as unknown as Channel["media"]["readRemoteMediaBuffer"],
        saveRemoteMedia: saveRemoteMediaMock,
        saveMediaBuffer: saveMediaBufferMock as unknown as Channel["media"]["saveMediaBuffer"],
      }),
      reply: {
        finalizeInboundContext:
          finalizeInboundContextMock as unknown as Channel["reply"]["finalizeInboundContext"],
        dispatchReplyWithBufferedBlockDispatcher:
          dispatchReplyWithBufferedBlockDispatcherMock as unknown as Channel["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
      },
      inbound: {
        buildContext:
          buildChannelInboundEventContextMock as unknown as Channel["inbound"]["buildContext"],
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        isControlCommandMessage: vi.fn(() => false),
      },
    },
  });
  return {
    core,
    finalizeInboundContextMock,
    recordInboundSessionMock,
    readRemoteMediaBufferMock,
    saveRemoteMediaMock,
    saveMediaBufferMock,
  };
}

export function expectImageLifecycleDelivery(params: {
  readRemoteMediaBufferMock: ReturnType<typeof vi.fn>;
  saveRemoteMediaMock: ReturnType<typeof vi.fn>;
  saveMediaBufferMock: ReturnType<typeof vi.fn>;
  finalizeInboundContextMock: ReturnType<typeof vi.fn>;
  recordInboundSessionMock: ReturnType<typeof vi.fn>;
}) {
  const context = expect.objectContaining({
    SenderName: "Test User",
    media: [expect.objectContaining({ path: "/tmp/zalo-photo.jpg", contentType: "image/jpeg" })],
  });
  expect(params.saveRemoteMediaMock).toHaveBeenCalledWith({
    url: "https://example.com/test-image.jpg",
    maxBytes: 5 * 1024 * 1024,
    responseHeaderTimeoutMs: 120_000,
    readIdleTimeoutMs: 30_000,
  });
  expect(params.saveMediaBufferMock).not.toHaveBeenCalled();
  expect(params.finalizeInboundContextMock).toHaveBeenCalledWith(context);
  expect(params.recordInboundSessionMock).toHaveBeenCalledWith(
    expect.objectContaining({ ctx: context }),
  );
}

export async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

async function postWebhookUpdate(params: {
  baseUrl: string;
  path: string;
  secret: string;
  payload: Record<string, unknown>;
}) {
  const url = new URL(params.path, params.baseUrl);
  const body = JSON.stringify(params.payload);
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-bot-api-secret-token": params.secret,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export async function postWebhookReplay(
  params: Parameters<typeof postWebhookUpdate>[0] & { beforeReplay?: () => Promise<void> },
) {
  const first = await postWebhookUpdate(params);
  await params.beforeReplay?.();
  const replay = await postWebhookUpdate(params);
  return { first, replay };
}
