import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { messageEssay, useTlonMonitorFixture } from "./monitor.test-harness.js";

const {
  configureTlon,
  withMonitor,
  startMonitor,
  getSubscription,
  authenticateMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
} = useTlonMonitorFixture();

describe("monitorTlonProvider bot-owned thread mention policy", () => {
  it.each([
    { name: "another ship's root", rootAuthor: "~bus" },
    { name: "unavailable root", lookupFails: true },
    {
      name: "legacy settings access rule preserves strict file mention policy",
      channelPolicy: true,
      settingsRule: { mode: "open" },
      participate: true,
    },
    {
      name: "settings access rule does not inherit the file open mode",
      channelPolicy: false,
      settingsRule: { allowedShips: [] },
    },
    {
      name: "sender authorization revoked during root lookup",
      revokeDuringLookup: true,
    },
    {
      name: "bot thread exemption revoked during ingress despite a mention in history",
      pauseAt: "ingress",
      latePolicy: true,
      historyMention: true,
    },
    {
      name: "raw explicit mention admitted after a strict ingress update",
      pauseAt: "ingress",
      latePolicy: true,
      mentioned: true,
      admitted: true,
    },
    {
      name: "sender removed from the allowlist during ingress",
      restricted: true,
      allowedShips: ["~nec"],
      pauseAt: "ingress",
      latePolicy: false,
      lateAllowedShips: [],
    },
    {
      name: "sender remains allowlisted after an ingress policy update",
      pauseAt: "ingress",
      latePolicy: false,
      lateAllowedShips: ["~nec"],
      admitted: true,
    },
    {
      name: "owner remains admitted after an ingress allowlist removal",
      ownerShip: "~nec",
      pauseAt: "ingress",
      latePolicy: false,
      lateAllowedShips: [],
      admitted: true,
    },
    {
      name: "omitted thread policy becomes strict during ingress after participation",
      policy: undefined,
      participate: true,
      pauseAt: "ingress",
      latePolicy: true,
    },
    {
      name: "empty-history response suppressed after exemption revocation",
      pauseAt: "summary",
      latePolicy: true,
      summary: true,
      directReply: false,
    },
    {
      name: "empty-history response admitted while exemption remains",
      pauseAt: "summary",
      latePolicy: false,
      summary: true,
      directReply: true,
    },
    {
      name: "invalid parent identifier",
      parentId: "../../settings",
    },
  ])("applies ownership and authorization for $name", async (scenario) => {
    const row = { policy: false, rootAuthor: "~zod", admitted: false, ...scenario };
    vi.useFakeTimers();
    const channelNest = "chat/~host/general";
    const parentId = row.parentId ?? "1234";
    const botShip = "~zod";
    const rootPath = `/channels/v4/${channelNest}/posts/post/id/1.234.json`;
    const paused = createDeferred<void>();
    const resume = createDeferred<void>();
    configureTlon({
      ownerShip: row.ownerShip,
      groupChannels: [channelNest],
      requireMentionInBotThreads: row.policy,
      authorization: {
        channelRules: {
          [channelNest]: {
            mode: row.restricted ? "restricted" : "open",
            allowedShips: row.allowedShips,
            requireMentionInBotThreads: row.channelPolicy,
          },
        },
      },
    });
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
        settingsManagerMock.startSubscription.mock.calls[0]?.[0]({
          channelRules: { [channelNest]: { mode: "restricted", allowedShips: [] } },
        });
      }
      return { essay: { author: row.rootAuthor }, seal: { id: "1.234" } };
    });

    const replyEvent = (text: string) => {
      const memo = messageEssay("~nec", text);
      return {
        nest: channelNest,
        response: {
          post: {
            id: parentId,
            "r-post": {
              reply: {
                id: "5678",
                "r-reply": { set: { memo, seal: { "parent-id": parentId } } },
              },
            },
          },
        },
      };
    };
    const { runtime, stop } = startMonitor({ accountId: "default" });
    try {
      await vi.advanceTimersByTimeAsync(0);
      const subscription = getSubscription("channels");
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
        settingsManagerMock.startSubscription.mock.calls[0]?.[0]({
          channelRules: {
            [channelNest]: {
              mode: row.lateAllowedShips === undefined ? "open" : "restricted",
              allowedShips: row.lateAllowedShips,
              requireMentionInBotThreads: row.latePolicy,
            },
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
          row.channelPolicy !== undefined ||
          row.latePolicy !== undefined) &&
        !row.mentioned &&
        !row.parentId;
      const rootLookups = sseClientMock.scry.mock.calls.filter(
        ([path]) => path.includes("/posts/post/id/") && !path.includes("/replies/"),
      );
      expect(rootLookups).toEqual(shouldReadRoot ? [[rootPath]] : []);
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      await stop();
      sseClientMock.scry.mockReset().mockResolvedValue({});
    }
  });
});

