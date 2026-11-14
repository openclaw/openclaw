import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it, vi } from "vitest";
import { messageEssay, useTlonMonitorFixture } from "./monitor.test-harness.js";

const {
  authenticateMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
  configureTlon,
  startMonitor,
  getSubscription,
} = useTlonMonitorFixture();

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
    configureTlon({
      ownerShip: "~nec",
      groupChannels: [watchedNest],
      accounts: { secondary: { ship: "~bus" } },
    });
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
    const { runtime, monitor, stop } = startMonitor({ accountId });
    void monitor.catch(started.reject);
    try {
      await started.promise;
      expect(sseClientMock.connect).toHaveBeenCalledTimes(connected + 1);
      vi.spyOn(Date, "now").mockReturnValue(sentAt);
      sseClientMock.scry.mockClear();
      sseClientMock.poke.mockClear();
      await inspect(
        async (text, isGroup, id = "summary-request") => {
          const subscription = getSubscription(isGroup ? "channels" : "chat");
          const essay = messageEssay("~nec", text, sentAt);
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

  it("keeps DM summary on normal dispatch without history or notices", async () => {
    await withMonitor(async (receive) => {
      await receive(summaryRequest, false);
      expect(inboundRuntimeMock.buildContext).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: expect.objectContaining({ bodyForAgent: summaryRequest }),
        }),
      );
      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
      expect(sseClientMock.scry).not.toHaveBeenCalled();
      expect(sseClientMock.poke).not.toHaveBeenCalled();
    });
  });

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
                    essay: messageEssay(
                      "~nec",
                      `current-server-message-${index}`,
                      1_700_000_001_000 + index,
                    ),
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
