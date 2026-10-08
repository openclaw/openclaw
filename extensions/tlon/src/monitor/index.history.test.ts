import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  authenticateMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
  monitorFixture,
} = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  sseClientMock: {
    scry: vi.fn().mockResolvedValue({}),
    subscribe: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    stopReceiving: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    poke: vi.fn().mockResolvedValue(undefined),
  },
  ingressMock: {
    receive: vi.fn().mockResolvedValue({ kind: "ignored" }),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  },
  inboundRuntimeMock: {
    buildContext: vi.fn().mockReturnValue({ kind: "tlon-inbound-context" }),
    dispatch: vi.fn().mockResolvedValue(undefined),
    resolveAgentRoute: vi.fn(() => ({
      accountId: "default",
      agentId: "main",
      dmScope: "main",
      sessionKey: "agent:main:main",
    })),
    resolveEffectiveMessagesConfig: vi.fn(() => ({ responsePrefix: undefined })),
    shouldComputeCommandAuthorized: vi.fn(() => false),
  },
  settingsManagerMock: {
    load: vi.fn().mockResolvedValue({}),
    startSubscription: vi.fn().mockResolvedValue(undefined),
  },
  monitorFixture: {
    config: {} as OpenClawConfig,
    url: "https://urbit.example.com",
  },
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  createChannelInboundEnvelopeBuilderAsync: vi.fn(async () => vi.fn(() => "tlon-envelope")),
}));

vi.mock("../runtime.js", () => ({
  getTlonRuntime: () => ({
    config: { current: () => monitorFixture.config },
    logging: { getChildLogger: () => ({}) },
    channel: {
      commands: {
        shouldComputeCommandAuthorized: inboundRuntimeMock.shouldComputeCommandAuthorized,
      },
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        buildContext: inboundRuntimeMock.buildContext,
        dispatch: inboundRuntimeMock.dispatch,
      },
      reply: {
        resolveEffectiveMessagesConfig: inboundRuntimeMock.resolveEffectiveMessagesConfig,
      },
      routing: { resolveAgentRoute: inboundRuntimeMock.resolveAgentRoute },
    },
  }),
}));

vi.mock("../urbit/auth.js", () => ({ authenticate: authenticateMock }));
vi.mock("../urbit/sse-client.js", () => ({
  UrbitSSEClient: vi.fn(function () {
    return sseClientMock;
  }),
}));
vi.mock("../settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../settings.js")>()),
  createSettingsManager: vi.fn(() => settingsManagerMock),
}));
vi.mock("./ingress.js", () => ({
  createTlonIngressMonitor: vi.fn(() => ingressMock),
}));

import { monitorTlonProvider } from "./index.js";
import { formatSummarizationHistoryText } from "./utils.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
  monitorFixture.config = {};
});

