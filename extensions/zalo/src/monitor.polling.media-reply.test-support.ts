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
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const state = {
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("zalo", options),
};
const monitors: Array<{ stop: () => Promise<void> }> = [];
const registryOwners: ReturnType<typeof createPluginRegistryOwner>[] = [];
async function stopMonitors() {
  await Promise.all(monitors.splice(0).map((monitor) => monitor.stop()));
}
function ownedRegistry() {
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  registryOwners.push(createPluginRegistryOwner(registry));
  return registry;
}
const mediaRoutes = (registry: ReturnType<typeof createEmptyPluginRegistry>) =>
  registry.httpRoutes.filter((route) => route.source === "zalo-hosted-media");
function singleMediaRoute(registry: ReturnType<typeof createEmptyPluginRegistry>) {
  const routes = mediaRoutes(registry);
  expect(routes).toHaveLength(1);
  return expectDefined(routes[0], "Zalo hosted-media route");
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
  const monitor = {
    runtime,
    stop: async () => {
      abort.abort();
      await run;
    },
  };
  monitors.push(monitor);
  return monitor;
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
  const buffer = Buffer.from(body);
  const metaStore = createPluginStateKeyedStoreForTests("zalo", {
    namespace: "hosted-outbound-media",
    maxEntries: 80,
  });
  const chunkStore = createPluginStateKeyedStoreForTests("zalo", {
    namespace: "hosted-outbound-media-chunks",
    maxEntries: 16_384,
  });
  await chunkStore.register(`media:${id}:chunk:0000`, {
    id,
    index: 0,
    dataBase64: buffer.toString("base64"),
  });
  await metaStore.register(`media:${id}:meta`, {
    id,
    token,
    contentType,
    routePath: "/hooks/zalo/media/",
    expiresAt: Date.now() + 60_000,
    chunkCount: 1,
    byteLength: buffer.byteLength,
  });
  const res = createMockServerResponse();
  const end = vi.spyOn(res, "end");
  await route.handler(
    { method: "GET", url: `/hooks/zalo/media/${id}?token=${token}` } as never,
    res,
  );
  expect(res.statusCode).toBe(200);
  expect(res.getHeader("Content-Type")).toBe(contentType);
  expect(end).toHaveBeenCalledWith(buffer);
  return res;
}

type FailureRow = [
  name: string,
  kind: "block" | "tool" | "final",
  payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
  flags?: {
    partial?: "text" | "media";
    missingMessageId?: boolean;
    hosted?: boolean;
    blocked?: boolean;
  },
];
const photo = (name: string) => ({ text: "caption", mediaUrl: `https://example.com/${name}.png` });
const photos = (count: number) => ({
  text: "caption",
  mediaUrls: ["first", "second", "third"].slice(0, count).map((name) => photo(name).mediaUrl),
});
const hostedMediaOptions = (mediaUrl: string) => ({
  mediaUrl,
  webhookUrl: "https://example.com/hooks/zalo",
  webhookPath: "/hooks/zalo",
  maxBytes: 5 * 1024 * 1024,
  proxyUrl: undefined,
});
type DispatchOptions = Parameters<typeof createReplyDispatcher>[0];

