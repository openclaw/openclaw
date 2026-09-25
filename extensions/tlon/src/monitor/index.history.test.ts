import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
    onChange: vi.fn().mockReturnValue(() => {}),
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
  createChannelInboundEnvelopeBuilder: vi.fn(() => vi.fn(() => "tlon-envelope")),
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
vi.mock("../settings.js", () => ({
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
      receive: (text: string, isGroup: boolean) => Promise<void>,
      runtime: RuntimeEnv,
    ) => Promise<void>,
    watchedNest = channelNest,
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
        },
      },
    };
    authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
    settingsManagerMock.load.mockResolvedValue({});
    ingressMock.receive.mockResolvedValue({ kind: "ignored" });
    sseClientMock.scry.mockReset().mockResolvedValue({});
    sseClientMock.poke.mockReset().mockResolvedValue(undefined);
    const started = Promise.withResolvers<void>();
    ingressMock.start.mockImplementationOnce(() => started.resolve());
    const monitor = monitorTlonProvider({ abortSignal: controller.signal, runtime });
    void monitor.catch(started.reject);
    try {
      await started.promise;
      expect(sseClientMock.connect).toHaveBeenCalledOnce();
      vi.spyOn(Date, "now").mockReturnValue(sentAt);
      sseClientMock.scry.mockClear();
      sseClientMock.poke.mockClear();
      await inspect(async (text, isGroup) => {
        const subscription = sseClientMock.subscribe.mock.calls
          .map(([value]) => value)
          .find((value) => value.app === (isGroup ? "channels" : "chat"));
        if (!subscription) {
          throw new Error("expected message subscription");
        }
        const essay = { author: "~nec", content: [{ inline: [text] }], sent: sentAt };
        await subscription.event(
          isGroup
            ? {
                nest: watchedNest,
                response: { post: { id: "summary-request", "r-post": { set: { essay } } } },
              }
            : { whom: "~nec", id: "summary-request", response: { add: { essay } } },
        );
      }, runtime);
    } finally {
      controller.abort();
      await monitor;
      sseClientMock.scry.mockReset().mockResolvedValue({});
      sseClientMock.poke.mockReset().mockResolvedValue(undefined);
    }
  }

  it.each(["empty history", "rejected history scry"])(
    "sends only the exact group notice for %s",
    async (scenario) => {
      await withMonitor(async (receive) => {
        if (scenario === "rejected history scry") {
          sseClientMock.scry.mockRejectedValueOnce(new Error("history unavailable"));
        }
        await receive(summaryRequest, true);
        expect(sseClientMock.scry).toHaveBeenCalledExactlyOnceWith(historyPath);
        expect(sseClientMock.poke.mock.calls).toEqual([[groupPoke(emptyNotice)]]);
        expect(inboundRuntimeMock.buildContext).not.toHaveBeenCalled();
        expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
      });
    },
  );

  it("sends the error notice after a failed empty-history notice", async () => {
    await withMonitor(async (receive) => {
      sseClientMock.poke.mockRejectedValueOnce(new Error("first notice failed"));
      await receive(summaryRequest, true);
      expect(sseClientMock.poke.mock.calls).toEqual([
        [groupPoke(emptyNotice)],
        [groupPoke(errorNotice)],
      ]);
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    });
  });

  it("propagates the second send failure through the awaited firehose handler", async () => {
    await withMonitor(async (receive, runtime) => {
      const secondFailure = new Error("second notice failed");
      sseClientMock.poke
        .mockRejectedValueOnce(new Error("first notice failed"))
        .mockRejectedValueOnce(secondFailure);
      await expect(receive(summaryRequest, true)).rejects.toBe(secondFailure);
      expect(sseClientMock.poke.mock.calls).toEqual([
        [groupPoke(emptyNotice)],
        [groupPoke(errorNotice)],
      ]);
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
        "[tlon] Error handling channel firehose event: second notice failed",
      );
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    });
  });

  it("does not send or dispatch for an invalid watched channel nest", async () => {
    await withMonitor(async (receive) => {
      await receive(summaryRequest, true);
      expect(sseClientMock.scry).toHaveBeenCalledExactlyOnceWith(
        "/channels/v4/invalid-nest/posts/newest/50/outline.json",
      );
      expect(sseClientMock.poke).not.toHaveBeenCalled();
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    }, "invalid-nest");
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
          expect.objectContaining({
            message: expect.objectContaining({ bodyForAgent: body }),
          }),
        );
        expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
        expect(sseClientMock.scry).not.toHaveBeenCalled();
        expect(sseClientMock.poke).not.toHaveBeenCalled();
      });
    },
  );
});

