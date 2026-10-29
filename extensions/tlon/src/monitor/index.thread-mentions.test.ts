import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messageEssay, useTlonMonitorFixture } from "./monitor.test-harness.js";
const {
  configureTlon,
  withMonitor,
  getSubscription,
  authenticateMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
} = useTlonMonitorFixture();
beforeEach(() => {
  vi.useFakeTimers();
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValue({});
  ingressMock.receive.mockResolvedValue({ kind: "ignored" });
  sseClientMock.scry.mockReset().mockResolvedValue({});
});
async function runMonitor(run: () => Promise<void>) {
  await withMonitor(
    async (runtime) => {
      await run();
      expect(runtime.error).not.toHaveBeenCalled();
    },
    { accountId: "default", waitForStart: true },
  );
}
type CitationCase = readonly ["chat" | "channels", string, string, boolean, boolean];
const citedEssay = { essay: { content: [{ inline: ["CITED-CONTENT"] }] } };
async function checkCitationCase(sourceNest: string, row: CitationCase) {
  const [source, sender, cited, admitted, expands] = row;
  sseClientMock.scry.mockReset().mockResolvedValue(citedEssay);
  inboundRuntimeMock.dispatch.mockClear();
  const essay = messageEssay(sender, [
    { block: { cite: { chan: { nest: cited, where: "/msg/~bus/12345" } } } },
    { inline: ["~zod inspect this citation"] },
  ]);
  await getSubscription(source).event(
    source === "chat"
      ? { whom: sender, id: cited, response: { add: { essay } } }
      : { nest: sourceNest, response: { post: { id: cited, "r-post": { set: { essay } } } } },
  );
  expect(inboundRuntimeMock.dispatch).toHaveBeenCalledTimes(admitted ? 1 : 0);
  expect(sseClientMock.scry.mock.calls.map(([path]) => [path])).toEqual(
    expands ? [[`/channels/v4/${cited}/posts/post/12345.json`]] : [],
  );
  if (expands) {
    expect(inboundRuntimeMock.buildContext.mock.calls.at(-1)?.[0].message.rawBody).toContain(
      "CITED-CONTENT",
    );
  }
}
describe("monitorTlonProvider bot-owned thread mention policy", () => {
  it.each([
    { parallelPost: true, rawReplyId: " reply-stable ", admitted: true },
    { rootAuthor: "~bus" },
    { lookupFails: true },
    { channelPolicy: true, settingsRule: { mode: "open" }, participate: true },
    { channelPolicy: false, settingsRule: { allowedShips: [] } },
    { revokeDuringLookup: true },
    { pauseAt: "ingress", latePolicy: true, historyMention: true },
    { pauseAt: "ingress", latePolicy: true, mentioned: true, admitted: true },
    {
      restricted: true,
      allowedShips: ["~nec"],
      pauseAt: "ingress",
      latePolicy: false,
      lateAllowedShips: [],
    },
    { pauseAt: "ingress", latePolicy: false, lateAllowedShips: ["~nec"], admitted: true },
    {
      ownerShip: "~nec",
      pauseAt: "ingress",
      latePolicy: false,
      lateAllowedShips: [],
      admitted: true,
    },
    { policy: undefined, participate: true, pauseAt: "ingress", latePolicy: true },
    { pauseAt: "summary", latePolicy: true, summary: true, directReply: false },
    { pauseAt: "summary", latePolicy: false, summary: true, directReply: true },
    { parentId: "../../settings" },
  ])("applies ownership and authorization for %j", async (scenario) => {
    const row = { policy: false, rootAuthor: "~zod", admitted: false, ...scenario };
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
    settingsManagerMock.load.mockResolvedValueOnce(
      row.settingsRule ? { channelRules: { [channelNest]: row.settingsRule } } : {},
    );
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

    const replyEvent = (text: string) => ({
      nest: channelNest,
      response: {
        post: {
          id: parentId,
          "r-post": {
            ...(row.parallelPost
              ? { set: { essay: messageEssay("~bus", "parent essay"), seal: { parent: "9999" } } }
              : {}),
            reply: {
              id: row.rawReplyId ?? "5678",
              "r-reply": {
                set: { memo: messageEssay("~nec", text), seal: { "parent-id": parentId } },
              },
            },
          },
        },
      },
    });
    await runMonitor(async () => {
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
      if (row.rawReplyId) {
        expect(inboundRuntimeMock.buildContext).toHaveBeenCalledWith(
          expect.objectContaining({ messageId: row.rawReplyId }),
        );
      }
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
    });
  });
});
it("applies explicit and automatic citation scopes", async () => {
  const nest = "chat/~zod/citations";
  const settingsNest = "chat/~zod/announcements";
  for (const auto of [false, true]) {
    const cases: readonly CitationCase[] = auto
      ? [
          ["channels", "~bus", "diary/~private/notes", true, true],
          ["channels", "~bus", "heap/~private/gallery", true, true],
        ]
      : [
          ["chat", "~nec", nest, false, false],
          ["channels", "~nec", nest, false, false],
          ["channels", "~bus", nest, true, true],
          ["channels", "~bus", settingsNest, true, true],
          ["chat", "~bus", "chat/~zod/new", true, true],
          ["channels", "~bus", "chat/~private/leadership", true, false],
          ["channels", "~bus", "diary/~private/notes", true, false],
          ["chat", "~bus", nest, true, true],
          ["chat", "~bus", "chat/~private/leadership", true, false],
        ];
    settingsManagerMock.load.mockResolvedValueOnce(auto ? {} : { groupChannels: [settingsNest] });
    configureTlon({
      autoDiscoverChannels: auto,
      autoAcceptGroupInvites: true,
      dmAllowlist: ["~bus"],
      defaultAuthorizedShips: ["~bus"],
      groupChannels: [nest],
    });
    await runMonitor(async () => {
      if (!auto) {
        await getSubscription("groups", "/groups/ui").event({ channels: { "chat/~zod/new": {} } });
      }
      for (const row of cases) {
        await checkCitationCase(nest, row);
      }
      const update = auto ? { autoDiscoverChannels: false } : { groupChannels: [] };
      sseClientMock.poke.mockImplementationOnce(async () => {
        settingsManagerMock.startSubscription.mock.calls.at(-1)?.[0](update);
      });
      await getSubscription("groups", "/groups/ui").event({ channels: { "chat/~zod/race": {} } });
      const revoked = auto ? "diary/~private/notes" : settingsNest;
      await checkCitationCase(nest, ["chat", "~bus", revoked, true, false]);
    });
  }
});
const ownerNotices = () =>
  JSON.stringify(
    sseClientMock.poke.mock.calls.filter(([payload]) => payload.mark === "chat-dm-action"),
  );