describe("Zalo polling media replies", () => {
  const dispatchReplyWithBufferedBlockDispatcherMock = vi.fn();

  beforeAll(async () => {
    await loadCachedLifecycleMonitorModule("zalo-polling-media-reply");
  });

  beforeEach(async () => {
    await resetLifecycleTestState();
    resetPluginStateStoreForTests();
    setZaloRuntime({ state } as unknown as PluginRuntime);
    prepareHostedZaloMediaUrlMock.mockReset();
    prepareHostedZaloMediaUrlMock.mockResolvedValue(
      "https://example.com/hooks/zalo/media/abc123abc123abc123abc123?token=secret",
    );
    dispatchReplyWithBufferedBlockDispatcherMock.mockReset();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(deliverPhoto("caption text"));
    setLifecycleRuntimeCore(
      {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher:
            dispatchReplyWithBufferedBlockDispatcherMock as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
        },
      },
      state as PluginRuntime["state"],
    );
  });

  afterAll(resetLifecycleTestState);

  afterEach(async () => {
    try {
      await stopMonitors();
    } finally {
      await Promise.all(registryOwners.splice(0).map((owner) => owner.close()));
      vi.restoreAllMocks();
    }
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
      vi.spyOn(ssrf, "resolvePinnedHostnameWithPolicy").mockResolvedValue(pinnedHost);
      const fetcher = vi.fn<ZaloFetch>(async () =>
        Response.json({ ok: true, result: { message_id: "zalo-photo-bounded" } }),
      );
      const registry = createEmptyPluginRegistry();
      setActivePluginRegistry(registry);
      const processed = queueTextUpdate("polling-media-1", "send media");
      const monitor = await startPollingMediaMonitor({
        webhookUrl: hosted ? "https://example.com/hooks/zalo" : "",
        fetcher,
      });

      await processed;
      expect(sendPhotoMock).toHaveBeenCalledTimes(1);

      expect(registry.httpRoutes).toHaveLength(hosted ? 1 : 0);
      if (hosted) {
        expect(prepareHostedZaloMediaUrlMock).toHaveBeenCalledWith(
          hostedMediaOptions("https://example.com/reply-image.png"),
        );
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
      await monitor.stop();
      expect(registry.httpRoutes).toHaveLength(0);
    },
  );

  it.each<FailureRow>([
    ["block text", "block", { text: "block reply" }],
    ["first tool attachment", "tool", photo("first")],
    ["final attachment", "final", photo("final")],
    [
      "blocked hosted attachment",
      "tool",
      { text: "caption", mediaUrl: "file:///etc/passwd" },
      { hosted: true, blocked: true },
    ],
    ["later block attachment", "block", photos(3), { partial: "media" }],
    [
      "later tool text chunk",
      "tool",
      { text: "first chunk second chunk third chunk" },
      { partial: "text" },
    ],
    [
      "later attachment without a provider id",
      "tool",
      photos(2),
      { partial: "media", missingMessageId: true },
    ],
    [
      "later text chunk without a provider id",
      "block",
      { text: "first chunk second chunk" },
      { partial: "text", missingMessageId: true },
    ],
  ])(
    "reports %s failures through the real reply dispatcher",
    async (name, kind, payload, flags = {}) => {
      setActivePluginRegistry(createEmptyPluginRegistry());
      const failure = new Error(`${name} rejected`);
      const acceptedMessageId = `zalo-accepted-${flags.partial ?? "none"}`;
      const acceptedResponse = {
        ok: true,
        ...(flags.missingMessageId ? {} : { result: { message_id: acceptedMessageId } }),
      };
      const isMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
      if (flags.blocked) {
        prepareHostedZaloMediaUrlMock.mockRejectedValueOnce(failure);
      } else if (flags.partial === "media") {
        sendPhotoMock.mockResolvedValueOnce(acceptedResponse).mockRejectedValueOnce(failure);
      } else if (flags.partial === "text") {
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
      let failedAfterSendCounts: [number, number, number] | undefined;
      dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
        async ({ dispatcherOptions }: { dispatcherOptions: DispatchOptions }) => {
          const dispatcher = createReplyDispatcher({
            ...dispatcherOptions,
            onError: async (error, info) => {
              deliveryErrors.push(error);
              await dispatcherOptions.onError?.(error, info);
            },
          });
          const send = {
            tool: dispatcher.sendToolResult,
            final: dispatcher.sendFinalReply,
            block: dispatcher.sendBlockReply,
          }[kind];
          send(payload);
          dispatcher.markComplete();
          const receipt = await dispatcher.waitForIdle();
          if (receipt) {
            failedAfterSendCounts = [
              receipt.counts.tool.failedAfterSend,
              receipt.counts.block.failedAfterSend,
              receipt.counts.final.failedAfterSend,
            ];
          }
          return {
            queuedFinal: kind === "final",
            counts: dispatcher.getQueuedCounts(),
          };
        },
      );

      const processed = queueTextUpdate(`polling-delivery-${name.replaceAll(" ", "-")}`);
      const statusSink =
        vi.fn<(patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void>();
      const { runtime } = await startPollingMediaMonitor({
        accountId: "acct-zalo-delivery",
        webhookUrl: flags.hosted ? "https://example.com/hooks/zalo" : "",
        statusSink,
      });

      await processed;
      expect(failedAfterSendCounts).toEqual([
        kind === "tool" ? 1 : 0,
        kind === "block" ? 1 : 0,
        kind === "final" ? 1 : 0,
      ]);
      expect(deliveryErrors).toHaveLength(1);
      if (flags.partial) {
        const acceptedMessageIds = flags.missingMessageId ? [] : [acceptedMessageId];
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
        `[acct-zalo-delivery] Zalo ${kind} reply failed: Error: ${name} rejected`,
      );
      const outboundUpdates = statusSink.mock.calls.filter(
        ([patch]) => patch.lastOutboundAt !== undefined,
      );
      expect(outboundUpdates).toHaveLength(flags.partial ? 1 : 0);
      expect(sendMessageMock).toHaveBeenCalledTimes(isMedia ? 0 : flags.partial ? 2 : 1);
      expect(sendPhotoMock).toHaveBeenCalledTimes(
        !isMedia || flags.blocked ? 0 : flags.partial ? 2 : 1,
      );
      if (flags.hosted) {
        expect(prepareHostedZaloMediaUrlMock).toHaveBeenCalledWith(
          hostedMediaOptions("file:///etc/passwd"),
        );
      }
    },
  );

  it.each(["first", "second"] as const)(
    "shares one hosted media route when the %s account stops first",
    async (stoppedAccount) => {
      const registry = createEmptyPluginRegistry();
      setActivePluginRegistry(registry);
      getUpdatesMock.mockImplementation(() => new Promise(() => {}));

      const first = await startPollingMediaMonitor({
        accountId: "acct-zalo-polling-media-one",
        token: "zalo-token-one",
      });

      await settleAsyncWork();
      const firstHostedMediaRoute = singleMediaRoute(registry);
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

      await settleAsyncWork();
      const hostedMediaRoute = singleMediaRoute(registry);
      expect(hostedMediaRoute).toBe(firstHostedMediaRoute);

      const firstHeaders = await serveFixture(
        hostedMediaRoute,
        "abc123abc123abc123abc123",
        "route-token-one",
        "first-image-bytes",
        "image/png",
      );
      expect(firstHeaders.getHeader("Cache-Control")).toBe("no-store");

      await (stoppedAccount === "first" ? first : second).stop();
      expect(singleMediaRoute(registry)).toEqual(hostedMediaRoute);

      await serveFixture(
        hostedMediaRoute,
        "def456def456def456def456",
        "route-token-two",
        "second-image-bytes",
        "image/jpeg",
      );
      await stopMonitors();
      expect(mediaRoutes(registry)).toHaveLength(0);
    },
  );

  it("cleans each active registry when its own route holder stops", async () => {
    const firstRegistry = ownedRegistry();
    getUpdatesMock.mockImplementation(() => new Promise(() => {}));

    const first = await startPollingMediaMonitor();
    await settleAsyncWork();
    expect(firstRegistry.httpRoutes).toHaveLength(1);

    const secondRegistry = ownedRegistry();
    await startPollingMediaMonitor();

    await settleAsyncWork();
    expect(secondRegistry.httpRoutes).toHaveLength(1);
    await first.stop();
    expect(firstRegistry.httpRoutes).toHaveLength(0);
    expect(secondRegistry.httpRoutes).toHaveLength(1);
    await stopMonitors();
    await Promise.all(registryOwners.splice(0).map((owner) => owner.close()));
    expect(firstRegistry.httpRoutes).toHaveLength(0);
    expect(secondRegistry.httpRoutes).toHaveLength(0);
  });
});
