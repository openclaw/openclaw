import { request as httpRequest } from "node:http";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, vi } from "vitest";
import type { ResolvedZaloAccount } from "../types.js";
import { getUpdatesMock, loadCachedLifecycleMonitorModule } from "./monitor-mocks-test-support.js";

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
  const core = createPluginRuntimeMock({
    channel: {
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIRCODE", created: true })),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/zalo-sessions.json"),
        recordInboundSession: vi.fn(async () => undefined),
      },
      media: {
        readRemoteMediaBuffer: vi.fn(async () => ({
          buffer: Buffer.from("image-bytes"),
          contentType: "image/jpeg",
        })),
        saveRemoteMedia: vi.fn<Channel["media"]["saveRemoteMedia"]>(async (_params) => ({
          id: "zalo-photo.jpg",
          path: "/tmp/zalo-photo.jpg",
          size: Buffer.byteLength("image-bytes"),
          contentType: "image/jpeg",
        })),
        saveMediaBuffer: vi.fn(async () => ({
          path: "/tmp/zalo-photo.jpg",
          contentType: "image/jpeg",
        })) as Channel["media"]["saveMediaBuffer"],
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(
          async () => undefined,
        ) as unknown as Channel["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        isControlCommandMessage: vi.fn(() => false),
      },
    },
  });
  const buildContext = vi.mocked(core.channel.inbound.buildContext).getMockImplementation()!;
  const finalizeInboundContextMock = vi.mocked(core.channel.reply.finalizeInboundContext);
  vi.mocked(core.channel.inbound.buildContext).mockImplementation(((
    params: Parameters<Channel["inbound"]["buildContext"]>[0],
  ) => finalizeInboundContextMock(buildContext(params))) as Channel["inbound"]["buildContext"]);
  return {
    core,
    finalizeInboundContextMock,
    recordInboundSessionMock: vi.mocked(core.channel.session.recordInboundSession),
    readRemoteMediaBufferMock: vi.mocked(core.channel.media.readRemoteMediaBuffer),
    saveRemoteMediaMock: vi.mocked(core.channel.media.saveRemoteMedia),
    saveMediaBufferMock: vi.mocked(core.channel.media.saveMediaBuffer),
  };
}

export function expectImageLifecycleDelivery(params: ReturnType<typeof createImageLifecycleCore>) {
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
  return await new Promise<number>((resolve, reject) => {
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
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export async function replayLifecycleWebhook(
  monitor: {
    route: { handler: Parameters<typeof withServer>[0] };
    waitForIdle: () => Promise<void>;
  },
  payload: Record<string, unknown>,
  waitBeforeReplay = false,
  settle = monitor.waitForIdle,
) {
  await withServer(
    (req, res) => {
      monitor.route.handler(req, res);
    },
    async (baseUrl) => {
      const params = {
        baseUrl,
        path: "/hooks/zalo",
        secret: "supersecret",
        payload,
      };
      const first = await postWebhookUpdate(params);
      if (waitBeforeReplay) {
        await monitor.waitForIdle();
      }
      expect([first, await postWebhookUpdate(params)]).toEqual([200, 200]);
      await settle();
    },
  );
}

export async function withStoppedMonitor<T extends { stop: () => Promise<void> }>(
  monitor: T,
  run: (monitor: T) => Promise<void>,
) {
  try {
    await run(monitor);
  } finally {
    await monitor.stop();
  }
}

export function queueLifecycleUpdate(
  result: ReturnType<typeof createImageUpdate> | ReturnType<typeof createTextUpdate>,
) {
  const processed = Promise.withResolvers<void>();
  getUpdatesMock.mockResolvedValueOnce({ ok: true, result }).mockImplementation(() => {
    processed.resolve();
    return new Promise(() => {});
  });
  return processed.promise;
}

export async function startPollingLifecycleMonitor(
  cacheKey: string,
  setup: Partial<LifecycleMonitorSetupParams> = {},
  options: Pick<
    Parameters<
      Awaited<ReturnType<typeof loadCachedLifecycleMonitorModule>>["monitorZaloProvider"]
    >[0],
    "token" | "fetcher" | "statusSink"
  > = { token: "zalo-token" },
) {
  const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule(cacheKey);
  const abort = new AbortController();
  const runtime = createRuntimeEnv();
  const started = Date.now();
  const run = monitorZaloProvider({
    ...createLifecycleMonitorSetup({ accountId: "default", dmPolicy: "open", ...setup }),
    runtime,
    abortSignal: abort.signal,
    ...options,
  });
  return {
    abort,
    run,
    runtime,
    started,
    stop: async () => {
      abort.abort();
      await run;
    },
  };
}
