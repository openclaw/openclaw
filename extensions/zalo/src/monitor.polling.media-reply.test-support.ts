import { expectDefined } from "@openclaw/normalization-core";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZaloFetch } from "./api.js";
import { setZaloRuntime } from "./runtime.js";
import {
  createTextUpdate,
  settleAsyncWork,
  queueLifecycleUpdate,
  startPollingLifecycleMonitor,
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
async function stopMonitors() {
  await Promise.all(monitors.splice(0).map((monitor) => monitor.stop()));
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
  const monitor = await startPollingLifecycleMonitor(
    "zalo-polling-media-reply",
    { accountId, webhookUrl },
    { token, ...options },
  );
  monitors.push(monitor);
  return monitor;
}

const queueTextUpdate = (messageId: string, text?: string) =>
  queueLifecycleUpdate(
    createTextUpdate({
      messageId,
      userId: "user-1",
      userName: "User One",
      chatId: "dm-chat-1",
      text,
    }),
  );

type MediaDelivery = {
  dispatcherOptions: { deliver: (payload: { text: string; mediaUrl: string }) => Promise<void> };
};

const deliverPhoto =
  (text: string) =>
  async ({ dispatcherOptions }: MediaDelivery) => {
    await dispatcherOptions.deliver({ text, mediaUrl: "https://example.com/reply-image.png" });
  };

type FailureRow = [
  name: string,
  kind: "block" | "tool" | "final",
  payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] },
  flags?: {
    partial?: boolean;
    missingMessageId?: boolean;
    blocked?: boolean;
  },
];
const photo = (name: string) => ({ text: "caption", mediaUrl: `https://example.com/${name}.png` });
const textReply = { text: "reply" };
const photos = (count: number) => ({
  text: "caption",
  mediaUrls: ["first", "second", "third"].slice(0, count).map((name) => photo(name).mediaUrl),
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
      expect(registry.httpRoutes).toHaveLength(hosted ? 1 : 0);
      if (hosted) {
        expect(prepareHostedZaloMediaUrlMock).toHaveBeenCalledWith(
          expect.objectContaining({
            mediaUrl: "https://example.com/reply-image.png",
            maxBytes: 5 * 1024 * 1024,
          }),
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
    ["block text", "block", textReply],
    ["tool photo", "tool", photo("first")],
    ["final photo", "final", photo("final")],
    [
      "blocked hosted photo",
      "tool",
      { text: "caption", mediaUrl: "file:///etc/passwd" },
      { blocked: true },
    ],
    ["partial block photo", "block", photos(3), { partial: true }],
    ["partial tool text", "tool", textReply, { partial: true }],
    ["photo without id", "tool", photos(2), { partial: true, missingMessageId: true }],
    ["text without id", "block", textReply, { partial: true, missingMessageId: true }],
  ])(
    "reports %s failures through the real reply dispatcher",
    async (name, kind, payload, flags = {}) => {
      setActivePluginRegistry(createEmptyPluginRegistry());
      const failure = new Error(`${name} rejected`);
      const acceptedMessageId = "zalo-accepted";
      const acceptedResponse = {
        ok: true,
        ...(flags.missingMessageId ? {} : { result: { message_id: acceptedMessageId } }),
      };
      const isMedia = Boolean(payload.mediaUrl || payload.mediaUrls?.length);
      if (flags.blocked) {
        prepareHostedZaloMediaUrlMock.mockRejectedValueOnce(failure);
      } else {
        const send = isMedia ? sendPhotoMock : sendMessageMock;
        if (flags.partial && !isMedia) {
          const core = getZaloRuntimeMock() as PluginRuntime;
          vi.mocked(core.channel.text.chunkMarkdownTextWithMode).mockReturnValueOnce([
            "first chunk",
            "second chunk",
            "third chunk",
          ]);
        }
        if (flags.partial) {
          send.mockResolvedValueOnce(acceptedResponse);
        }
        send.mockRejectedValueOnce(failure);
      }

      const deliveryErrors: unknown[] = [];
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
          await dispatcher.waitForIdle();
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
        webhookUrl: flags.blocked ? "https://example.com/hooks/zalo" : "",
        statusSink,
      });

      await processed;
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
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
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
      expect(firstHostedMediaRoute.path).toBe("/hooks/zalo/media");

      const second = await startPollingMediaMonitor({
        accountId: "acct-zalo-polling-media-two",
        webhookUrl: "https://example.com/Hooks//Zalo/",
        token: "zalo-token-two",
      });

      await settleAsyncWork();
      const hostedMediaRoute = singleMediaRoute(registry);
      expect(hostedMediaRoute).toBe(firstHostedMediaRoute);

      await (stoppedAccount === "first" ? first : second).stop();
      expect(singleMediaRoute(registry)).toBe(hostedMediaRoute);
      await stopMonitors();
      expect(mediaRoutes(registry)).toHaveLength(0);
    },
  );
});
