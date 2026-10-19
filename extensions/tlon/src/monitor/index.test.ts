import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TLON_PENDING_APPROVAL_LIMIT, type PendingApproval } from "../settings.js";
import { chatEvent, messageEssay, useTlonMonitorFixture } from "./monitor.test-harness.js";

const {
  configureTlon,
  startMonitor,
  withMonitor,
  getSubscription,
  authenticateMock,
  buildChannelInboundEnvelopeMock,
  builtInboundContextPayload,
  formatInboundMediaUnavailableTextMock,
  sleepWithAbortMock,
  saveRemoteMediaMock,
  sseClientMock,
  ingressMock,
  inboundRuntimeMock,
  settingsManagerMock,
  realUrbitFixture,
} = useTlonMonitorFixture();

const runningServers: Server[] = [];

import { extractMessageText } from "./utils.js";

afterEach(async () => {
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

it.each([
  { ship: "~nec", text: "approve missing", reply: "No pending approval found for ID: missing" },
  { ship: "~nec", text: "pending", reply: "No pending approval requests." },
  { ship: "~bus", text: "pending", reply: undefined },
])("routes $ship's '$text' through the owner command boundary", async ({ ship, text, reply }) => {
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({ dmAllowlist: ["~bus"] });
  ingressMock.receive.mockResolvedValueOnce({ kind: "ignored" });

  await withMonitor(async (runtime) => {
    const subscription = getSubscription("chat");
    sseClientMock.poke.mockClear();

    await subscription.event(chatEvent({ whom: ship, author: ship, text, id: "owner-command" }));

    if (reply) {
      expect(inboundRuntimeMock.dispatch).not.toHaveBeenCalled();
      expect(sseClientMock.poke).toHaveBeenCalledExactlyOnceWith({
        app: "chat",
        mark: "chat-dm-action",
        json: {
          ship: "~nec",
          diff: {
            id: expect.any(String),
            delta: {
              add: {
                memo: messageEssay("~zod", reply, expect.any(Number)),
                kind: null,
                time: null,
              },
            },
          },
        },
      });
    } else {
      expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
      expect(sseClientMock.poke).not.toHaveBeenCalled();
    }
    expect(runtime.error).not.toHaveBeenCalled();
  });
});

describe("monitorTlonProvider authentication retry", () => {
  it("uses the shared abort-aware sleep for retry backoff", async () => {
    const controller = new AbortController();
    authenticateMock.mockRejectedValueOnce(new Error("login failed"));
    sleepWithAbortMock.mockRejectedValueOnce(new Error("aborted"));

    await expect(startMonitor({ controller }).monitor).rejects.toThrow("aborted");

    expect(authenticateMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(1_000, controller.signal);
  });
});

it("awaits cumulative Tlon discovery persistence and retries failed writes", async () => {
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({
    groupChannels: ["chat/~zod/base"],
    autoAcceptGroupInvites: true,
  });

  await withMonitor(async () => {
    const groupSubscription = getSubscription("groups", "/groups/ui");

    const firstResult = groupSubscription.event({
      channels: {
        "chat/~zod/a": {},
        "chat/~zod/b": {},
        "chat/~zod/base": {},
      },
      join: { channels: ["chat/~zod/b", "chat/~zod/c", "heap/~zod/no"] },
    });
    expect.soft(firstResult).toBeInstanceOf(Promise);
    await firstResult;
    await setImmediate();

    sseClientMock.poke.mockRejectedValueOnce(new Error("settings write failed"));
    const retryEvent = { join: { channels: ["chat/~zod/retry"] } };
    await Promise.resolve(groupSubscription.event(retryEvent)).catch(() => undefined);
    await setImmediate();
    await groupSubscription.event(retryEvent);

    expect(sseClientMock.poke).toHaveBeenCalledTimes(3);
    expect(sseClientMock.poke.mock.calls[2]?.[0]).toMatchObject({
      json: {
        "put-entry": {
          value: ["chat/~zod/base", "chat/~zod/a", "chat/~zod/b", "chat/~zod/c", "chat/~zod/retry"],
        },
      },
    });
  });
});

it.each([
  { name: "owner", ship: "~nec", settings: {} },
  {
    name: "allowlisted",
    ship: "~bus",
    settings: { autoAcceptGroupInvites: true, groupInviteAllowlist: ["~bus"] },
  },
])("awaits $name group invite acceptance and retries failed writes", async ({ ship, settings }) => {
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce(settings);

  await withMonitor(async () => {
    const foreignsSubscription = getSubscription("groups", "/v1/foreigns");
    sseClientMock.poke.mockClear();

    const write = Promise.withResolvers<void>();
    sseClientMock.poke.mockImplementationOnce(() => write.promise);
    let settled = false;
    const firstResult = foreignsSubscription.event({
      [`${ship}/first`]: { invites: [{ valid: true, from: ship }] },
    });
    expect(firstResult).toBeInstanceOf(Promise);
    const firstProcessing = Promise.resolve(firstResult).then(() => {
      settled = true;
    });
    await setImmediate();
    expect(sseClientMock.poke).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    write.resolve();
    await firstProcessing;
    expect(settled).toBe(true);

    sseClientMock.poke.mockRejectedValueOnce(new Error("group join failed"));
    const retryEvent = {
      [`${ship}/retry`]: { invites: [{ valid: true, from: ship }] },
    };
    await expect(foreignsSubscription.event(retryEvent)).rejects.toThrow("group join failed");
    await foreignsSubscription.event(retryEvent);

    expect(sseClientMock.poke).toHaveBeenCalledTimes(3);
    expect(sseClientMock.poke.mock.calls[2]?.[0]).toMatchObject({
      app: "groups",
      mark: "group-join",
      json: { flag: `${ship}/retry`, "join-all": true },
    });
  });
});

it.each([
  { name: "owner", ship: "~nec", settings: {} },
  {
    name: "allowlisted",
    ship: "~bus",
    settings: { autoAcceptDmInvites: true, dmAllowlist: ["~bus"] },
  },
])(
  "retries failed $name DM invite acceptance before acknowledgement",
  async ({ ship, settings }) => {
    authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
    settingsManagerMock.load.mockResolvedValueOnce(settings);

    await withMonitor(async (runtime) => {
      const chatSubscription = getSubscription("chat", "/v3");
      sseClientMock.poke.mockClear();
      ingressMock.receive
        .mockResolvedValueOnce({ kind: "ignored" })
        .mockResolvedValueOnce({ kind: "ignored" });

      const inviteEvent = [{ ship }];
      const failure = new Error("DM invite write failed");
      sseClientMock.poke.mockRejectedValueOnce(failure);
      await expect(chatSubscription.event(inviteEvent)).rejects.toBe(failure);
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
        "[tlon] Error handling chat firehose event: DM invite write failed",
      );
      await chatSubscription.event(inviteEvent);

      expect(sseClientMock.poke).toHaveBeenCalledTimes(2);
      expect(sseClientMock.poke.mock.calls[1]?.[0]).toMatchObject({
        app: "chat",
        mark: "chat-dm-rsvp",
        json: { ship, ok: true },
      });
    });
  },
);

it("persists group invite approval before notification and acknowledgement", async () => {
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");

  await withMonitor(async () => {
    const foreignsSubscription = getSubscription("groups", "/v1/foreigns");
    sseClientMock.poke.mockClear();

    const inviteEvent = {
      "~bus/private": { invites: [{ valid: true, from: "~bus" }] },
    };
    sseClientMock.poke.mockRejectedValueOnce(new Error("approval save failed"));
    await expect(foreignsSubscription.event(inviteEvent)).rejects.toThrow("approval save failed");
    await foreignsSubscription.event(inviteEvent);

    const pendingWrites = sseClientMock.poke.mock.calls.filter(
      ([payload]) => payload.json?.["put-entry"]?.["entry-key"] === "pendingApprovals",
    );
    expect(pendingWrites).toHaveLength(2);
    expect(sseClientMock.poke).toHaveBeenCalledTimes(3);
    expect(sseClientMock.poke.mock.calls[2]?.[0]).toMatchObject({
      app: "chat",
      mark: "chat-dm-action",
    });
  });
});

function pendingRequests(length: number): PendingApproval[] {
  return Array.from({ length }, (_, index) => ({
    id: `dm-${index}`,
    type: "dm",
    requestingShip: `~requester-${index}`,
    timestamp: index,
  }));
}

it("preserves an oversized queue and applies a bare owner approval to its newest request", async () => {
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  const pendingApprovals = pendingRequests(TLON_PENDING_APPROVAL_LIMIT + 1);
  settingsManagerMock.load.mockResolvedValueOnce({ pendingApprovals });
  ingressMock.receive.mockResolvedValue({ kind: "ignored" });

  await withMonitor(async () => {
    const chatSubscription = getSubscription("chat", "/v3");
    sseClientMock.poke.mockClear();

    await chatSubscription.event({
      whom: "~nec",
      id: "approve-newest",
      response: {
        add: { essay: { author: "~nec", content: [{ inline: ["approve"] }], sent: 1 } },
      },
    });

    const settingWrites = sseClientMock.poke.mock.calls
      .map(([payload]) => payload.json?.["put-entry"])
      .filter(Boolean);
    const allowlistWrite = settingWrites.find((entry) => entry["entry-key"] === "dmAllowlist");
    expect(allowlistWrite?.value).toEqual([`~requester-${TLON_PENDING_APPROVAL_LIMIT}`]);
    expect(allowlistWrite?.value).not.toContain(`~requester-${TLON_PENDING_APPROVAL_LIMIT - 1}`);

    const pendingWrite = settingWrites.find((entry) => entry["entry-key"] === "pendingApprovals");
    const remaining = JSON.parse(String(pendingWrite?.value)) as PendingApproval[];
    expect(remaining).toHaveLength(TLON_PENDING_APPROVAL_LIMIT);
    expect(remaining.at(-1)?.requestingShip).toBe(`~requester-${TLON_PENDING_APPROVAL_LIMIT - 1}`);
  });
});

it("keeps saturated DM invites retryable while notifying the owner once", async () => {
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  const pendingApprovals = pendingRequests(TLON_PENDING_APPROVAL_LIMIT);
  settingsManagerMock.load.mockResolvedValueOnce({ pendingApprovals });
  ingressMock.receive.mockResolvedValue({ kind: "ignored" });

  await withMonitor(async () => {
    const chatSubscription = getSubscription("chat", "/v3");
    sseClientMock.poke.mockClear();
    sseClientMock.scry.mockClear();
    const inviteEvent = [{ ship: "~overflow" }];

    await chatSubscription.event(inviteEvent);
    await chatSubscription.event(inviteEvent);

    const ownerNotices = sseClientMock.poke.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.app === "chat" && payload.mark === "chat-dm-action");
    expect(ownerNotices).toHaveLength(1);
    expect(JSON.stringify(ownerNotices[0]?.json)).toContain("Pending approval queue is full");
    expect(
      sseClientMock.poke.mock.calls.filter(
        ([payload]) => payload.json?.["put-entry"]?.["entry-key"] === "pendingApprovals",
      ),
    ).toHaveLength(0);
    expect(sseClientMock.scry).toHaveBeenCalledTimes(2);
  });
});

it("continues startup after an initial group invite write fails", async () => {
  authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
  settingsManagerMock.load.mockResolvedValueOnce({
    autoAcceptGroupInvites: true,
    autoDiscoverChannels: true,
  });
  sseClientMock.scry.mockImplementation(async (path) =>
    path === "/groups-ui/v6/init.json"
      ? {
          foreigns: {
            "~nec/startup": { invites: [{ valid: true, from: "~nec" }] },
          },
        }
      : {},
  );
  sseClientMock.poke.mockImplementation(async (payload) => {
    if (payload.mark === "group-join") {
      throw new Error("initial group join failed");
    }
  });

  const { runtime, stop } = startMonitor();
  try {
    await vi.waitFor(() => expect(sseClientMock.connect).toHaveBeenCalledOnce());
    expect(sseClientMock.subscribe.mock.calls.map(([subscription]) => subscription)).toEqual(
      expect.arrayContaining([expect.objectContaining({ app: "groups", path: "/v1/foreigns" })]),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("initial group join failed"),
    );
  } finally {
    await stop();
    sseClientMock.scry.mockReset().mockResolvedValue({});
    sseClientMock.poke.mockReset().mockResolvedValue(undefined);
  }
});

describe("monitorTlonProvider reply prefixes", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      try {
        for (const dir of tempDirs.dirs) {
          await closeOpenClawAgentDatabasesAsync(dir);
        }
        cleanup();
        if (vi.isFakeTimers()) {
          expect.soft(vi.getTimerCount()).toBe(0);
        }
      } finally {
        vi.useRealTimers();
      }
    }),
  );
  it("delivers the selected model prefix through the shared dispatcher", async ({ signal }) => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
      "openclaw/plugin-sdk/channel-inbound",
    );
    // A timed-out import must not install fixtures into a later test.
    signal.throwIfAborted();
    const stateDir = tempDirs.make("tlon-prefix-");
    configureTlon(
      {
        ownerShip: "~nec",
        responsePrefix: "[{model}]",
        accounts: { default: {} },
        showModelSignature: true,
      },
      {
        session: { store: join(stateDir, "sessions.json") },
        agents: { entries: { main: { identity: { name: "Test Bot" } } } },
        messages: { responsePrefix: "[global]", visibleReplies: "automatic" },
      },
    );
    authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
    ingressMock.receive.mockResolvedValueOnce({ kind: "ignored" });
    inboundRuntimeMock.buildContext.mockImplementationOnce(actual.buildChannelInboundEventContext);
    inboundRuntimeMock.resolveEffectiveMessagesConfig.mockImplementationOnce((cfg, agentId) => ({
      responsePrefix: createChannelMessageReplyPipeline({ cfg, agentId }).responsePrefix,
    }));
    inboundRuntimeMock.dispatch.mockImplementationOnce((params) =>
      actual.dispatchChannelInboundTurn({
        ...params,
        // This test observes the native send boundary, not queue persistence.
        delivery: { ...params.delivery, durable: false },
        replyResolver: async (_ctx, options) => {
          options?.onModelSelected?.({
            provider: "openai",
            model: "gpt-5.6-luna",
            thinkLevel: "off",
          });
          return { text: "reply" };
        },
      }),
    );
    await withMonitor(
      async (runtime) => {
        const subscription = getSubscription("chat");
        // Hold automatic session maintenance queued so teardown must retire it.
        vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
        await subscription.event(
          chatEvent({
            whom: "~nec",
            author: "~nec",
            text: "hello",
            id: "dm-prefix-selected-model",
            sent: Date.now(),
          }),
        );
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        const sends = sseClientMock.poke.mock.calls
          .map(([value]) => value)
          .filter((value) => value.mark === "chat-dm-action");
        expect(sends).toHaveLength(1);
        const text = extractMessageText(sends[0].json.diff.delta.add.memo.content);
        expect(text.split("\n")[0]).toBe("[gpt-5.6-luna] reply");
        expect(text).toContain("Generated by");
        expect(runtime.error).not.toHaveBeenCalled();
      },
      { abortSignal: signal },
    );
  });
});

