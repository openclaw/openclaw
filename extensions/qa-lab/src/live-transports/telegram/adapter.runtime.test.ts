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
import { readQaScenarioById } from "../../scenario-catalog.js";
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

async function createAdapter(
  messages: Partial<AdapterContext["messages"]> = {},
  adapterOptions: AdapterContext["adapterOptions"] = {},
) {
  const unexpected = () => {
    throw new Error("Unexpected adapter host call");
  };
  const adapter = await createTelegramQaTransportAdapter({
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
  return Object.assign(adapter, { [Symbol.asyncDispose]: () => cleanup(adapter) });
}

function driver<T>(send: T) {
  return { assertHealthy: mocks.userbotAssertHealthy, close: mocks.userbotClose, send };
}

function observe() {
  const updates = observeParticipants([mocks.userbotSend]);
  return (update: unknown) => updates[0]!(update);
}

function sutConfig(adapter: Adapter) {
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
  participants: [{ alias: "second", testerUserId: "101" }],
};

async function prepareFlow(adapter: Adapter, config: Record<string, unknown> = {}) {
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

async function prepareMessageReader(adapter: Adapter) {
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
] as const)("selects the $kind delivery route", async (route) => {
  const threadId = "threadId" in route ? route.threadId : undefined;
  mocks.acquireQaCredentialLease.mockResolvedValueOnce(lease(identityCredential));
  await using adapter = await createAdapter(
    {},
    route.kind === "direct" ? { transportPolicy: { directMessageOnly: true } } : {},
  );
  expect(mocks.userbotStart.mock.calls[0]?.[0].chatId).toBe(
    route.kind === "direct" ? "@sut_bot" : "-100123",
  );
  const deliveryTarget = String(route.kind === "direct" ? 100 : route.chatId);
  expect(
    adapter.buildAgentDelivery({
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
});

it("maps, filters, edits, and resets native messages under lease health", async () => {
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
  const state = createQaBusState();
  await using adapter = await createAdapter(state);
  expect(sutConfig(adapter)?.apiRoot).toBe("http://127.0.0.1:3210");
  expect(mocks.proxyDrainUpdates).toHaveBeenCalledWith("sut-token");
  const sent = await adapter.sendInbound(
    inbound("logical-room", "@openclaw reply exactly: QA-MARKER", { senderId: "driver" }),
  );
  expect(mocks.userbotSend).toHaveBeenCalledWith({
    text: "@sut_bot reply exactly: QA-MARKER",
    chatId: "-100123",
    replyToMessageId: undefined,
  });
  const reply = state.getSnapshot().messages[1]!;
  expect(sent).toMatchObject({ accountId: "sut", senderId: "100" });
  expect(reply).toMatchObject({
    conversation: { kind: "group", id: "logical-room" },
    text: preview.text,
    replyToId: sent.id,
  });
  const readMessages = await prepareMessageReader(adapter);
  const firstSnapshot = readMessages();
  expect(firstSnapshot).toEqual([preview]);
  firstSnapshot[0].entities[0].type["@type"] = "textEntityTypeBold";
  expect(readMessages()[0].entities[0].type["@type"]).toBe("textEntityTypeCode");

  await adapter.sendInbound(
    inbound("logical-room", "follow-up", { senderId: "driver", replyToId: reply.id }),
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
  expect(state.getSnapshot().messages[1]).toMatchObject({
    id: reply.id,
    text: preview.text,
    timestamp: preview.timestamp,
    editedAt: 101_000,
  });
  expect(readMessages()).toEqual([edited]);
  await onUpdate({ ...edited, text: "final", entities: [] });
  expect(readMessages()).toEqual([{ ...edited, text: "final", entities: [] }]);

  const matched = nativeMessage({ kind: "edit", messageId: 78 });
  await onUpdate({ ...matched, kind: "message", chatId: -100999, messageId: 77 });
  await onUpdate({ ...matched, kind: "message", senderId: 201, messageId: 79 });
  await onUpdate(matched);
  const diagnostics = adapter.describeTransportState?.() ?? "";
  for (const field of ["updates=6", "filtered=2", "matched=4", "update kinds=[message,edit]"]) {
    expect(diagnostics).toContain(field);
  }
  expect(diagnostics).not.toMatch(/-100123|77|78|79/u);
  expect(readMessages()).toEqual([{ ...edited, text: "final", entities: [] }, matched]);
  await adapter.resetTransport?.();
  expect(adapter.describeTransportState?.()).toContain("updates=0");
  expect(readMessages()).toEqual([]);

  mocks.heartbeatThrowIfFailed.mockImplementationOnce(() => {
    throw new Error("lease revoked");
  });
  expect(() => readMessages()).toThrow("lease revoked");
  mocks.heartbeatThrowIfFailed.mockImplementationOnce(() => {
    throw new Error("lease revoked");
  });
  expect(() => mocks.startApiProxy.mock.calls[0]?.[0].assertHealthy()).toThrow("lease revoked");
  mocks.userbotAssertHealthy.mockImplementationOnce(() => {
    throw new Error("Telegram userbot is closed.");
  });
  expect(() => readMessages()).toThrow("Telegram userbot is closed.");
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
  const state = createQaBusState();
  const adapter = await createAdapter(state);
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
    expect(sends[1]!.mock.calls.at(-1)?.[0].forumTopicId).toBe(42);
    expect(state.getSnapshot().messages.map((message) => message.senderId)).toEqual([
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
    const replies = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound");
    expect(
      replies.map(({ conversation, threadId }) => [conversation.kind, conversation.id, threadId]),
    ).toEqual([
      ["direct", "dm", undefined],
      ["group", "room", undefined],
      ["group", "forum", "42"],
    ]);
    await primaryUpdate({ ...update, kind: "edit", chatId: 200, text: "dm edit" });
    expect(
      state.getSnapshot().messages.find((message) => message.id === replies[0]!.id)?.text,
    ).toBe("dm edit");
    await expect(adapter.sendInbound(inbound("other-room", "remap"))).rejects.toThrow(
      "another logical conversation",
    );
    await expect(
      adapter.sendInbound(inbound("room", "impersonate", { senderId: "missing" })),
    ).rejects.toThrow("named leased participant");
    await expect(
      adapter.sendInbound(
        inbound("room", "wrong observer", { senderId: "second", replyToId: replies[1]!.id }),
      ),
    ).rejects.toThrow("observed by this participant");
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
  const state = createQaBusState();
  const adapter = await createAdapter(state, { credentialFile: "/private/descriptor.json" });
  try {
    expect(mocks.acquireQaCredentialLease).not.toHaveBeenCalled();
    expect(mocks.startApiProxy).not.toHaveBeenCalled();
    expect(sutConfig(adapter)).toMatchObject({
      allowFrom: ["100", "101"],
      groups: { "-100456": { allowFrom: ["100", "101"] } },
    });
    expect(sutConfig(adapter)).not.toHaveProperty("apiRoot");

    const sent = await adapter.sendInbound(
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
    expect(state.getSnapshot().messages).toMatchObject([
      { id: sent.id, senderId: "101" },
      {
        replyToId: sent.id,
        text: "synthetic-marker",
        conversation: { kind: "group", id: "forum" },
        threadId: "42",
      },
    ]);
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
    {
      await using adapter = await createAdapter();
      const scenario = readQaScenarioById("telegram-participant-identity-inspection");
      await expect(prepareFlow(adapter, scenario.execution.config)).rejects.toThrow(
        "requires distinct participants, forumGroupId, and forumTopicId",
      );
      expect(mocks.userbotSend).not.toHaveBeenCalled();
    }
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
  },
);

it("rejects an unconfirmed participant receipt without recording synthetic identity", async () => {
  mocks.userbotSend.mockResolvedValueOnce({ messageId: 10, senderId: 999, chatId: -100123 });
  const state = createQaBusState();
  await using adapter = await createAdapter(state);
  await expect(adapter.sendInbound(inbound("room", "identity"))).rejects.toThrow("send receipt");
  expect(state.getSnapshot().messages).toEqual([]);
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
