import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireQaCredentialLease: vi.fn(),
  assertQaGatewayCredentialLeaseQuarantine: vi.fn(),
  createStateRoot: vi.fn(),
  heartbeatStop: vi.fn(),
  heartbeatThrowIfFailed: vi.fn(),
  leaseHeartbeat: vi.fn(),
  leaseRelease: vi.fn(),
  loadTelegramUserbotSkillRuntime: vi.fn(),
  proxyClose: vi.fn(),
  proxyDrainUpdates: vi.fn(),
  readTelegramPrivateProductionDescriptor: vi.fn(),
  requestTelegramPrivateAppTurn: vi.fn(),
  resolveTelegramPrivateProductionBot: vi.fn(),
  restoreCredential: vi.fn(),
  shouldRetainQaGatewayCredentialLease: vi.fn(),
  startApiProxy: vi.fn(),
  userbotAssertHealthy: vi.fn(),
  userbotClose: vi.fn(),
  userbotSend: vi.fn(),
  userbotStart: vi.fn(),
}));

vi.mock("../shared/credential-lease.runtime.js", () => ({
  acquireQaCredentialLease: mocks.acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat: () => ({
    stop: mocks.heartbeatStop,
    throwIfFailed: mocks.heartbeatThrowIfFailed,
    whenFailed: new Promise<Error>(() => {}),
  }),
}));

vi.mock("../../gateway-process-boundary.js", () => ({
  assertQaGatewayCredentialLeaseQuarantine: mocks.assertQaGatewayCredentialLeaseQuarantine,
  shouldRetainQaGatewayCredentialLease: mocks.shouldRetainQaGatewayCredentialLease,
}));

vi.mock("./userbot-driver.runtime.js", () => ({
  TelegramUserbotDriver: { start: mocks.userbotStart },
}));

vi.mock("./private-production.runtime.js", () => ({
  readTelegramPrivateProductionDescriptor: mocks.readTelegramPrivateProductionDescriptor,
  requestTelegramPrivateAppTurn: mocks.requestTelegramPrivateAppTurn,
  resolveTelegramPrivateProductionBot: mocks.resolveTelegramPrivateProductionBot,
}));

vi.mock("./userbot-skill.runtime.js", () => ({
  loadTelegramUserbotSkillRuntime: mocks.loadTelegramUserbotSkillRuntime,
}));

import { createQaBusState } from "../../bus-state.js";
import { createQaStateBackedTransportAdapter } from "../../qa-transport.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import { runQaSuiteRoundTripProbe } from "../../suite-round-trip.js";
import { createTelegramQaTransportAdapter } from "./adapter.runtime.js";
import type { TelegramUserbotUpdate } from "./userbot-driver.runtime.js";

type AdapterContext = Parameters<typeof createTelegramQaTransportAdapter>[0];
type Adapter = Awaited<ReturnType<typeof createTelegramQaTransportAdapter>>;

const lease = (payload: unknown) => ({
  payload,
  heartbeat: mocks.leaseHeartbeat,
  release: mocks.leaseRelease,
});

function nativeMessage(overrides: Partial<TelegramUserbotUpdate> = {}): TelegramUserbotUpdate {
  return {
    kind: "message",
    chatId: -100123,
    messageId: 11,
    senderId: 200,
    timestamp: 1000,
    text: "reply",
    entities: [],
    ...overrides,
  };
}

function expectObjectCall(mock: ReturnType<typeof vi.fn>, value: Record<string, unknown>) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(value));
}

function expectOnce(...functions: ReturnType<typeof vi.fn>[]) {
  for (const fn of functions) {
    expect(fn).toHaveBeenCalledOnce();
  }
}

async function cleanup(adapter: Pick<Adapter, "cleanup" | "cleanupAfterGatewayStop">) {
  await adapter.cleanup?.();
  await adapter.cleanupAfterGatewayStop?.();
}

function inbound(
  id: string,
  text: string,
  options: Partial<Parameters<Adapter["sendInbound"]>[0]> = {},
) {
  return { conversation: { id, kind: "group" as const }, senderId: "primary", text, ...options };
}