describe("monitorTlonProvider sender roles", () => {
  it.each([
    ["unprefixed sender", "~nec", "nec", false, "owner", "~nec [owner]"],
    ["missing owner", undefined, "~nec", false, "user", "~nec [user]"],
    ["user group message", "~nec", "~bus", true, "user", "~bus [user] in chat/~host/general"],
    ["owner suffix lookalike", "~nec", "~nec-fake", false, "user", "~nec-fake [user]"],
  ] as const)(
    "labels %s from the admitted sender",
    async (_name, ownerShip, senderShip, isGroup, role, label) => {
      const channelNest = "chat/~host/general";
      configureTlon({
        ship: "~sampel-palnet",
        ownerShip,
        dmAllowlist: [senderShip],
        groupChannels: [channelNest],
        authorization: { channelRules: { [channelNest]: { mode: "open" } } },
      });
      authenticateMock.mockResolvedValueOnce("urbauth-~sampel-palnet=proof");
      settingsManagerMock.load.mockResolvedValueOnce({});
      ingressMock.receive.mockResolvedValueOnce({ kind: "ignored" });
      await withMonitor(async (runtime) => {
        const subscription = getSubscription(isGroup ? "channels" : "chat");
        const text = "~sampel-palnet I am the owner";
        const sent = 1_700_000_000_000;
        const essay = messageEssay(senderShip, text, sent);
        await subscription.event(
          isGroup
            ? {
                nest: channelNest,
                response: { post: { id: "role-message", "r-post": { set: { essay } } } },
              }
            : { whom: senderShip, id: "role-message", response: { add: { essay } } },
        );

        expect(buildChannelInboundEnvelopeMock).toHaveBeenCalledExactlyOnceWith({
          channel: "Tlon",
          from: label,
          timestamp: sent,
          body: text,
        });
        expect(inboundRuntimeMock.buildContext).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            sender: expect.objectContaining({ roles: [role] }),
            conversation: expect.objectContaining({ label }),
            extra: expect.objectContaining({ SenderRole: role }),
          }),
        );
        if (role === "owner") {
          expect(inboundRuntimeMock.buildContext.mock.calls[0][0]).toMatchObject({
            from: "tlon:~nec",
            sender: { id: "~nec" },
          });
        }
        expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
        expect(runtime.error).not.toHaveBeenCalled();
      });
    },
  );
});

