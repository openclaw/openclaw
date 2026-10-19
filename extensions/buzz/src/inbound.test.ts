import { runPreparedInboundReply } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { beforeEach, expect, it, vi } from "vitest";
import type { BuzzBus } from "./buzz-bus.js";
import { BuzzDirectoryState } from "./directory-state.js";
import { handleBuzzInbound as handleBuzzInboundWithHistory } from "./inbound.js";
import {
  BUZZ_DIFF_MESSAGE_KIND,
  BUZZ_NORMAL_MESSAGE_KIND,
  type BuzzInboundMessage,
} from "./message-event.js";
import { setBuzzRuntime } from "./runtime.js";
import type { ResolvedBuzzAccount } from "./types.js";

const logInfo = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      info: logInfo,
    }),
  };
});

const ROOM_ID = "b25b8e40-eb1a-43a4-b56b-30a4e16df586";
const BOT_PUBLIC_KEY = "a".repeat(64);
const SENDER_PUBLIC_KEY = "b".repeat(64);
const OTHER_PUBLIC_KEY = "c".repeat(64);

function receive(
  message: Partial<BuzzInboundMessage>,
  params: Partial<Parameters<typeof handleBuzzInboundWithHistory>[0]> = {},
) {
  return handleBuzzInboundWithHistory({
    account: params.account ?? createAccount(),
    cfg: params.cfg ?? {},
    bus: params.bus ?? createBus(),
    ...createLifecycle(),
    ...params,
    historyMap: params.historyMap ?? new Map(),
    message: createMessage(message),
  });
}

function createAccount(
  configOverrides: Partial<ResolvedBuzzAccount["config"]> = {},
): ResolvedBuzzAccount {
  return {
    accountId: "default",
    name: "OpenClaw",
    enabled: true,
    configured: true,
    relayUrl: "ws://127.0.0.1:3000",
    privateKey: "1".repeat(64),
    authTag: "",
    publicKey: BOT_PUBLIC_KEY,
    config: {
      groupPolicy: "open",
      groups: { [ROOM_ID]: { requireMention: true } },
      ...configOverrides,
    },
  };
}

function createMessage(overrides: Partial<BuzzInboundMessage> = {}): BuzzInboundMessage {
  return {
    id: "event-1",
    kind: BUZZ_NORMAL_MESSAGE_KIND,
    senderPubkey: SENDER_PUBLIC_KEY,
    text: "hello",
    channelId: ROOM_ID,
    createdAt: 1_777_000_000,
    mentionedPubkeys: [],
    ...overrides,
  };
}

function createLifecycle() {
  const signal = new AbortController().signal;
  return { signal, assertCurrent: () => signal.throwIfAborted() };
}

function createBus(): BuzzBus {
  return {
    publicKey: BOT_PUBLIC_KEY,
    directory: new BuzzDirectoryState({
      publicKey: BOT_PUBLIC_KEY,
      fallbackProfileName: "OpenClaw",
      channelIds: [ROOM_ID],
    }),
    refreshDirectory: vi.fn(async () => {}),
    isBotOwnedThread: vi.fn(async () => false),
    sendText: vi.fn(async () => "reply-event-1"),
    sendTyping: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function firstDispatch(
  runtime: ReturnType<typeof createPluginRuntimeMock>,
): Parameters<typeof runtime.channel.inbound.dispatch>[0] {
  const call = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0];
  if (!call) {
    throw new Error("expected Buzz inbound dispatch");
  }
  return call[0];
}

let runtime: ReturnType<typeof createPluginRuntimeMock>;

function createPreparedInboundRuntime() {
  const runDispatch = vi.fn(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 1 },
  }));
  const recordInboundSession = vi.fn(async () => undefined);
  vi.mocked(runtime.channel.inbound.dispatch).mockImplementation(async (params) =>
    runPreparedInboundReply({
      ...params,
      routeSessionKey: params.route.sessionKey,
      storePath: "/unused/buzz-bot-loop",
      recordInboundSession,
      runDispatch,
    }),
  );
  return { runDispatch, recordInboundSession };
}