function observeParticipants(sends: ReturnType<typeof vi.fn>[]) {
  const updates: Array<(update: unknown) => Promise<void>> = [];
  mocks.userbotStart.mockImplementation(async (params) => {
    const index = updates.length;
    updates.push(params.onUpdate);
    return driver(sends[index]);
  });
  return updates;
}

function createAdapter(
  messages: Partial<AdapterContext["messages"]> = {},
  adapterOptions: AdapterContext["adapterOptions"] = {},
) {
  const unexpected = () => {
    throw new Error("Unexpected adapter host call");
  };
  return createTelegramQaTransportAdapter({
    adapterOptions,
    channelId: "telegram",
    driver: "live",
    outputDir: mocks.createStateRoot.mock.results.at(-1)?.value ?? "/unused",
    credentials: { acquire: unexpected, startHeartbeat: unexpected },
    messages: {
      addInboundMessage: unexpected,
      addOutboundMessage: unexpected,
      editMessage: unexpected,
      ...messages,
    },
  });
}

function driver<T>(send: T) {
  return { assertHealthy: mocks.userbotAssertHealthy, close: mocks.userbotClose, send };
}

function observe() {
  const updates = observeParticipants([mocks.userbotSend]);
  return (update: unknown) => updates[0]!(update);
}

function sutConfig(adapter: Awaited<ReturnType<typeof createAdapter>>) {
  return adapter.createGatewayConfig({ baseUrl: "http://127.0.0.1:1234" }).channels?.telegram
    ?.accounts?.sut;
}

const credential = {
  environment: "test",
  groupId: "-100123",
  sutToken: "sut-token",
  sutUsername: "sut_bot",
  sutBotId: "200",
  testerUserId: "100",
} as const;

const identityCredential = {
  ...credential,
  forumGroupId: "-100456",
  forumTopicId: 42,
  participants: [
    {
      alias: "second",
      testerUserId: "101",
    },
  ],
};

async function prepareFlow(
  adapter: Awaited<ReturnType<typeof createTelegramQaTransportAdapter>>,
  config: Record<string, unknown> = {},
) {
  const stateRoot = mocks.createStateRoot.mock.results.at(-1)?.value;
  return await adapter.prepareFlow?.({
    config,
    scenarioId: "telegram-entities",
    scenarioTitle: "Telegram native entities",
    gateway: {
      baseUrl: "http://127.0.0.1:1234",
      tempRoot: stateRoot,
      workspaceDir: stateRoot,
      runtimeEnv: {},
      call: vi.fn(),
    },
    waitForConfigRestartSettle: vi.fn(),
    outputDir: stateRoot,
    timeoutMs: 30_000,
  });
}

async function prepareMessageReader(
  adapter: Awaited<ReturnType<typeof createTelegramQaTransportAdapter>>,
) {
  const prepared = await prepareFlow(adapter);
  const read = prepared?.readTelegramMessages;
  if (typeof read !== "function") {
    throw new Error("Telegram flow did not expose native message observations");
  }
  return read;
}

beforeEach(() => {
  vi.clearAllMocks();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-adapter-test-"));
  mocks.createStateRoot.mockReturnValue(stateRoot);
  mocks.readTelegramPrivateProductionDescriptor.mockReturnValue(undefined);
  mocks.acquireQaCredentialLease.mockResolvedValue({
    ...lease(credential),
    source: "convex",
  });
  mocks.loadTelegramUserbotSkillRuntime.mockResolvedValue({
    userDriverPath: "/skill/user-driver.py",
    createStateRoot: mocks.createStateRoot,
    parseCredential: vi.fn(),
    restoreCredential: mocks.restoreCredential,
    startApiProxy: mocks.startApiProxy,
  });
  mocks.restoreCredential.mockReturnValue({
    groupId: credential.groupId,
    driverEnv: { TELEGRAM_USER_DRIVER_STATE_DIR: path.join(stateRoot, "user-driver") },
  });
  mocks.startApiProxy.mockResolvedValue({
    apiRoot: "http://127.0.0.1:3210",
    close: mocks.proxyClose,
    drainUpdates: mocks.proxyDrainUpdates,
  });
  mocks.userbotStart.mockResolvedValue(driver(mocks.userbotSend));
  mocks.proxyDrainUpdates.mockResolvedValue(undefined);
  mocks.shouldRetainQaGatewayCredentialLease.mockResolvedValue(false);
});