const ownerReply = (id: string, text: string) =>
  getSubscription("chat").event({
    whom: "~nec",
    id,
    response: { add: { essay: messageEssay("~nec", text) } },
  });
it("does not guess which restricted channel mention a bare approval targets", async () => {
  const nest = "chat/~host/general";
  configureTlon({ ownerShip: "~nec", groupChannels: [nest] });
  const channelRuleWrites = () =>
    sseClientMock.poke.mock.calls
      .map(([payload]) => payload.json?.["put-entry"])
      .filter((entry) => entry?.["entry-key"] === "channelRules");
  await runMonitor(async () => {
    const subscription = getSubscription("channels");
    await subscription.event({
      nest,
      response: {
        post: { id: "mention-bus", "r-post": { set: { essay: messageEssay("~bus", "~zod hi") } } },
      },
    });
    await subscription.event({
      nest,
      response: {
        post: {
          id: "mention-sampel",
          "r-post": { set: { essay: messageEssay("~sampel", "~zod hello") } },
        },
      },
    });
    const approvalIds = [...new Set(ownerNotices().match(/channel-\d+-[a-f0-9]+/g) ?? [])];
    expect(approvalIds).toHaveLength(2);
    await ownerReply("bare-approve", "approve");
    expect(ownerNotices()).toContain("Multiple approvals are pending");
    expect(channelRuleWrites()).toEqual([]);
    expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
    await ownerReply("explicit-approve", `approve ${approvalIds[0]}`);
    expect(channelRuleWrites()).toHaveLength(1);
    expect(JSON.parse(String(channelRuleWrites()[0]?.value))).toEqual({
      [nest]: { mode: "restricted", allowedShips: ["~bus"] },
    });
  });
});
it("does not guess which queued group invite a bare approval targets", async () => {
  configureTlon({ ownerShip: "~nec" });
  const groupJoins = () =>
    sseClientMock.poke.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.mark === "group-join");
  await runMonitor(async () => {
    await getSubscription("groups", "/v1/foreigns").event({
      "~bus/club": { invites: [{ valid: true, from: "~bus" }] },
      "~sampel/club": { invites: [{ valid: true, from: "~sampel" }] },
    });
    const approvalIds = [...new Set(ownerNotices().match(/group-\d+-[a-f0-9]+/g) ?? [])];
    expect(approvalIds).toHaveLength(2);

    await ownerReply("bare-approve", "approve");
    expect(ownerNotices()).toContain("Multiple approvals are pending");
    expect(groupJoins()).toEqual([]);

    await ownerReply("explicit-approve", `approve ${approvalIds[0]}`);
    expect(groupJoins().map((payload) => payload.json)).toEqual([
      { flag: "~bus/club", "join-all": true },
    ]);
  });
});

it("retires terminal group invites without forgetting unrelated foreigns deltas", async () => {
  configureTlon({
    autoAcceptGroupInvites: true,
    groupInviteAllowlist: ["~bus"],
  });
  await runMonitor(async () => {
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
      expect(sseClientMock.poke.mock.calls.map(([call]) => call.json.flag)).toEqual(expectedJoins);
    }
    await subscription.event({ "~nec/blocked": { invites: [{ valid: true, from: "~nec" }] } });
    expect(sseClientMock.poke.mock.calls).toEqual(
      expectedJoins.map((flag) => [
        { app: "groups", mark: "group-join", json: { flag, "join-all": true } },
      ]),
    );
  });
});