it("fetches and prepends citations only after DM and channel sender admission", async () => {
  vi.useFakeTimers();
  const nest = "chat/~zod/citations";
  const content = [
    { block: { cite: { chan: { nest, where: "/msg/~bus/12345" } } } },
    { inline: ["~zod inspect this citation"] },
  ];
  configureTlon({
    dmAllowlist: ["~bus"],
    defaultAuthorizedShips: ["~bus"],
    groupChannels: [nest],
  });
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({});
  ingressMock.receive.mockResolvedValue({ kind: "ignored" });
  await withMonitor(
    async (runtime) => {
      for (const source of ["chat", "channels"]) {
        const subscription = getSubscription(source);
        for (const sender of ["~nec", "~bus"]) {
          sseClientMock.scry.mockReset().mockResolvedValue({
            essay: { content: [{ inline: ["CITED-CONTENT"] }] },
          });
          inboundRuntimeMock.buildContext.mockClear();
          inboundRuntimeMock.dispatch.mockClear();
          const essay = messageEssay(sender, content);
          const id = `${source}-${sender}`;
          await subscription.event(
            source === "chat"
              ? { whom: sender, id, response: { add: { essay } } }
              : { nest, response: { post: { id, "r-post": { set: { essay } } } } },
          );
          if (sender === "~nec") {
            expect(sseClientMock.scry).not.toHaveBeenCalled();
            expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
          } else {
            expect(sseClientMock.scry).toHaveBeenCalledExactlyOnceWith(
              `/channels/v4/${nest}/posts/post/12345.json`,
            );
            expect(inboundRuntimeMock.buildContext.mock.calls[0]?.[0].message.rawBody).toBe(
              `> ~bus wrote: CITED-CONTENT\n\n> [quoted: ~bus in ${nest}]\n\n~zod inspect this citation`,
            );
            expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
          }
        }
      }
      expect(runtime.error).not.toHaveBeenCalled();
    },
    { waitForStart: true },
  );
});

it("retires terminal group invites without forgetting unrelated foreigns deltas", async () => {
  vi.useFakeTimers();
  configureTlon({
    autoAcceptGroupInvites: true,
    groupInviteAllowlist: ["~bus"],
  });
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({});
  await withMonitor(
    async (runtime) => {
      const subscription = getSubscription("groups", "/v1/foreigns");
      sseClientMock.poke.mockClear();
      const active = { invites: [{ valid: true, from: "~bus" }] };
      const unrelated = { "~bus/unrelated": active };
      await subscription.event(unrelated);
      const expectedJoins = ["~bus/unrelated"];
      for (const [state, terminal] of [
        ["revoked", { invites: [{ valid: false, from: "~bus" }] }],
        ["removed", { invites: [] }],
        ["done", { ...active, progress: "done" }],
      ] as const) {
        const groupFlag = `~bus/${state}`;
        const invite = { [groupFlag]: active };
        await subscription.event(invite);
        expectedJoins.push(groupFlag);
        await subscription.event(unrelated);
        await subscription.event(invite);
        await subscription.event({ [groupFlag]: terminal });
        await subscription.event(unrelated);
        await subscription.event(invite);
        expectedJoins.push(groupFlag);
        expect(sseClientMock.poke.mock.calls.map(([call]) => call.json.flag)).toEqual(
          expectedJoins,
        );
      }
      await subscription.event({ "~nec/blocked": { invites: [{ valid: true, from: "~nec" }] } });
      expect(sseClientMock.poke.mock.calls).toEqual(
        expectedJoins.map((flag) => [
          { app: "groups", mark: "group-join", json: { flag, "join-all": true } },
        ]),
      );
      expect(runtime.error).not.toHaveBeenCalled();
    },
    { waitForStart: true },
  );
});