it.each([
  { kind: "direct", id: "selected-dm", chatId: 200 },
  { kind: "channel", id: "selected-command", chatId: -100123 },
  { kind: "group", id: "selected-forum", chatId: -100456, threadId: "42" },
] as const)(
  "admits repeated RTT on the selected $kind route with native reply IDs",
  async (route) => {
    const state = createQaBusState();
    const threadId = "threadId" in route ? route.threadId : undefined;
    const conversation = { id: route.id, kind: route.kind };
    mocks.acquireQaCredentialLease.mockResolvedValueOnce(lease(identityCredential));
    let nextNativeId = 10;
    const sends = [100, 101].map((senderId) =>
      vi.fn(async (input) => {
        const messageId = nextNativeId++;
        const onUpdate = updates[0];
        if (!onUpdate) {
          throw new Error("primary observer was not started");
        }
        await onUpdate(
          nativeMessage({
            chatId: Number(input.chatId),
            forumTopicId: input.forumTopicId,
            messageId: nextNativeId++,
            timestamp: Date.now(),
            text: input.text,
          }),
        );
        return {
          messageId,
          senderId,
          chatId: Number(input.chatId),
          forumTopicId: input.forumTopicId,
        };
      }),
    );
    const updates = observeParticipants(sends);
    const definition = await createAdapter(
      state,
      route.kind === "direct" ? { transportPolicy: { directMessageOnly: true } } : {},
    );
    const transport = createQaStateBackedTransportAdapter(state, definition);
    try {
      expect(mocks.userbotStart.mock.calls[0]?.[0].chatId).toBe(
        route.kind === "direct" ? "@sut_bot" : "-100123",
      );
      expect(sutConfig(definition)).toMatchObject({
        allowFrom: ["100", "101"],
        dmPolicy: "allowlist",
      });
      const deliveryTarget = String(route.kind === "direct" ? 100 : route.chatId);
      expect(
        definition.buildAgentDelivery({
          target: `${route.kind === "direct" ? "dm" : "group"}:${route.id}`,
          threadId,
        }),
      ).toEqual({
        channel: "telegram",
        to: deliveryTarget,
        replyChannel: "telegram",
        replyTo: deliveryTarget,
        ...(threadId ? { threadId } : {}),
      });
      const scenarioStartCursor = state.getSnapshot().cursor;
      await transport.sendInbound({
        conversation,
        threadId,
        senderId: route.kind === "group" ? "second" : "primary",
        text: "scenario turn",
      });
      const result = await runQaSuiteRoundTripProbe({
        transport,
        scenarioStartCursor,
        probe: {
          scenarioId: "selected-scenario",
          count: 2,
          maxFailures: 1,
          timeoutMs: 1_000,
          markerPrefix: "QA-RTT",
          input: { fromScenario: true, senderId: "primary" },
          textPrefix: "Reply exactly: ",
          chainReplies: true,
        },
      });
      expect(result).toMatchObject({ passed: 2, failed: 0 });
      const probeSends = sends[0]!.mock.calls.slice(-2).map(([input]) => input);
      expect(probeSends).toEqual([
        expect.objectContaining({ chatId: String(route.chatId), replyToMessageId: undefined }),
        expect.objectContaining({ chatId: String(route.chatId), replyToMessageId: 13 }),
      ]);
      expect(probeSends.map((input) => input.forumTopicId)).toEqual([
        threadId ? 42 : undefined,
        threadId ? 42 : undefined,
      ]);
      expect(
        state
          .getSnapshot()
          .messages.filter((message) => message.direction === "inbound")
          .slice(-2),
      ).toEqual([
        expect.objectContaining({ conversation, threadId, senderId: "100" }),
        expect.objectContaining({ conversation, threadId, senderId: "100" }),
      ]);
    } finally {
      await cleanup(transport);
      state.reset(true);
    }
  },
);