function setMembership(
  bus: BuzzBus,
  members: string[],
  roles = new Map<string, string>(),
  revision = { createdAt: 1_777_000_000, eventId: "membership-history" },
) {
  const membership = {
    roomId: ROOM_ID,
    publisherPublicKey: OTHER_PUBLIC_KEY,
    members: new Set(members),
    roles,
    ...revision,
  };
  bus.directory.replaceMemberships(new Map([[ROOM_ID, membership]]));
}

function createHistoryParams(historyLimit = 2, roles = new Map<string, string>()) {
  const bus = createBus();
  setMembership(bus, [BOT_PUBLIC_KEY, SENDER_PUBLIC_KEY, OTHER_PUBLIC_KEY], roles);
  const params = {
    account: createAccount({ historyLimit }),
    cfg: {} satisfies OpenClawConfig,
    bus,
    ...createLifecycle(),
    historyMap: new Map<string, HistoryEntry[]>(),
  };
  return Object.assign(params, {
    receive: (message: Partial<BuzzInboundMessage>) => receive(message, params),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime = createPluginRuntimeMock();
  setBuzzRuntime(runtime);
});

it.each(["denied", "revoked", "other-thread"])(
  "excludes passive context for %s",
  async (scenario) => {
    const params = createHistoryParams();
    if (scenario === "denied") {
      params.account.config.groupPolicy = "allowlist";
      params.account.config.groupAllowFrom = [OTHER_PUBLIC_KEY];
    }
    await params.receive({ text: "Private context" });
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    if (scenario === "revoked") {
      setMembership(params.bus, [BOT_PUBLIC_KEY, OTHER_PUBLIC_KEY], new Map(), {
        createdAt: 1_777_000_001,
        eventId: "membership-revoked",
      });
    }
    await params.receive({
      id: "trigger",
      senderPubkey: OTHER_PUBLIC_KEY,
      text: "Current question",
      threadId: scenario === "other-thread" ? "separate-thread" : undefined,
      mentionedPubkeys: [BOT_PUBLIC_KEY],
    });
    expect(firstDispatch(runtime).ctxPayload.BodyForAgent).toBe("Current question");
  },
);

it("bounds stored UTF-8 entries and rendered context independently", async () => {
  const params = createHistoryParams(20);
  for (let index = 0; index < 25; index++) {
    await params.receive({
      id: `passive-${index}`,
      text: `message-${index} ${"界🦞".repeat(150)}`,
    });
  }
  const stored = [...params.historyMap.values()].flat();
  expect(stored).toHaveLength(20);
  expect(stored.every((entry) => Buffer.byteLength(entry.body) <= 512)).toBe(true);
  expect(stored.every((entry) => !entry.body.includes("�"))).toBe(true);
  await params.receive({ id: "trigger", text: "current", mentionedPubkeys: [BOT_PUBLIC_KEY] });
  const body = firstDispatch(runtime).ctxPayload.BodyForAgent ?? "";
  expect(body).toContain("message-24");
  expect(body).not.toContain("message-5");
  expect(Buffer.byteLength(body) - Buffer.byteLength("current")).toBeLessThanOrEqual(1_024);
  expect(firstDispatch(runtime).ctxPayload.InboundHistory).toBeUndefined();
});

it("preserves passive arrivals while an earlier reply is in flight", async () => {
  const params = createHistoryParams();
  const finished = createDeferred<void>();
  const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
  const original = dispatch.getMockImplementation();
  if (!original) {
    throw new Error("expected shared inbound dispatch implementation");
  }
  dispatch.mockImplementationOnce(async (plan) => {
    await finished.promise;
    return original(plan);
  });
  await params.receive({ text: "earlier context" });
  const reply = params.receive({
    id: "trigger",
    text: "first",
    mentionedPubkeys: [BOT_PUBLIC_KEY],
  });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  await params.receive({ id: "later", text: "arrived during reply" });
  finished.resolve();
  await reply;
  await params.receive({
    id: "next-trigger",
    text: "next",
    mentionedPubkeys: [BOT_PUBLIC_KEY],
  });
  const nextBody = dispatch.mock.calls[1]?.[0].ctxPayload.BodyForAgent;
  expect(nextBody).toContain("arrived during reply");
  expect(nextBody).not.toContain("earlier context");
});

it("retains human context across a loop-suppressed bot turn until a human dispatch", async () => {
  const { runDispatch, recordInboundSession } = createPreparedInboundRuntime();
  const params = createHistoryParams(2, new Map([[SENDER_PUBLIC_KEY, "bot"]]));
  params.account.relayUrl = "wss://passive-bot-loop.example.test/";
  const cfg = {
    channels: {
      defaults: {
        botLoopProtection: {
          enabled: true,
          maxEventsPerWindow: 1,
          windowSeconds: 60,
          cooldownSeconds: 60,
        },
      },
    },
  } satisfies OpenClawConfig;
  params.cfg = cfg;
  await params.receive({ id: "bot-seed", mentionedPubkeys: [BOT_PUBLIC_KEY] });
  await params.receive({
    id: "human-context",
    senderPubkey: OTHER_PUBLIC_KEY,
    text: "Keep this human context.",
  });
  params.account.relayUrl = "wss://PASSIVE-BOT-LOOP.EXAMPLE.TEST:443/";
  await params.receive({ id: "bot-suppressed", mentionedPubkeys: [BOT_PUBLIC_KEY] });
  expect(runDispatch).toHaveBeenCalledTimes(1);
  expect(recordInboundSession).toHaveBeenCalledTimes(1);
  const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
  await expect(dispatch.mock.results[1]?.value).resolves.toMatchObject({
    admission: { kind: "drop", reason: "bot-loop-protection" },
    dispatched: false,
  });
  await params.receive({
    id: "human-accepted",
    senderPubkey: OTHER_PUBLIC_KEY,
    text: "Which context?",
    mentionedPubkeys: [BOT_PUBLIC_KEY],
  });
  expect(runDispatch).toHaveBeenCalledTimes(2);
  expect(recordInboundSession).toHaveBeenCalledTimes(2);
  expect(dispatch.mock.calls[2]?.[0].ctxPayload.BodyForAgent).toContain("Keep this human context.");
  expect(params.historyMap.size).toBe(0);
});

it.each(["off", "all"] as const)("routes replies and typing with replyToMode=%s", async (mode) => {
  const bus = createBus();
  await receive(
    { id: "event-reply", threadId: "event-root", mentionedPubkeys: [BOT_PUBLIC_KEY] },
    {
      bus,
      account: createAccount({ replyToMode: mode }),
    },
  );
  const dispatch = firstDispatch(runtime);
  expect(dispatch.ctxPayload).toMatchObject({
    MessageSid: "event-reply",
    MessageThreadId: "event-root",
    ReplyToId: "event-reply",
    ThreadParentId: ROOM_ID,
  });
  await dispatch.delivery.deliver({ text: "  " }, { kind: "final" });
  expect(bus.sendText).not.toHaveBeenCalled();
  const target = {
    channelId: ROOM_ID,
    threadId: mode === "off" ? undefined : "event-root",
    replyToId: mode === "off" ? undefined : "event-root",
  };
  await dispatch.delivery.deliver({ text: "threaded reply to @Alice" }, { kind: "final" });
  expect(bus.sendText).toHaveBeenCalledWith({ ...target, text: "threaded reply to @Alice" });
  const typing = dispatch.replyPipeline?.typing;
  expect(typing?.keepaliveIntervalMs).toBe(3_000);
  await typing?.start();
  expect(bus.sendTyping).toHaveBeenCalledWith(target);
});

it("uses current Buzz labels without changing the stable sender identity", async () => {
  const bus = createBus();
  setMembership(
    bus,
    [BOT_PUBLIC_KEY, SENDER_PUBLIC_KEY],
    new Map([
      [BOT_PUBLIC_KEY, "bot"],
      [SENDER_PUBLIC_KEY, "member"],
    ]),
    { createdAt: 1_777_000_000, eventId: "membership-1" },
  );
  bus.directory.applyProfileEvent({
    id: "profile-1",
    kind: 0,
    pubkey: SENDER_PUBLIC_KEY,
    created_at: 1_777_000_000,
    content: JSON.stringify({ display_name: "Alice" }),
    sig: "e".repeat(128),
    tags: [],
  });
  bus.directory.applyRoomEvent({
    id: "room-1",
    kind: 39_000,
    pubkey: OTHER_PUBLIC_KEY,
    created_at: 1_777_000_000,
    content: "",
    sig: "e".repeat(128),
    tags: [
      ["d", ROOM_ID],
      ["name", "Engineering"],
    ],
  });

  await receive(
    {},
    {
      account: createAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: [SENDER_PUBLIC_KEY],
        groups: { [ROOM_ID]: { requireMention: false } },
      }),
      bus,
    },
  );

  expect(firstDispatch(runtime).ctxPayload).toMatchObject({
    SenderId: SENDER_PUBLIC_KEY,
    SenderName: "Alice",
    ChatId: ROOM_ID,
    NativeChannelId: ROOM_ID,
    GroupSubject: "Engineering",
  });
  expect(firstDispatch(runtime).ctxPayload.GroupChannel).toBeUndefined();
});

