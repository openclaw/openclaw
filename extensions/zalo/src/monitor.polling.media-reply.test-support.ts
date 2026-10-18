// Zalo test support covers monitor.polling.media reply plugin behavior.
import type { ServerResponse } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createEmptyPluginRegistry,
  createPluginRegistryOwner,
  createRuntimeEnv,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZaloFetch } from "./api.js";
import { setZaloRuntime } from "./runtime.js";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  settleAsyncWork,
} from "./test-support/lifecycle-test-support.js";
import {
  getUpdatesMock,
  getZaloRuntimeMock,
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
  sendMessageMock,
  sendPhotoMock,
  setLifecycleRuntimeCore,
} from "./test-support/monitor-mocks-test-support.js";

const prepareHostedZaloMediaUrlMock = vi.fn();

vi.mock("./outbound-media.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound-media.js")>("./outbound-media.js");
  return {
    ...actual,
    prepareHostedZaloMediaUrl: (...args: unknown[]) => prepareHostedZaloMediaUrlMock(...args),
  };
});

function installZaloRuntimeForTest(): void {
  setZaloRuntime({
    state: {
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("zalo", options),
    },
  } as unknown as PluginRuntime);
}

async function writeHostedZaloMediaFixture(params: {
  id: string;
  routePath: string;
  token: string;
  buffer: Buffer;
  contentType?: string;
}): Promise<void> {
  const metaStore = createPluginStateKeyedStoreForTests("zalo", {
    namespace: "hosted-outbound-media",
    maxEntries: 80,
  });
  const chunkStore = createPluginStateKeyedStoreForTests("zalo", {
    namespace: "hosted-outbound-media-chunks",
    maxEntries: 16_384,
  });
  await chunkStore.register(`media:${params.id}:chunk:0000`, {
    id: params.id,
    index: 0,
    dataBase64: params.buffer.toString("base64"),
  });
  await metaStore.register(`media:${params.id}:meta`, {
    id: params.id,
    routePath: params.routePath,
    token: params.token,
    ...(params.contentType ? { contentType: params.contentType } : {}),
    expiresAt: Date.now() + 60_000,
    chunkCount: 1,
    byteLength: params.buffer.byteLength,
  });
}

function createHostedMediaResponse() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end: vi.fn((body?: unknown) => {
      res.headersSent = true;
      return body;
    }),
  };
  return { headers, res: res as unknown as ServerResponse & { end: ReturnType<typeof vi.fn> } };
}

async function startPollingMediaMonitor({
  accountId = "acct-zalo-polling-media",
  webhookUrl = "https://example.com/hooks/zalo",
  token = "zalo-token",
  ...options
}: {
  accountId?: string;
  webhookUrl?: string;
  token?: string;
  fetcher?: ZaloFetch;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
} = {}) {
  const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule(
    "zalo-polling-media-reply",
  );
  const abort = new AbortController();
  const runtime = createRuntimeEnv();
  const setup = createLifecycleMonitorSetup({ accountId, dmPolicy: "open", webhookUrl });
  const run = monitorZaloProvider({
    ...setup,
    token,
    runtime,
    abortSignal: abort.signal,
    ...options,
  });
  return { abort, runtime, run };
}

function queueTextUpdate(messageId: string, text?: string) {
  const processed = Promise.withResolvers<void>();
  getUpdatesMock
    .mockResolvedValueOnce({
      ok: true,
      result: createTextUpdate({
        messageId,
        userId: "user-1",
        userName: "User One",
        chatId: "dm-chat-1",
        text,
      }),
    })
    .mockImplementation(() => {
      processed.resolve();
      return new Promise(() => {});
    });
  return processed.promise;
}

type MediaDelivery = {
  dispatcherOptions: { deliver: (payload: { text: string; mediaUrl: string }) => Promise<void> };
};

const deliverPhoto =
  (text: string) =>
  async ({ dispatcherOptions }: MediaDelivery) => {
    await dispatcherOptions.deliver({ text, mediaUrl: "https://example.com/reply-image.png" });
  };