it("passes terminal heartbeat state to the Bot API proxy", async () => {
  const adapter = await createAdapter();
  const leaseHealth = mocks.startApiProxy.mock.calls[0]?.[0];
  mocks.heartbeatThrowIfFailed.mockImplementationOnce(() => {
    throw new Error("lease revoked");
  });

  expect(() => leaseHealth.assertHealthy()).toThrow("lease revoked");
  expect(mocks.proxyDrainUpdates).toHaveBeenCalledTimes(1);

  await cleanup(adapter);
});

it("maps sends, replies, messages, and formatting edits through one userbot process", async () => {
  const onUpdate = observe();
  const preview = nativeMessage({
    botApiMessageId: 11,
    senderUsername: "sut_bot",
    replyToMessageId: 10,
    timestamp: 100_000,
    text: "😀 a   b",
    entities: [{ offset: 3, length: 5, type: { "@type": "textEntityTypeCode" } }],
  });
  mocks.userbotSend
    .mockImplementationOnce(async () => {
      await onUpdate(preview);
      return { messageId: 10, senderId: 100, chatId: -100123 };
    })
    .mockResolvedValueOnce({ messageId: 12, senderId: 100, chatId: -100123 });
  const addInboundMessage = vi.fn().mockResolvedValue({ id: "in-1" });
  const addOutboundMessage = vi.fn().mockResolvedValue({ id: "out-1" });
  const editMessage = vi.fn();
  const adapter = await createAdapter(
    { addInboundMessage, addOutboundMessage, editMessage },
    { credentialSource: "convex", credentialRole: "ci", repoRoot: "/checkout" },
  );
  try {
    expectObjectCall(mocks.acquireQaCredentialLease, {
      kind: "telegram-test-userbot",
      source: "convex",
      role: "ci",
    });
    expect(mocks.loadTelegramUserbotSkillRuntime).toHaveBeenCalledWith({ repoRoot: "/checkout" });
    expect(mocks.proxyDrainUpdates).toHaveBeenCalledWith("sut-token");
    expect(sutConfig(adapter)).toMatchObject({
      apiRoot: "http://127.0.0.1:3210",
      groups: { "-100123": { allowFrom: ["100"], requireMention: true } },
    });
    await adapter.sendInbound(
      inbound("logical-room", "@openclaw reply exactly: QA-MARKER", { senderId: "driver" }),
    );
    expect(mocks.userbotSend).toHaveBeenCalledWith({
      text: "@sut_bot reply exactly: QA-MARKER",
      chatId: "-100123",
      replyToMessageId: undefined,
    });
    expectObjectCall(addInboundMessage, { accountId: "sut", senderId: "100" });
    expectObjectCall(addOutboundMessage, {
      to: "group:logical-room",
      text: preview.text,
      replyToId: "in-1",
    });
    const readMessages = await prepareMessageReader(adapter);
    const firstSnapshot = readMessages();
    expect(firstSnapshot).toEqual([preview]);
    firstSnapshot[0].entities[0].type["@type"] = "textEntityTypeBold";
    expect(readMessages()).toEqual([preview]);

    await adapter.sendInbound(
      inbound("logical-room", "follow-up", { senderId: "driver", replyToId: "out-1" }),
    );
    expect(mocks.userbotSend).toHaveBeenLastCalledWith({
      text: "follow-up",
      chatId: "-100123",
      replyToMessageId: 11,
    });
    const edited = {
      ...preview,
      kind: "edit",
      timestamp: 101_000,
      entities: [{ offset: 3, length: 5, type: { "@type": "textEntityTypeBold" } }],
    };
    await onUpdate(edited);
    expectObjectCall(editMessage, { messageId: "out-1", text: preview.text, timestamp: 101_000 });
    expect(readMessages()).toEqual([edited]);
    await onUpdate({ ...edited, text: "final", entities: [] });
    expect(readMessages()).toEqual([{ ...edited, text: "final", entities: [] }]);

    mocks.heartbeatThrowIfFailed.mockImplementationOnce(() => {
      throw new Error("lease revoked");
    });
    expect(() => readMessages()).toThrow("lease revoked");
    mocks.userbotAssertHealthy.mockImplementationOnce(() => {
      throw new Error("Telegram userbot is closed.");
    });
    expect(() => readMessages()).toThrow("Telegram userbot is closed.");
  } finally {
    await cleanup(adapter);
  }
});