it("logs missing mentions once per account room with an account-scoped fix", async () => {
  const account = { ...createAccount(), accountId: "mention-diagnostic" };
  for (const id of ["mention-drop-1", "mention-drop-2"]) {
    await receive(
      { id },
      {
        account,
        cfg: { channels: { buzz: { accounts: { [account.accountId]: account.config } } } },
      },
    );
  }

  expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  expect(logInfo).toHaveBeenCalledOnce();
  expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("buzz: drop no mention"));
  expect(logInfo).toHaveBeenCalledWith(
    expect.stringContaining('channels.buzz.accounts["mention-diagnostic"].groups'),
  );
  expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("requireMention=false"));
  expect(logInfo).not.toHaveBeenCalledWith(expect.stringContaining(SENDER_PUBLIC_KEY));
});

it.each([
  ["membership", true, "admission"],
  ["shutdown", false, "admission"],
  ["membership", false, "thread ownership"],
  ["shutdown", false, "thread ownership"],
] as const)(
  "rechecks %s (mentioned: %s) after asynchronous %s",
  async (change, mentioned, boundary) => {
    const resolveIngress = runtime.channel.inbound.ingress.resolveStable;
    const abort = new AbortController();
    let currentMember = true;
    const waiting = createDeferred<void>();
    const admissionGate = createDeferred<void>();
    const bus = createBus();
    vi.mocked(bus.isBotOwnedThread).mockImplementationOnce(async () => {
      waiting.resolve();
      await admissionGate.promise;
      return true;
    });
    const resolveStable = vi.spyOn(runtime.channel.inbound.ingress, "resolveStable");
    resolveStable.mockImplementationOnce(async (params) => {
      const access = await resolveIngress(params);
      if (boundary === "admission") {
        waiting.resolve();
        await admissionGate.promise;
      }
      return access;
    });
    const params = {
      account: createAccount({
        groups: { [ROOM_ID]: { requireMentionInBotThreads: false } },
      }),
      bus,
      message: createMessage({
        mentionedPubkeys: mentioned ? [BOT_PUBLIC_KEY] : [],
        threadId: boundary === "thread ownership" ? "thread-root" : undefined,
      }),
      signal: abort.signal,
      assertCurrent: () => {
        abort.signal.throwIfAborted();
        if (!currentMember) {
          throw new Error("Buzz sender is no longer a room member");
        }
      },
    };
    const inbound = receive(params.message, params);
    await waiting.promise;
    if (change === "membership") {
      currentMember = false;
    } else {
      abort.abort(new Error("Buzz bus closed"));
    }
    admissionGate.resolve();

    await expect(inbound).rejects.toThrow(
      change === "membership" ? "no longer a room member" : "Buzz bus closed",
    );
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  },
);