async function serveFixture(
  route: ReturnType<typeof createEmptyPluginRegistry>["httpRoutes"][number],
  id: string,
  token: string,
  body: string,
  contentType: string,
) {
  await writeHostedZaloMediaFixture({
    id,
    token,
    contentType,
    routePath: "/hooks/zalo/media/",
    buffer: Buffer.from(body),
  });
  const response = createHostedMediaResponse();
  await route.handler(
    { method: "GET", url: `/hooks/zalo/media/${id}?token=${token}` } as never,
    response.res as never,
  );
  expect(response.res.statusCode).toBe(200);
  expect(response.headers.get("Content-Type")).toBe(contentType);
  expect(response.res.end).toHaveBeenCalledWith(Buffer.from(body));
  return response;
}

type ZaloReplyFailureCase = {
  name: string;
  kind: "block" | "tool" | "final";
  payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] };
  partial?: "text" | "media";
  missingMessageId?: boolean;
  hosted?: boolean;
  blocked?: boolean;
};

describe("Zalo polling media replies", () => {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordInboundSessionMock = vi.fn(async () => undefined);
  const dispatchReplyWithBufferedBlockDispatcherMock = vi.fn();

  beforeAll(async () => {
    await loadCachedLifecycleMonitorModule("zalo-polling-media-reply");
  });

  beforeEach(async () => {
    await resetLifecycleTestState();
    resetPluginStateStoreForTests();
    installZaloRuntimeForTest();
    prepareHostedZaloMediaUrlMock.mockReset();
    prepareHostedZaloMediaUrlMock.mockResolvedValue(
      "https://example.com/hooks/zalo/media/abc123abc123abc123abc123?token=secret",
    );
    dispatchReplyWithBufferedBlockDispatcherMock.mockReset();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(deliverPhoto("caption text"));
    setLifecycleRuntimeCore(
      {
        reply: {
          finalizeInboundContext:
            finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
          dispatchReplyWithBufferedBlockDispatcher:
            dispatchReplyWithBufferedBlockDispatcherMock as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
        },
        session: {
          recordInboundSession:
            recordInboundSessionMock as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
        },
      },
      {
        openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
          createPluginStateKeyedStoreForTests<T>("zalo", options),
      } as PluginRuntime["state"],
    );
  });

  afterAll(async () => {
    await resetLifecycleTestState();
  });

  it.each([true, false])(
    "sends bounded photo captions while polling (hosted: %s)",
    async (hosted) => {
      const caption = `${"a".repeat(1999)}🐱tail`;
      dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(deliverPhoto(caption));
      const api = await vi.importActual<typeof import("./api.js")>("./api.js");
      vi.mocked((await import("./api.js")).sendPhoto).mockImplementationOnce(api.sendPhoto);
      const ssrf = await import("openclaw/plugin-sdk/ssrf-runtime");
      const pinnedHost = await ssrf.resolvePinnedHostnameWithPolicy("example.com", {
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      });
      const resolvePhotoHost = vi
        .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
        .mockResolvedValue(pinnedHost);
      const fetcher = vi.fn<ZaloFetch>(async () =>
        Response.json({ ok: true, result: { message_id: "zalo-photo-bounded" } }),
      );
      const registry = createEmptyPluginRegistry();
      setActivePluginRegistry(registry);
      const processed = queueTextUpdate("polling-media-1", "send media");
      const { abort, run } = await startPollingMediaMonitor({
        webhookUrl: hosted ? "https://example.com/hooks/zalo" : "",
        fetcher,
      });

      try {
        await processed;
        expect(sendPhotoMock).toHaveBeenCalledTimes(1);

        expect(registry.httpRoutes).toHaveLength(hosted ? 1 : 0);
        if (hosted) {
          expect(prepareHostedZaloMediaUrlMock).toHaveBeenCalledWith({
            mediaUrl: "https://example.com/reply-image.png",
            webhookUrl: "https://example.com/hooks/zalo",
            webhookPath: "/hooks/zalo",
            maxBytes: 5 * 1024 * 1024,
            proxyUrl: undefined,
          });
        } else {
          expect(prepareHostedZaloMediaUrlMock).not.toHaveBeenCalled();
        }
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
          JSON.stringify({
            chat_id: "dm-chat-1",
            photo: hosted
              ? "https://example.com/hooks/zalo/media/abc123abc123abc123abc123?token=secret"
              : "https://example.com/reply-image.png",
            caption: "a".repeat(1999),
          }),
        );
      } finally {
        abort.abort();
        await run;
        resolvePhotoHost.mockRestore();
      }

      expect(registry.httpRoutes).toHaveLength(0);
    },
  );

  it.each<ZaloReplyFailureCase>([
    { name: "block text", kind: "block", payload: { text: "block reply" } },
    {
      name: "first tool attachment",
      kind: "tool",
      payload: { text: "caption", mediaUrl: "https://example.com/first.png" },
    },
    {
      name: "final attachment",
      kind: "final",
      payload: { text: "caption", mediaUrl: "https://example.com/final.png" },
    },
    {
      name: "blocked hosted attachment",
      kind: "tool",
      payload: { text: "caption", mediaUrl: "file:///etc/passwd" },
      hosted: true,
      blocked: true,
    },
    {
      name: "later block attachment",
      kind: "block",
      payload: {
        text: "caption",
        mediaUrls: [
          "https://example.com/first.png",
          "https://example.com/second.png",
          "https://example.com/third.png",
        ],
      },
      partial: "media",
    },
    {
      name: "later tool text chunk",
      kind: "tool",
      payload: { text: "first chunk second chunk third chunk" },
      partial: "text",
    },
    {
      name: "later attachment without a provider id",
      kind: "tool",
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/first.png", "https://example.com/second.png"],
      },
      partial: "media",
      missingMessageId: true,
    },
    {
      name: "later text chunk without a provider id",
      kind: "block",
      payload: { text: "first chunk second chunk" },
      partial: "text",
      missingMessageId: true,
    },
  ])("reports $name failures through the real reply dispatcher", async (testCase) => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const failure = new Error(`${testCase.name} rejected`);
    const acceptedMessageId = `zalo-accepted-${testCase.partial ?? "none"}`;
    const acceptedResponse = {
      ok: true,
      ...(testCase.missingMessageId ? {} : { result: { message_id: acceptedMessageId } }),
    };
    const isMedia = Boolean(testCase.payload.mediaUrl || testCase.payload.mediaUrls?.length);
    if (testCase.blocked) {
      prepareHostedZaloMediaUrlMock.mockRejectedValueOnce(failure);
    } else if (testCase.partial === "media") {
      sendPhotoMock.mockResolvedValueOnce(acceptedResponse).mockRejectedValueOnce(failure);
    } else if (testCase.partial === "text") {
      const core = getZaloRuntimeMock() as PluginRuntime;
      vi.mocked(core.channel.text.chunkMarkdownTextWithMode).mockReturnValueOnce([
        "first chunk",
        "second chunk",
        "third chunk",
      ]);
      sendMessageMock.mockResolvedValueOnce(acceptedResponse).mockRejectedValueOnce(failure);
    } else if (isMedia) {
      sendPhotoMock.mockRejectedValueOnce(failure);
    } else {
      sendMessageMock.mockRejectedValueOnce(failure);
    }

    const deliveryErrors: unknown[] = [];
    let failedAfterSendCounts: Record<"tool" | "block" | "final", number> | undefined;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async ({
        dispatcherOptions,
      }: {
        dispatcherOptions: Parameters<typeof createReplyDispatcher>[0];
      }) => {
        const dispatcher = createReplyDispatcher({
          ...dispatcherOptions,
          onError: async (error, info) => {
            deliveryErrors.push(error);
            await dispatcherOptions.onError?.(error, info);
          },
        });
        if (testCase.kind === "tool") {
          dispatcher.sendToolResult(testCase.payload);
        } else if (testCase.kind === "final") {
          dispatcher.sendFinalReply(testCase.payload);
        } else {
          dispatcher.sendBlockReply(testCase.payload);
        }
        dispatcher.markComplete();
        const receipt = await dispatcher.waitForIdle();
        if (receipt) {
          failedAfterSendCounts = {
            tool: receipt.counts.tool.failedAfterSend,
            block: receipt.counts.block.failedAfterSend,
            final: receipt.counts.final.failedAfterSend,
          };
        }
        return {
          queuedFinal: testCase.kind === "final",
          counts: dispatcher.getQueuedCounts(),
        };
      },
    );

    const processed = queueTextUpdate(`polling-delivery-${testCase.name.replaceAll(" ", "-")}`);
    const statusSink =
      vi.fn<(patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void>();
    const { abort, runtime, run } = await startPollingMediaMonitor({
      accountId: "acct-zalo-delivery",
      webhookUrl: testCase.hosted ? "https://example.com/hooks/zalo" : "",
      statusSink,
    });

    try {
      await processed;
      expect(failedAfterSendCounts).toEqual({
        block: testCase.kind === "block" ? 1 : 0,
        tool: testCase.kind === "tool" ? 1 : 0,
        final: testCase.kind === "final" ? 1 : 0,
      });
      expect(deliveryErrors).toHaveLength(1);
      if (testCase.partial) {
        const acceptedMessageIds = testCase.missingMessageId ? [] : [acceptedMessageId];
        expect(deliveryErrors[0]).toMatchObject({
          cause: failure,
          sentBeforeError: true,
          visibleReplySent: true,
          deliveryResult: {
            messageIds: acceptedMessageIds,
            receipt: { platformMessageIds: acceptedMessageIds },
            visibleReplySent: true,
          },
        });
      } else {
        expect(deliveryErrors[0]).toBe(failure);
      }
      expect(runtime.error).toHaveBeenCalledTimes(1);
      expect(runtime.error).toHaveBeenCalledWith(
        `[acct-zalo-delivery] Zalo ${testCase.kind} reply failed: Error: ${testCase.name} rejected`,
      );
      const outboundUpdates = statusSink.mock.calls.filter(
        ([patch]) => patch.lastOutboundAt !== undefined,
      );
      expect(outboundUpdates).toHaveLength(testCase.partial ? 1 : 0);
      expect(sendMessageMock).toHaveBeenCalledTimes(isMedia ? 0 : testCase.partial ? 2 : 1);
      expect(sendPhotoMock).toHaveBeenCalledTimes(
        !isMedia || testCase.blocked ? 0 : testCase.partial ? 2 : 1,
      );
      if (testCase.hosted) {
        expect(prepareHostedZaloMediaUrlMock).toHaveBeenCalledWith({
          mediaUrl: "file:///etc/passwd",
          webhookUrl: "https://example.com/hooks/zalo",
          webhookPath: "/hooks/zalo",
          maxBytes: 5 * 1024 * 1024,
          proxyUrl: undefined,
        });
      }
    } finally {
      abort.abort();
      await run;
    }
  });

  it.each(["first", "second"] as const)(
    "shares one hosted media route when the %s account stops first",
    async (stoppedAccount) => {
      const registry = createEmptyPluginRegistry();
      setActivePluginRegistry(registry);
      getUpdatesMock.mockImplementation(() => new Promise(() => {}));

      const { abort: firstAbort, run: firstRun } = await startPollingMediaMonitor({
        accountId: "acct-zalo-polling-media-one",
        token: "zalo-token-one",
      });

      let secondAbort: AbortController | undefined;
      let secondRun: Promise<void> | undefined;

      try {
        await settleAsyncWork();
        const firstHostedMediaRoutes = registry.httpRoutes.filter(
          (route) => route.source === "zalo-hosted-media",
        );
        expect(firstHostedMediaRoutes).toHaveLength(1);
        const firstHostedMediaRoute = expectDefined(
          firstHostedMediaRoutes[0],
          "Zalo hosted-media route",
        );
        expect(firstHostedMediaRoute).toMatchObject({
          path: "/hooks/zalo/media",
          pluginId: "zalo",
          source: "zalo-hosted-media",
          handler: expect.any(Function),
        });

        const second = await startPollingMediaMonitor({
          accountId: "acct-zalo-polling-media-two",
          webhookUrl: "https://example.com/Hooks//Zalo/",
          token: "zalo-token-two",
        });
        secondRun = second.run;
        secondAbort = second.abort;

        await settleAsyncWork();
        const hostedMediaRoutes = registry.httpRoutes.filter(
          (route) => route.source === "zalo-hosted-media",
        );
        expect(hostedMediaRoutes).toHaveLength(1);
        const hostedMediaRoute = expectDefined(
          hostedMediaRoutes[0],
          "active Zalo hosted-media route",
        );
        expect(hostedMediaRoute).toBe(firstHostedMediaRoute);

        const firstFetch = await serveFixture(
          hostedMediaRoute,
          "abc123abc123abc123abc123",
          "route-token-one",
          "first-image-bytes",
          "image/png",
        );
        expect(firstFetch.headers.get("Cache-Control")).toBe("no-store");

        const stoppedRun = stoppedAccount === "first" ? firstRun : secondRun;
        (stoppedAccount === "first" ? firstAbort : secondAbort).abort();
        await stoppedRun;
        expect(registry.httpRoutes.find((route) => route.source === "zalo-hosted-media")).toEqual(
          hostedMediaRoute,
        );
        expect(
          registry.httpRoutes.filter((route) => route.source === "zalo-hosted-media"),
        ).toHaveLength(1);

        await serveFixture(
          hostedMediaRoute,
          "def456def456def456def456",
          "route-token-two",
          "second-image-bytes",
          "image/jpeg",
        );
      } finally {
        firstAbort.abort();
        secondAbort?.abort();
        await firstRun;
        await secondRun;
      }

      expect(
        registry.httpRoutes.filter((route) => route.source === "zalo-hosted-media"),
      ).toHaveLength(0);
    },
  );

  it("cleans each active registry when its own route holder stops", async () => {
    const firstRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(firstRegistry);
    const firstOwner = createPluginRegistryOwner(firstRegistry);
    getUpdatesMock.mockImplementation(() => new Promise(() => {}));

    const { abort: firstAbort, run: firstRun } = await startPollingMediaMonitor();

    const secondRegistry = createEmptyPluginRegistry();
    let secondAbort: AbortController | undefined;
    let secondRun: Promise<void> | undefined;
    let secondOwner: ReturnType<typeof createPluginRegistryOwner> | undefined;

    try {
      await settleAsyncWork();
      expect(firstRegistry.httpRoutes).toHaveLength(1);

      setActivePluginRegistry(secondRegistry);
      secondOwner = createPluginRegistryOwner(secondRegistry);
      const second = await startPollingMediaMonitor();
      secondRun = second.run;
      secondAbort = second.abort;

      await settleAsyncWork();
      expect(secondRegistry.httpRoutes).toHaveLength(1);
      firstAbort.abort();
      await firstRun;
      expect(firstRegistry.httpRoutes).toHaveLength(0);
      expect(secondRegistry.httpRoutes).toHaveLength(1);
    } finally {
      firstAbort.abort();
      secondAbort?.abort();
      try {
        await Promise.all([firstRun, secondRun]);
      } finally {
        await Promise.all([firstOwner.close(), secondOwner?.close()]);
      }
    }

    expect(firstRegistry.httpRoutes).toHaveLength(0);
    expect(secondRegistry.httpRoutes).toHaveLength(0);
  });
});