it("filters other updates and resets diagnostics and native observations", async () => {
  const onUpdate = observe();
  const addOutboundMessage = vi.fn().mockResolvedValue({ id: "out-1" });
  const adapter = await createAdapter({ addOutboundMessage });
  try {
    const matched = nativeMessage({
      kind: "edit",
      messageId: 78,
      timestamp: 101_000,
      text: "matched",
      entities: [{ offset: 0, length: 7, type: { "@type": "textEntityTypeBold" } }],
    });
    await onUpdate({ ...matched, kind: "message", chatId: -100999, messageId: 77 });
    await onUpdate({ ...matched, kind: "message", senderId: 201, messageId: 79 });
    await onUpdate(matched);

    const diagnostics = adapter.describeTransportState?.() ?? "";
    expect(diagnostics).toContain("updates=3");
    expect(diagnostics).toContain("filtered=2");
    expect(diagnostics).toContain("matched=1");
    expect(diagnostics).toContain("update kinds=[message,edit]");
    expect(diagnostics).not.toMatch(/-100123|77|78|79/u);
    const readMessages = await prepareMessageReader(adapter);
    expect(readMessages()).toEqual([matched]);

    await adapter.resetTransport?.();
    expect(adapter.describeTransportState?.()).toContain("updates=0");
    expect(readMessages()).toEqual([]);
  } finally {
    await cleanup(adapter);
  }
});

it("keeps DM, group, forum, and mixed leased participants distinct", async () => {
  mocks.acquireQaCredentialLease.mockResolvedValueOnce(lease(identityCredential));
  const sends = [100, 101].map((senderId) =>
    vi.fn(async (input) => ({
      messageId: 10,
      senderId,
      chatId: Number(input.chatId),
      forumTopicId: input.forumTopicId,
    })),
  );
  const updates = observeParticipants(sends);
  let nextId = 0;
  const addInboundMessage = vi.fn().mockImplementation(async () => ({ id: `in-${++nextId}` }));
  const addOutboundMessage = vi.fn().mockImplementation(async () => ({ id: `out-${++nextId}` }));
  const editMessage = vi.fn();
  const adapter = await createAdapter({ addInboundMessage, addOutboundMessage, editMessage });
  try {
    const scenario = readQaScenarioById("telegram-participant-identity-inspection");
    await expect(prepareFlow(adapter, scenario.execution.config)).resolves.toMatchObject({
      telegramIdentityFixture: { participantAliases: ["primary", "second"], forumTopicId: 42 },
    });
    expect(mocks.userbotStart.mock.calls.map(([input]) => input.expectedUserId)).toEqual([
      "100",
      "101",
    ]);
    expect(mocks.userbotStart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ observeChatIds: ["-100456"] }),
    );
    expect(sutConfig(adapter)).toMatchObject({
      allowFrom: ["100", "101"],
      groups: { "-100456": { allowFrom: ["100", "101"] } },
    });
    await adapter.sendInbound(inbound("dm", "dm", { conversation: { id: "dm", kind: "direct" } }));
    await adapter.sendInbound(inbound("room", "group"));
    await adapter.sendInbound(inbound("room", "mixed", { senderId: "second" }));
    await adapter.sendInbound(inbound("forum", "forum", { threadId: "42", senderId: "second" }));
    expect(sends.map((send) => send.mock.calls.map(([input]) => input.chatId))).toEqual([
      ["200", "-100123"],
      ["-100123", "-100456"],
    ]);
    expect(sends[1]).toHaveBeenLastCalledWith({
      chatId: "-100456",
      forumTopicId: 42,
      text: "forum",
      replyToMessageId: undefined,
    });
    expect(addInboundMessage.mock.calls.map(([input]) => input.senderId)).toEqual([
      "100",
      "100",
      "101",
      "101",
    ]);
    const update = nativeMessage();
    // Deliver a late DM reply after two other native conversations have sent.
    const [primaryUpdate, secondUpdate] = updates;
    if (!primaryUpdate || !secondUpdate) {
      throw new Error("Expected both leased participant observers to start.");
    }
    await primaryUpdate({ ...update, chatId: 200 });
    await primaryUpdate({ ...update, chatId: -100123 });
    await secondUpdate({ ...update, chatId: -100123 });
    await primaryUpdate({ ...update, chatId: -100456, forumTopicId: 42 });
    await primaryUpdate({ ...update, chatId: -100456, forumTopicId: 43 });
    expect(addOutboundMessage.mock.calls.map(([input]) => input.to)).toEqual([
      "dm:dm",
      "group:room",
      "thread:/v1/group/forum/42",
    ]);
    await primaryUpdate({ ...update, kind: "edit", chatId: 200, text: "dm edit" });
    expectObjectCall(editMessage, { messageId: "out-5", text: "dm edit" });
    await expect(adapter.sendInbound(inbound("other-room", "remap"))).rejects.toThrow(
      "another logical conversation",
    );
    await expect(
      adapter.sendInbound(inbound("room", "impersonate", { senderId: "missing" })),
    ).rejects.toThrow("named leased participant");
    await expect(
      adapter.sendInbound(
        inbound("room", "wrong observer", { senderId: "second", replyToId: "out-6" }),
      ),
    ).rejects.toThrow("observed by this participant");
    expect(adapter.buildAgentDelivery({ target: "group:forum", threadId: "42" })).toEqual({
      channel: "telegram",
      to: "-100456",
      replyChannel: "telegram",
      replyTo: "-100456",
      threadId: "42",
    });
  } finally {
    await cleanup(adapter);
  }
  expect(mocks.userbotClose).toHaveBeenCalledTimes(2);
  expect(mocks.leaseRelease).toHaveBeenCalledOnce();
});

