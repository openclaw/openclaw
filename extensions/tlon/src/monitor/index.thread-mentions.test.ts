import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
      name: "legacy settings access rule preserves strict file mention policy",
      policy: false,
      channelPolicy: true,
      settingsRule: { mode: "open" },
      rootAuthor: "~zod",
      participate: true,
      admitted: false,
    },
    {
      name: "explicit mention with a legacy settings access rule",
      policy: false,
      channelPolicy: true,
      settingsRule: { mode: "open" },
      rootAuthor: "~zod",
      mentioned: true,
      admitted: true,
    },
    {
      name: "explicit settings mention policy overrides the strict file policy",
      policy: true,
      channelPolicy: true,
      settingsRule: {
        mode: "restricted",
        allowedShips: ["~nec"],
        requireMentionInBotThreads: false,
      },
      rootAuthor: "~zod",
      admitted: true,
    },
    {
      name: "settings access rule does not inherit the file open mode",
      policy: false,
      channelPolicy: false,
      settingsRule: { allowedShips: [] },
      rootAuthor: "~zod",
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
      name: "bot thread exemption revoked during ingress despite a mention in history",
      policy: false,
      rootAuthor: "~zod",
      pauseAt: "ingress",
      latePolicy: true,
      historyMention: true,
      admitted: false,
    },
    {
      name: "bot thread exemption retained during ingress",
      policy: false,
      rootAuthor: "~zod",
      pauseAt: "ingress",
      latePolicy: false,
      admitted: true,
    },
    {
      name: "raw explicit mention admitted after a strict ingress update",
      policy: false,
      rootAuthor: "~zod",
      pauseAt: "ingress",
      latePolicy: true,
      mentioned: true,
      admitted: true,
    },
    {
      name: "omitted thread policy becomes strict during ingress after participation",
      rootAuthor: "~zod",
      participate: true,
      pauseAt: "ingress",
      latePolicy: true,
      admitted: false,
    },
    {
      name: "empty-history response suppressed after exemption revocation",
      policy: false,
      rootAuthor: "~zod",
      pauseAt: "summary",
      latePolicy: true,
      summary: true,
      admitted: false,
      directReply: false,
    },
    {
      name: "empty-history response admitted while exemption remains",
      policy: false,
      rootAuthor: "~zod",
      pauseAt: "summary",
      latePolicy: false,
      summary: true,
      admitted: false,
      directReply: true,
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
    const paused = createDeferred<void>();
    const resume = createDeferred<void>();
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
    settingsManagerMock.load.mockResolvedValueOnce(
      row.settingsRule ? { channelRules: { [channelNest]: row.settingsRule } } : {},
    );
    ingressMock.receive.mockResolvedValue({ kind: "ignored" });
    sseClientMock.scry.mockImplementation(async (path) => {
      if (row.pauseAt === "summary" && path.endsWith("/posts/newest/50/outline.json")) {
        paused.resolve();
        await resume.promise;
        return [];
      }
      if (row.historyMention && path.endsWith("/replies/newest/20.json")) {
        return [{ memo: { author: "~nec", content: [{ inline: ["~zod earlier message"] }] } }];
      }
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
      if (row.pauseAt === "ingress") {
        const resolveStable = inboundRuntimeMock.resolveStable.getMockImplementation();
        if (!resolveStable) {
          throw new Error("expected ingress resolver");
        }
        inboundRuntimeMock.resolveStable.mockImplementationOnce(async (params) => {
          const access = await resolveStable(params);
          paused.resolve();
          await resume.promise;
          return access;
        });
      }
      const followupText = row.summary ? "summarize this channel" : "follow up without a mention";
      const handling = subscription.event(
        replyEvent(row.mentioned ? `${botShip} ${followupText}` : followupText),
      );
      if (row.pauseAt) {
        await paused.promise;
        expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
        settingsManagerMock.onChange.mock.calls[0]?.[0]({
          channelRules: {
            [channelNest]: { mode: "open", requireMentionInBotThreads: row.latePolicy },
          },
        });
        resume.resolve();
      }
      await handling;

      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(row.admitted ? 1 : 0);
      if (row.summary) {
        const replies = sseClientMock.poke.mock.calls.filter(
          ([value]) => value.mark === "channel-action-1",
        );
        expect(replies).toHaveLength(row.directReply ? 1 : 0);
      }
      const shouldReadRoot =
        (row.policy !== undefined ||
          row.accountPolicy !== undefined ||
          row.channelPolicy !== undefined ||
          row.latePolicy !== undefined) &&
        !row.mentioned &&
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