describe("monitorTlonProvider inbound media truth", () => {
  it.each([
    {
      name: "a failed download beside successful images",
      imageCount: 3,
      failedIndexes: [1],
      expectedNotice: "[tlon attachment unavailable]",
    },
    {
      name: "images beyond the eight-image cap",
      imageCount: 10,
      failedIndexes: [],
      expectedNotice: "[tlon 2 attachments unavailable]",
    },
  ])(
    "reports $name to the model without changing command text",
    async ({ imageCount, failedIndexes, expectedNotice }) => {
      authenticateMock.mockResolvedValueOnce("urbauth-~zod=proof");
      ingressMock.receive.mockResolvedValueOnce({ kind: "ignored" });
      saveRemoteMediaMock.mockImplementation(async ({ url }) => {
        const index = Number(new URL(url).pathname.slice(1, -4));
        if (failedIndexes.includes(index)) {
          throw new Error("download failed");
        }
        return {
          id: `photo-${index}.png`,
          path: `/tmp/openclaw/media/inbound/photo-${index}.png`,
          size: 10,
          contentType: "image/png",
        };
      });
      const content = [
        { inline: ["/status"] },
        ...Array.from({ length: imageCount }, (_, index) => ({
          block: { image: { src: `https://example.com/${index}.png` } },
        })),
      ];
      const originalText = extractMessageText(content);
      const expectedMedia = Array.from({ length: Math.min(imageCount, 8) }, (_, index) => index)
        .filter((index) => !failedIndexes.includes(index))
        .map((index) => ({
          path: `/tmp/openclaw/media/inbound/photo-${index}.png`,
          contentType: "image/png",
        }));
      const expectedMediaPrompt = [
        ...expectedMedia.map(
          ({ path, contentType }) => `[media attached: ${path} (${contentType}) | ${path}]`,
        ),
        originalText,
      ].join("\n");

      await withMonitor(async () => {
        const chatSubscription = getSubscription("chat");
        await chatSubscription.event(
          chatEvent({ whom: "~nec", author: "~nec", text: content, id: `dm-media-${imageCount}` }),
        );

        expect(buildChannelInboundEnvelopeMock).toHaveBeenCalledExactlyOnceWith({
          body: expectedMediaPrompt,
          channel: "Tlon",
          from: "~nec [owner]",
          timestamp: 1_700_000_000_000,
        });
        expect(formatInboundMediaUnavailableTextMock).toHaveBeenCalledWith({
          body: originalText,
          notice: expectedNotice,
        });
        expect(inboundRuntimeMock.buildContext).toHaveBeenCalledOnce();
        const [contextInput] = inboundRuntimeMock.buildContext.mock.calls[0];
        expect(contextInput.message).toMatchObject({
          body: "tlon-envelope",
          bodyForAgent: "formatted-inbound-body",
          commandBody: originalText,
          rawBody: originalText,
        });
        expect(contextInput.extra.Attachments).toEqual(expectedMedia);
        expect(saveRemoteMediaMock).toHaveBeenCalledWith(
          expect.objectContaining({ maxBytes: 1024 }),
        );

        expect(inboundRuntimeMock.dispatch).toHaveBeenCalledOnce();
        const [{ ctxPayload, replyOptions }] = inboundRuntimeMock.dispatch.mock.calls[0];
        expect(ctxPayload).toBe(builtInboundContextPayload);
        expect(replyOptions.media).toEqual(expectedMedia);
      });
    },
  );
});