it("uses local Telegram.app participants without acquiring a shared credential", async () => {
  const descriptor = {
    file: "/private/descriptor.json",
    mode: "private-production-local-apps",
    forumGroupId: "-100456",
    forumTopicId: 42,
    topicTitle: "Private identity proof",
    participants: [
      { alias: "primary", host: "mainframe", userId: "100" },
      { alias: "second", host: "macbook", userId: "101" },
    ],
  };
  mocks.readTelegramPrivateProductionDescriptor.mockReturnValueOnce(descriptor);
  mocks.resolveTelegramPrivateProductionBot.mockResolvedValue({
    id: "200",
    token: "private-token",
    username: "qa_bot",
  });
  mocks.requestTelegramPrivateAppTurn.mockResolvedValue({ replyText: "synthetic-marker" });
  const addInboundMessage = vi.fn().mockResolvedValue({ id: "in-hitl" });
  const addOutboundMessage = vi.fn().mockResolvedValue({ id: "out-hitl" });
  const adapter = await createAdapter(
    { addInboundMessage, addOutboundMessage },
    { credentialFile: "/private/descriptor.json" },
  );
  try {
    expect(mocks.acquireQaCredentialLease).not.toHaveBeenCalled();
    expect(mocks.startApiProxy).not.toHaveBeenCalled();
    expect(sutConfig(adapter)).toMatchObject({
      allowFrom: ["100", "101"],
      groups: { "-100456": { allowFrom: ["100", "101"] } },
    });
    expect(sutConfig(adapter)).not.toHaveProperty("apiRoot");

    await adapter.sendInbound(
      inbound("forum", "@openclaw Reply exactly: synthetic-marker", {
        senderId: "second",
        threadId: "42",
      }),
    );
    expect(mocks.requestTelegramPrivateAppTurn).toHaveBeenCalledWith({
      descriptor,
      destination: "forum-topic",
      participant: descriptor.participants[1],
      text: "@qa_bot Reply exactly: synthetic-marker",
    });
    expectObjectCall(addInboundMessage, { senderId: "101" });
    expectObjectCall(addOutboundMessage, {
      replyToId: "in-hitl",
      text: "synthetic-marker",
      to: "thread:/v1/group/forum/42",
    });
    expect(mocks.userbotSend).not.toHaveBeenCalled();
  } finally {
    await cleanup(adapter);
  }
  expect(mocks.userbotStart).not.toHaveBeenCalled();
  expect(mocks.leaseRelease).not.toHaveBeenCalled();
});