it("drops mentioned room messages from senders outside the allowlist", async () => {
  await receive(
    { mentionedPubkeys: [BOT_PUBLIC_KEY] },
    {
      account: createAccount({
        groupPolicy: "allowlist",
        groupAllowFrom: [OTHER_PUBLIC_KEY],
      }),
    },
  );

  expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
});

it.each([
  [
    "restrict",
    "open",
    undefined,
    { groupPolicy: "allowlist", groupAllowFrom: [OTHER_PUBLIC_KEY] },
    false,
  ],
  ["open", "allowlist", [OTHER_PUBLIC_KEY], { groupPolicy: "open" }, true],
  ["override", "allowlist", [OTHER_PUBLIC_KEY], { groupAllowFrom: [SENDER_PUBLIC_KEY] }, true],
  ["empty", "allowlist", [SENDER_PUBLIC_KEY], { groupAllowFrom: [] }, false],
  ["inherit", "open", [SENDER_PUBLIC_KEY], { groupPolicy: "allowlist" }, true],
  ["disable", "open", undefined, { groupPolicy: "disabled" }, false],
] as const)("%s room policy", async (_name, accountPolicy, accountAllowFrom, room, dispatches) => {
  const group = { groupAllowFrom: undefined, ...room };
  await receive(
    {},
    {
      account: createAccount({
        groupPolicy: accountPolicy,
        groupAllowFrom: accountAllowFrom ? [...accountAllowFrom] : undefined,
        groups: {
          [ROOM_ID]: {
            requireMention: false,
            ...group,
            groupAllowFrom: group.groupAllowFrom ? [...group.groupAllowFrom] : undefined,
          },
        },
      }),
    },
  );

  expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(dispatches ? 1 : 0);
});

