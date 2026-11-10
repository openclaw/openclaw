import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
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
    { name: "another ship's root", policy: false, rootAuthor: "~bus", admitted: false },
    { name: "unavailable root", policy: false, lookupFails: true, admitted: false },
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
      name: "settings access rule does not inherit the file open mode",
      policy: false,
      channelPolicy: false,
      settingsRule: { allowedShips: [] },
      rootAuthor: "~zod",
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
      name: "raw explicit mention admitted after a strict ingress update",
      policy: false,
      rootAuthor: "~zod",
      pauseAt: "ingress",
      latePolicy: true,
      mentioned: true,
      admitted: true,
    },
    {
      name: "sender removed from the allowlist during ingress",
      policy: false,
      rootAuthor: "~zod",
      restricted: true,
      allowedShips: ["~nec"],
      pauseAt: "ingress",
      latePolicy: false,
      lateAllowedShips: [],
      admitted: false,
    },
    {
      name: "sender remains allowlisted after an ingress policy update",
      policy: false,
      rootAuthor: "~zod",
      pauseAt: "ingress",
      latePolicy: false,
      lateAllowedShips: ["~nec"],
      admitted: true,
    },
    {
      name: "owner remains admitted after an ingress allowlist removal",
      policy: false,
      rootAuthor: "~zod",
      ownerShip: "~nec",
      pauseAt: "ingress",
      latePolicy: false,
      lateAllowedShips: [],
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
    const botShip = "~zod";
    const rootPath = `/channels/v4/${channelNest}/posts/post/id/1.234.json`;
    const paused = createDeferred<void>();
    const resume = createDeferred<void>();
    realUrbitFixture.config = {
      channels: {
        tlon: {
          code: "code",
          ship: "~zod",
          url: realUrbitFixture.url,
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
        settingsManagerMock.startSubscription.mock.calls[0]?.[0]({
          channelRules: { [channelNest]: { mode: "restricted", allowedShips: [] } },
        });
      }
      return { essay: { author: row.rootAuthor }, seal: { id: "1.234" } };
    });

    const replyEvent = (text: string) => {
      const memo = {
        author: "~nec",
        content: typeof text === "string" ? [{ inline: [text] }] : text,
        sent: 1_700_000_000_000,
      };
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
    const monitor = monitorTlonProvider({
      scheduler: createTestPluginServiceScheduler(),
      abortSignal: controller.signal,
      runtime,
      accountId: "default",
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
      controller.abort();
      await monitor;
      sseClientMock.scry.mockReset().mockResolvedValue({});
    }
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

it("retires terminal group invites without forgetting unrelated foreigns deltas", async () => {
  vi.useFakeTimers();
  realUrbitFixture.config = {
    channels: {
      tlon: {
        code: "code",
        ship: "~zod",
        url: realUrbitFixture.url,
        autoAcceptGroupInvites: true,
        groupInviteAllowlist: ["~bus"],
      },
    },
  };
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({});
  const started = Promise.withResolvers<void>();
  ingressMock.start.mockImplementationOnce(() => started.resolve());
  const controller = new AbortController();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  const monitor = monitorTlonProvider({
    scheduler: createTestPluginServiceScheduler(),
    abortSignal: controller.signal,
    runtime,
  });
  try {
    await Promise.race([started.promise, monitor]);
    const subscription = sseClientMock.subscribe.mock.calls
      .map(([value]) => value)
      .find((value) => value.app === "groups" && value.path === "/v1/foreigns");
    expect(subscription).toBeDefined();
    sseClientMock.poke.mockClear();
    const active = { invites: [{ valid: true, from: "~bus" }] };
    const unrelated = { "~bus/unrelated": active };
    await subscription!.event(unrelated);
    const expectedJoins = ["~bus/unrelated"];
    for (const [state, terminal] of [
      ["revoked", { invites: [{ valid: false, from: "~bus" }] }],
      ["removed", { invites: [] }],
      ["done", { ...active, progress: "done" }],
    ] as const) {
      const groupFlag = `~bus/${state}`;
      const invite = { [groupFlag]: active };
      await subscription!.event(invite);
      expectedJoins.push(groupFlag);
      await subscription!.event(unrelated);
      await subscription!.event(invite);
      await subscription!.event({ [groupFlag]: terminal });
      await subscription!.event(unrelated);
      await subscription!.event(invite);
      expectedJoins.push(groupFlag);
      expect(sseClientMock.poke.mock.calls.map(([call]) => call.json.flag)).toEqual(expectedJoins);
    }
    await subscription!.event({ "~nec/blocked": { invites: [{ valid: true, from: "~nec" }] } });
    expect(sseClientMock.poke.mock.calls).toEqual(
      expectedJoins.map((flag) => [
        { app: "groups", mark: "group-join", json: { flag, "join-all": true } },
      ]),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await monitor;
  }
});

function configureTlon(config: Record<string, unknown>) {
  realUrbitFixture.config = {
    channels: { tlon: { code: "code", ship: "~zod", url: realUrbitFixture.url, ...config } },
  };
}
function getSubscription(app: string, path?: string) {
  const subscription = sseClientMock.subscribe.mock.calls
    .map(([value]) => value)
    .find((value) => value.app === app && (!path || value.path === path));
  if (!subscription) {
    throw new Error("expected " + app + " subscription");
  }
  return subscription;
}
function messageEssay(author: string, text: string | unknown[]) {
  return {
    author,
    content: typeof text === "string" ? [{ inline: [text] }] : text,
    sent: 1_700_000_000_000,
  };
}
async function runMonitor(run: () => Promise<void>) {
  sseClientMock.subscribe.mockClear();
  vi.useFakeTimers();
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({});
  ingressMock.receive.mockResolvedValue({ kind: "ignored" });
  const started = Promise.withResolvers<void>();
  ingressMock.start.mockImplementationOnce(() => started.resolve());
  const controller = new AbortController();
  const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() } satisfies RuntimeEnv;
  const monitor = monitorTlonProvider({
    scheduler: createTestPluginServiceScheduler(),
    abortSignal: controller.signal,
    runtime,
  });
  try {
    await Promise.race([started.promise, monitor]);
    await run();
  } finally {
    controller.abort();
    await monitor;
  }
}

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