describe("monitorTlonProvider history ownership", () => {
  it.each(["restart", "concurrent account"] as const)(
    "fetches current server history for a new monitor after %s",
    async (scenario) => {
      const firstController = new AbortController();
      const nextController = new AbortController();
      const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
      const channelNest = `chat/~zod/history-${scenario.replace(" ", "-")}`;
      const historyPath = `/channels/v4/${channelNest}/posts/newest/50/outline.json`;
      const nextShip = scenario === "restart" ? "~zod" : "~bus";
      monitorFixture.config = {
        channels: {
          tlon: {
            code: "code",
            ship: "~zod",
            url: monitorFixture.url,
            ownerShip: "~nec",
            groupChannels: [channelNest],
            accounts: { secondary: { ship: "~bus" } },
          },
        },
      };
      authenticateMock
        .mockResolvedValueOnce("urbauth-~zod=proof")
        .mockResolvedValueOnce(`urbauth-${nextShip}=proof`);
      settingsManagerMock.load.mockResolvedValue({});
      ingressMock.receive.mockResolvedValue({ kind: "ignored" });
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

      const channelPost = (text: string, id: string) => ({
        nest: channelNest,
        response: {
          post: {
            id,
            "r-post": {
              set: {
                essay: {
                  author: "~nec",
                  content: [{ inline: [text] }],
                  sent: 1_700_000_000_000,
                },
              },
            },
          },
        },
      });
      const firstMonitor = monitorTlonProvider({
        abortSignal: firstController.signal,
        runtime,
      });
      const monitors = [firstMonitor];
      try {
        await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
        const firstSubscription = sseClientMock.subscribe.mock.calls
          .map(([subscription]) => subscription)
          .find(({ app }) => app === "channels");
        if (!firstSubscription) {
          throw new Error("expected first channel subscription");
        }
        for (let index = 0; index < 50; index += 1) {
          await firstSubscription.event(channelPost(`old-cache-${index}`, `old-${index}`));
        }
        expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
        if (scenario === "restart") {
          firstController.abort();
          await firstMonitor;
        }

        monitors.push(
          monitorTlonProvider({
            accountId: scenario === "restart" ? "default" : "secondary",
            abortSignal: nextController.signal,
            runtime,
          }),
        );
        await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledTimes(2));
        const nextSubscription = sseClientMock.subscribe.mock.calls
          .map(([subscription]) => subscription)
          .findLast(({ app }) => app === "channels");
        if (!nextSubscription) {
          throw new Error("expected next channel subscription");
        }
        await nextSubscription.event(
          channelPost(`${nextShip} summarize this channel`, "summary-request"),
        );

        expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
        const buildContextCall = inboundRuntimeMock.buildContext.mock.calls[0];
        if (!buildContextCall) {
          throw new Error("expected inbound context call");
        }
        const [contextInput] = buildContextCall;
        expect(contextInput.message.bodyForAgent).toContain("current-server-message-0");
        expect(contextInput.message.bodyForAgent).toContain("current-server-message-49");
        expect(contextInput.message.bodyForAgent).not.toContain("old-cache-");
        expect(sseClientMock.scry).toHaveBeenCalledWith(historyPath);
        expect(runtime.error).not.toHaveBeenCalled();
      } finally {
        firstController.abort();
        nextController.abort();
        await Promise.all(monitors);
        sseClientMock.scry.mockReset().mockResolvedValue({});
      }
    },
  );
});
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