it.each([true, false])(
  "authorizes room control commands only when allowlisted: %s",
  async (authorized) => {
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    vi.mocked(runtime.channel.text.hasControlCommand).mockReturnValue(true);
    const account = authorized
      ? createAccount({
          groupPolicy: "allowlist",
          groupAllowFrom: [OTHER_PUBLIC_KEY],
          groups: { [ROOM_ID]: { requireMention: true, groupAllowFrom: [SENDER_PUBLIC_KEY] } },
        })
      : createAccount();
    await receive({ text: "/status" }, { account });
    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(authorized ? 1 : 0);
    if (authorized) {
      expect(firstDispatch(runtime).ctxPayload).toMatchObject({
        CommandAuthorized: true,
        CommandBody: "/status",
      });
    }
  },
);

it.each([false, true])(
  "never interprets structured diff text; requireMention=%s",
  async (requireMention) => {
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    vi.mocked(runtime.channel.mentions.matchesMentionPatterns).mockReturnValue(true);
    const diffText = `/status\n@@ -1 +1 @@\n-old\n+${"new".repeat(4_000)}\n+const owner = '@OpenClaw';`;
    await receive(
      {
        kind: BUZZ_DIFF_MESSAGE_KIND,
        text: diffText,
        diff: {
          repoUrl: "https://github.com/openclaw/openclaw",
          commitSha: "abcdef1",
          description: `line one\n${"x".repeat(1_100)}`,
          truncated: true,
        },
      },
      { account: createAccount({ groups: { [ROOM_ID]: { requireMention } } }) },
    );
    expect(runtime.channel.commands.shouldComputeCommandAuthorized).not.toHaveBeenCalled();
    expect(runtime.channel.mentions.matchesMentionPatterns).not.toHaveBeenCalled();
    if (requireMention) {
      expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
      return;
    }
    const context = firstDispatch(runtime).ctxPayload;
    expect(context).toMatchObject({
      BuzzEventKind: BUZZ_DIFF_MESSAGE_KIND,
      RawBody: diffText,
      CommandBody: "",
      BodyForCommands: "",
    });
    const bodyForAgent = context.BodyForAgent ?? "";
    expect(bodyForAgent).toContain("[Buzz structured diff]");
    expect(bodyForAgent).toContain("Repository: https://github.com/openclaw/openclaw");
    expect(bodyForAgent).toContain("Description: line one ");
    expect(bodyForAgent).toContain("Truncated: yes");
    expect(bodyForAgent).toContain("Unified diff:\n/status\n@@ -1 +1 @@\n-old\n+new");
    expect(bodyForAgent.endsWith("...[Buzz diff truncated for model context]")).toBe(true);
    expect(bodyForAgent.length).toBeLessThanOrEqual(4_000);
  },
);

it("propagates delivery and session-recording failures", async () => {
  await receive({ mentionedPubkeys: [BOT_PUBLIC_KEY] });

  const dispatch = firstDispatch(runtime);
  expect(() => dispatch.delivery.onError?.("send failed", { kind: "final" })).toThrow(
    "send failed",
  );
  expect(() => dispatch.record?.onRecordError?.("store failed")).toThrow(
    "Buzz session record failed: store failed",
  );
});
