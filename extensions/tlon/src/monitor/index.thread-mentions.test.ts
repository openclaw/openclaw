import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { describe, expect, it, vi } from "vitest";
import { useTlonMonitorFixture } from "./monitor.test-harness.js";

const {
  monitorTlonProvider,
  authenticateMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
  realUrbitFixture,
} = useTlonMonitorFixture();

describe("monitorTlonProvider bot-owned thread mention policy", () => {
  it.each([
    { name: "first reply to this bot's root", policy: false, rootAuthor: "~zod", admitted: true },
    { name: "omitted policy", rootAuthor: "~zod", admitted: false },
    { name: "another ship's root", policy: false, rootAuthor: "~bus", admitted: false },
    { name: "unavailable root", policy: false, lookupFails: true, admitted: false },
    {
      name: "required mention after bot participation",
      policy: true,
      rootAuthor: "~zod",
      participate: true,
      admitted: false,
    },
    {
      name: "normal participation in another ship's thread",
      policy: true,
      rootAuthor: "~bus",
      participate: true,
      admitted: true,
    },
    {
      name: "channel override enabling unmentioned replies",
      policy: true,
      channelPolicy: false,
      rootAuthor: "~zod",
      admitted: true,
    },
    {
      name: "channel override requiring mentions after participation",
      policy: false,
      channelPolicy: true,
      rootAuthor: "~zod",
      participate: true,
      admitted: false,
    },
    {
      name: "named account override with its own ship",
      policy: true,
      accountPolicy: false,
      rootAuthor: "~bus",
      admitted: true,
    },
    {
      name: "restricted sender in this bot's thread",
      policy: false,
      rootAuthor: "~zod",
      restricted: true,
      admitted: false,
    },
    {
      name: "sender authorization revoked during root lookup",
      policy: false,
      rootAuthor: "~zod",
      revokeDuringLookup: true,
      admitted: false,
    },
    {
      name: "top-level post",
      policy: false,
      rootAuthor: "~zod",
      topLevel: true,
      admitted: false,
    },
    {
      name: "invalid parent identifier",
      policy: false,
      rootAuthor: "~zod",
      parentId: "../../settings",
      admitted: false,
    },
  ])("applies ownership and authorization for $name", async (row) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
    const channelNest = "chat/~host/general";
    const parentId = row.parentId ?? "1234";
    const botShip = row.accountPolicy !== undefined ? "~bus" : "~zod";
    const rootPath = `/channels/v4/${channelNest}/posts/post/id/1.234.json`;
    realUrbitFixture.config = {
      channels: {
        tlon: {
          code: "code",
          ship: "~zod",
          url: realUrbitFixture.url,
          groupChannels: [channelNest],
          requireMentionInBotThreads: row.policy,
          authorization: {
            channelRules: {
              [channelNest]: {
                mode: row.restricted ? "restricted" : "open",
                requireMentionInBotThreads: row.channelPolicy,
              },
            },
          },
          accounts: {
            secondary: { ship: "~bus", requireMentionInBotThreads: row.accountPolicy },
          },
        },
      },
    };
    authenticateMock.mockResolvedValueOnce("urbauth-test");
    settingsManagerMock.load.mockResolvedValueOnce({});
    ingressMock.receive.mockResolvedValue({ kind: "ignored" });
    sseClientMock.scry.mockImplementation(async (path) => {
      if (path !== rootPath) {
        return {};
      }
      if (row.lookupFails) {
        throw new Error("post unavailable");
      }
      if (row.revokeDuringLookup) {
        settingsManagerMock.onChange.mock.calls[0]?.[0]({
          channelRules: { [channelNest]: { mode: "restricted", allowedShips: [] } },
        });
      }
      return { essay: { author: row.rootAuthor }, seal: { id: "1.234" } };
    });

    const replyEvent = (text: string) => {
      const memo = { author: "~nec", content: [{ inline: [text] }], sent: 1_700_000_000_000 };
      return {
        nest: channelNest,
        response: {
          post: {
            id: parentId,
            "r-post": row.topLevel
              ? { set: { essay: memo } }
              : {
                  reply: {
                    id: "5678",
                    "r-reply": { set: { memo, seal: { "parent-id": parentId } } },
                  },
                },
          },
        },
      };
    };
    const monitor = monitorTlonProvider({
      abortSignal: controller.signal,
      runtime,
      accountId: row.accountPolicy !== undefined ? "secondary" : "default",
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const subscription = sseClientMock.subscribe.mock.calls
        .map(([value]) => value)
        .find((value) => value.app === "channels");
      if (!subscription) {
        throw new Error("expected channel subscription");
      }
      if (row.participate) {
        await subscription.event(replyEvent(`${botShip} hello`));
        const delivery = inboundRuntimeMock.dispatch.mock.calls[0]?.[0].delivery;
        expect(delivery).toBeDefined();
        const reply = { text: "hello back" };
        const result = await delivery.deliver(reply);
        delivery.onDelivered(reply, {}, result);
        inboundRuntimeMock.dispatch.mockClear();
      }
      await subscription.event(replyEvent("follow up without a mention"));

      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(row.admitted ? 1 : 0);
      const shouldReadRoot =
        (row.policy !== undefined || row.accountPolicy !== undefined) &&
        !row.topLevel &&
        !row.parentId;
      const rootLookups = sseClientMock.scry.mock.calls.filter(
        ([path]) => path.includes("/posts/post/id/") && !path.includes("/replies/"),
      );
      expect(rootLookups).toEqual(shouldReadRoot ? [[rootPath]] : []);
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await monitor;
      sseClientMock.scry.mockReset().mockResolvedValue({});
    }
  });
});