it.each(["participants", "forumGroupId", "forumTopicId"] as const)(
  "fails the cataloged identity scenario clearly when the lease lacks %s",
  async (missing) => {
    mocks.acquireQaCredentialLease.mockResolvedValueOnce(
      lease({ ...identityCredential, [missing]: undefined }),
    );
    const adapter = await createAdapter();
    try {
      const scenario = readQaScenarioById("telegram-participant-identity-inspection");
      await expect(prepareFlow(adapter, scenario.execution.config)).rejects.toThrow(
        "requires distinct participants, forumGroupId, and forumTopicId",
      );
      expect(mocks.userbotSend).not.toHaveBeenCalled();
    } finally {
      await cleanup(adapter);
    }
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
  },
);

it("rejects an unconfirmed participant receipt without recording synthetic identity", async () => {
  mocks.userbotSend.mockResolvedValueOnce({ messageId: 10, senderId: 999, chatId: -100123 });
  const addInboundMessage = vi.fn();
  const adapter = await createAdapter({ addInboundMessage });
  try {
    await expect(adapter.sendInbound(inbound("room", "identity"))).rejects.toThrow("send receipt");
    expect(addInboundMessage).not.toHaveBeenCalled();
  } finally {
    await cleanup(adapter);
  }
});

it("retains participant recovery state and the lease when observer shutdown is unconfirmed", async () => {
  const adapter = await createAdapter();
  const root = mocks.createStateRoot.mock.results.at(-1)?.value;
  mocks.userbotClose.mockRejectedValueOnce(new Error("exit unconfirmed"));
  try {
    await expect(adapter.cleanup?.()).rejects.toThrow("retained private state");
    await expect(adapter.cleanupAfterGatewayStop?.()).rejects.toThrow(
      "retained Telegram credential",
    );
    expect(fs.existsSync(root)).toBe(true);
    expect(mocks.leaseRelease).not.toHaveBeenCalled();
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ["userbot startup", "authorization failed"],
  ["scratch creation", "scratch failed"],
  ["proxy cleanup", "proxy close failed"],
])("releases the lease when %s fails", async (stage, message) => {
  if (stage === "scratch creation") {
    mocks.createStateRoot.mockImplementationOnce(() => {
      throw new Error(message);
    });
  } else {
    (stage === "userbot startup" ? mocks.userbotStart : mocks.proxyClose).mockRejectedValueOnce(
      new Error(message),
    );
  }
  const creating = createAdapter();
  if (stage === "proxy cleanup") {
    const adapter = await creating;
    await adapter.cleanup?.();
    await expect(adapter.cleanupAfterGatewayStop?.()).rejects.toThrow(message);
  } else {
    await expect(creating).rejects.toThrow(message);
  }
  expectOnce(mocks.heartbeatStop, mocks.leaseRelease);
  if (stage === "userbot startup") {
    expectOnce(mocks.proxyClose);
    expect(fs.existsSync(mocks.createStateRoot.mock.results.at(-1)?.value)).toBe(false);
  }
});

it("retains a quarantined lease after stopping the userbot and proxy", async () => {
  mocks.shouldRetainQaGatewayCredentialLease.mockResolvedValueOnce(true);
  const adapter = await createAdapter();

  await adapter.cleanup?.();
  await expect(adapter.cleanupAfterGatewayStop?.()).rejects.toThrow("retained Telegram credential");

  expectOnce(mocks.userbotClose, mocks.proxyClose, mocks.leaseHeartbeat, mocks.heartbeatStop);
  expect(mocks.leaseRelease).not.toHaveBeenCalled();
});