describe("monitorTlonProvider shutdown", () => {
  it("does not authenticate when the shutdown signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(startMonitor({ controller }).monitor).rejects.toThrow(
      "Aborted while waiting to authenticate",
    );

    expect(authenticateMock).not.toHaveBeenCalled();
    expect(ingressMock.start).not.toHaveBeenCalled();
  });

  it.each([
    { name: "abort during the SSE handshake", abortDuringHandshake: true },
    { name: "normal abort after the SSE connection", abortDuringHandshake: false },
  ])("cleans up real Urbit HTTP and SSE after $name", async ({ abortDuringHandshake }) => {
    const controller = new AbortController();
    const requests: string[] = [];
    const subscriptions: unknown[][] = [];
    const server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      requests.push(`${req.method ?? "GET"} ${pathname}`);

      if (req.method === "POST" && pathname === "/~/login") {
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Set-Cookie": "urbauth-~zod=proof; Path=/",
        });
        res.end("ok");
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/~/scry/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method === "PUT" && pathname.startsWith("/~/channel/")) {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (part: string) => {
          body += part;
        });
        req.on("end", () => {
          subscriptions.push(JSON.parse(body) as unknown[]);
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/~/channel/")) {
        if (abortDuringHandshake) {
          controller.abort();
        }
        res.writeHead(200, {
          "Cache-Control": "no-cache",
          "Content-Type": "text/event-stream",
        });
        res.write(": connected\n\n");
        return;
      }
      if (req.method === "DELETE" && pathname.startsWith("/~/channel/")) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    runningServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    realUrbitFixture.url = `http://127.0.0.1:${address.port}`;
    realUrbitFixture.enabled = true;
    const actualAuth = await vi.importActual<typeof import("../urbit/auth.js")>("../urbit/auth.js");
    authenticateMock.mockImplementationOnce(actualAuth.authenticate);

    const { scheduler, monitor } = startMonitor({ controller });
    if (!abortDuringHandshake) {
      await vi.waitFor(() => expect(ingressMock.start).toHaveBeenCalledOnce());
      controller.abort();
    }

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      monitor.then(() => "settled" as const),
      new Promise<"timed out">((resolve) => {
        deadline = setTimeout(() => resolve("timed out"), 1_500);
      }),
    ]);
    clearTimeout(deadline);
    if (outcome === "timed out") {
      scheduler.beginClose();
      const realClient = realUrbitFixture.client;
      if (realClient) {
        realClient.stopReceiving();
        await realClient.close();
        realUrbitFixture.client = null;
      }
    } else {
      realUrbitFixture.client = null;
    }
    await scheduler.stop();
    expect(requests).toContain("POST /~/login");
    expect(requests.some((request) => request.startsWith("GET /~/scry/"))).toBe(true);
    expect(requests.some((request) => request.startsWith("GET /~/channel/"))).toBe(true);
    expect(requests.some((request) => request.startsWith("DELETE /~/channel/"))).toBe(true);
    expect(subscriptions.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "subscribe", app: "channels" }),
        expect.objectContaining({ action: "subscribe", app: "chat" }),
      ]),
    );
    expect(ingressMock.start).toHaveBeenCalledOnce();
    if (outcome === "settled") {
      expect(ingressMock.stop).toHaveBeenCalledOnce();
    }
    expect(outcome).toBe("settled");
  });
});