describe("monitorTlonProvider summary delivery", () => {
  const channelNest = "chat/~zod/summary-boundary";
  const historyPath = `/channels/v4/${channelNest}/posts/newest/50/outline.json`;
  const sentAt = 1_700_000_000_000;
  const summaryRequest = "~zod summarize this channel";
  const emptyNotice =
    "I couldn't fetch any messages for this channel. It might be empty or there might be a permissions issue.";
  const errorNotice =
    "Sorry, I encountered an error while fetching the channel history: first notice failed";

  function groupPoke(text: string) {
    return {
      app: "channels",
      mark: "channel-action-1",
      json: {
        channel: {
          nest: channelNest,
          action: {
            post: {
              add: {
                content: [{ inline: [text] }],
                author: "~zod",
                sent: sentAt,
                kind: "/chat",
                blob: null,
                meta: null,
              },
            },
          },
        },
      },
    };
  }

  async function withMonitor(
    inspect: (
      receive: (text: string, isGroup: boolean, id?: string) => Promise<void>,
      runtime: RuntimeEnv,
      stop: () => Promise<void>,
    ) => Promise<void>,
    watchedNest = channelNest,
    accountId = "default",
  ) {
    const controller = new AbortController();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    monitorFixture.config = {
      channels: {
        tlon: {
          code: "code",
          ship: "~zod",
          url: monitorFixture.url,
          ownerShip: "~nec",
          groupChannels: [watchedNest],
          accounts: { secondary: { ship: "~bus" } },
        },
      },
    };
    authenticateMock.mockResolvedValueOnce(
      `urbauth-${accountId === "secondary" ? "~bus" : "~zod"}=proof`,
    );
    settingsManagerMock.load.mockResolvedValue({});
    ingressMock.receive.mockResolvedValue({ kind: "ignored" });
    sseClientMock.scry.mockReset().mockResolvedValue({});
    sseClientMock.poke.mockReset().mockResolvedValue(undefined);
    const connected = sseClientMock.connect.mock.calls.length;
    const started = Promise.withResolvers<void>();
    ingressMock.start.mockImplementationOnce(() => started.resolve());
    const monitor = monitorTlonProvider({
      scheduler: createTestPluginServiceScheduler(),
      abortSignal: controller.signal,
      accountId,
      runtime,
    });
    void monitor.catch(started.reject);
    const stop = async () => {
      controller.abort();
      await monitor;
    };
    try {
      await started.promise;
      expect(sseClientMock.connect).toHaveBeenCalledTimes(connected + 1);
      vi.spyOn(Date, "now").mockReturnValue(sentAt);
      sseClientMock.scry.mockClear();
      sseClientMock.poke.mockClear();
      await inspect(
        async (text, isGroup, id = "summary-request") => {
          const subscription = sseClientMock.subscribe.mock.calls
            .map(([value]) => value)
            .findLast((value) => value.app === (isGroup ? "channels" : "chat"));
          if (!subscription) {
            throw new Error("expected message subscription");
          }
          const essay = { author: "~nec", content: [{ inline: [text] }], sent: sentAt };
          await subscription.event(
            isGroup
              ? {
                  nest: watchedNest,
                  response: { post: { id, "r-post": { set: { essay } } } },
                }
              : { whom: "~nec", id, response: { add: { essay } } },
          );
        },
        runtime,
        stop,
      );
    } finally {
      await stop();
      sseClientMock.scry.mockReset().mockResolvedValue({});
      sseClientMock.poke.mockReset().mockResolvedValue(undefined);
    }
  }

  it.each([
    { name: "empty history", rejected: false, failures: 0, nest: channelNest },
    { name: "rejected history scry", rejected: true, failures: 0, nest: channelNest },
    { name: "failed empty notice", rejected: false, failures: 1, nest: channelNest },
    { name: "failed error notice", rejected: false, failures: 2, nest: channelNest },
    { name: "invalid watched nest", rejected: false, failures: 0, nest: "invalid-nest" },
  ])("handles $name without dispatching", async ({ rejected, failures, nest }) => {
    await withMonitor(async (receive, runtime) => {
      if (rejected) {
        sseClientMock.scry.mockRejectedValueOnce(new Error("history unavailable"));
      }
      const secondFailure = new Error("second notice failed");
      if (failures > 0) {
        sseClientMock.poke.mockRejectedValueOnce(new Error("first notice failed"));
      }
      if (failures === 2) {
        sseClientMock.poke.mockRejectedValueOnce(secondFailure);
        await expect(receive(summaryRequest, true)).rejects.toBe(secondFailure);
        expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
          "[tlon] Error handling channel firehose event: second notice failed",
        );
      } else {
        await receive(summaryRequest, true);
      }
      expect(sseClientMock.scry).toHaveBeenCalledExactlyOnceWith(
        `/channels/v4/${nest}/posts/newest/50/outline.json`,
      );
      const notices =
        nest !== channelNest ? [] : failures ? [emptyNotice, errorNotice] : [emptyNotice];
      expect(sseClientMock.poke.mock.calls).toEqual(notices.map((text) => [groupPoke(text)]));
      expect(inboundRuntimeMock.buildContext).not.toHaveBeenCalled();
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    }, nest);
  });

  it("dispatches the complete summary prompt for nonempty history", async () => {
    await withMonitor(async (receive) => {
      sseClientMock.scry.mockResolvedValueOnce([
        {
          essay: {
            author: "~nec",
            content: [{ inline: ["Keep the launch date."] }],
            sent: sentAt,
          },
        },
      ]);
      await receive(summaryRequest, true);
      const historyText = formatSummarizationHistoryText(
        [{ author: "~nec", content: "Keep the launch date.", timestamp: sentAt }],
        monitorFixture.config,
      );
      expect(inboundRuntimeMock.buildContext).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: expect.objectContaining({
            bodyForAgent:
              `Please summarize this channel conversation (1 recent messages):\n\n${historyText}\n\n` +
              "Provide a concise summary highlighting:\n" +
              "1. Main topics discussed\n" +
              "2. Key decisions or conclusions\n" +
              "3. Action items if any\n" +
              "4. Notable participants",
          }),
        }),
      );
      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
      expect(sseClientMock.poke).not.toHaveBeenCalled();
    });
  });

  it.each([
    { name: "DM summary", isGroup: false, text: summaryRequest, body: summaryRequest },
    { name: "ordinary group message", isGroup: true, text: "~zod hello", body: "hello" },
  ])(
    "keeps $name on normal dispatch without history or notices",
    async ({ isGroup, text, body }) => {
      await withMonitor(async (receive) => {
        await receive(text, isGroup);
        expect(inboundRuntimeMock.buildContext).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: expect.objectContaining({ bodyForAgent: body }) }),
        );
        expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
        expect(sseClientMock.scry).not.toHaveBeenCalled();
        expect(sseClientMock.poke).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["restart", "concurrent account"] as const)(
    "fetches current server history for a new monitor after %s",
    async (scenario) => {
      await withMonitor(async (firstReceive, firstRuntime, stop) => {
        for (let index = 0; index < 50; index += 1) {
          await firstReceive(`old-cache-${index}`, true, `old-${index}`);
        }
        expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
        if (scenario === "restart") {
          await stop();
        }
        await withMonitor(
          async (receive, runtime) => {
            sseClientMock.scry.mockImplementation(async (path) =>
              path === historyPath
                ? Array.from({ length: 50 }, (_, index) => ({
                    essay: {
                      author: "~nec",
                      content: [{ inline: [`current-server-message-${index}`] }],
                      sent: 1_700_000_001_000 + index,
                    },
                  }))
                : {},
            );
            const nextShip = scenario === "restart" ? "~zod" : "~bus";
            await receive(`${nextShip} summarize this channel`, true);
            expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
            const [contextInput] = inboundRuntimeMock.buildContext.mock.calls[0] ?? [];
            expect(contextInput?.message.bodyForAgent).toContain("current-server-message-0");
            expect(contextInput?.message.bodyForAgent).toContain("current-server-message-49");
            expect(contextInput?.message.bodyForAgent).not.toContain("old-cache-");
            expect(sseClientMock.scry).toHaveBeenCalledWith(historyPath);
            expect(runtime.error).not.toHaveBeenCalled();
          },
          channelNest,
          scenario === "restart" ? "default" : "secondary",
        );
        expect(firstRuntime.error).not.toHaveBeenCalled();
      });
    },
  );
});
