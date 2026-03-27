import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchInboundMessageMock, sendReactionSignalMock } = vi.hoisted(() => ({
  dispatchInboundMessageMock: vi.fn().mockResolvedValue({ queuedFinal: false }),
  sendReactionSignalMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../send-reactions.js", () => ({
  sendReactionSignal: sendReactionSignalMock,
}));

vi.mock("../../../../src/auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
  };
});

let dispatchInboundMessage: typeof import("../../../../src/auto-reply/dispatch.js").dispatchInboundMessage;
let sendReactionSignal: typeof import("../send-reactions.js").sendReactionSignal;
let createSignalEventHandler: typeof import("./event-handler.js").createSignalEventHandler;
let createBaseSignalEventHandlerDeps: typeof import("./event-handler.test-harness.js").createBaseSignalEventHandlerDeps;
let createSignalReceiveEvent: typeof import("./event-handler.test-harness.js").createSignalReceiveEvent;

describe("Signal ACK reactions", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ dispatchInboundMessage } = await import("../../../../src/auto-reply/dispatch.js"));
    ({ sendReactionSignal } = await import("../send-reactions.js"));
    ({ createSignalEventHandler } = await import("./event-handler.js"));
    ({ createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
      await import("./event-handler.test-harness.js"));
  });

  function makeDeps(cfgOverrides: Record<string, unknown> = {}) {
    const accountOverrides =
      (cfgOverrides.accountOverrides as Record<string, unknown>) ?? undefined;
    const messagesOverrides = (cfgOverrides.messages as Record<string, unknown>) ?? undefined;
    return createBaseSignalEventHandlerDeps({
      cfg: {
        channels: {
          signal: {
            accounts: {
              default: {
                reactionLevel: "ack",
                ...accountOverrides,
              },
            },
          },
        },
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
          ...messagesOverrides,
        },
        ...cfgOverrides,
      },
      ignoreAttachments: true,
    });
  }

  function makeEvent(overrides: Record<string, unknown> = {}) {
    return createSignalReceiveEvent({
      dataMessage: { message: "hello", timestamp: 1700000000000 },
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends ack reaction for DM when reactionLevel=ack and scope=direct", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "direct" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "+15550001111",
      1700000000000,
      "👀",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("sends ack reaction for DM when scope=all", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "all" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "+15550001111",
      1700000000000,
      "👀",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("does NOT send ack when scope=off", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "off" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("does NOT send ack when reactionLevel=minimal", async () => {
    const deps = makeDeps({
      accountOverrides: { reactionLevel: "minimal" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("does NOT send ack when reactionLevel=off", async () => {
    const deps = makeDeps({
      accountOverrides: { reactionLevel: "off" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("sends ack using dataMessage.timestamp when envelope.timestamp is missing", async () => {
    const deps = makeDeps();
    const handler = createSignalEventHandler(deps);
    await handler(
      createSignalReceiveEvent({
        envelope: { source: "+15550001111", sourceDevice: 1 },
        dataMessage: { message: "hello", timestamp: 1700000000001 },
      }),
    );

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "+15550001111",
      1700000000001,
      "👀",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("does NOT send ack when both envelope and dataMessage timestamps are missing", async () => {
    const deps = makeDeps();
    const handler = createSignalEventHandler(deps);
    await handler(
      createSignalReceiveEvent({
        envelope: { source: "+15550001111", sourceDevice: 1 },
        dataMessage: { message: "hello" },
      }),
    );

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("sends ack when message has no text but has an attachment", async () => {
    const deps = makeDeps();
    const handler = createSignalEventHandler(deps);
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          timestamp: 1700000000000,
          attachments: [{ contentType: "image/png", filename: "test.png", id: "1" }],
        },
      }),
    );

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "+15550001111",
      1700000000000,
      "👀",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("sends ack BEFORE dispatch", async () => {
    const callOrder: string[] = [];
    sendReactionSignalMock.mockImplementation(async () => {
      callOrder.push("ack");
      return { ok: true };
    });
    dispatchInboundMessageMock.mockImplementation(async () => {
      callOrder.push("dispatch");
      return { queuedFinal: false };
    });

    const deps = makeDeps();
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(callOrder[0]).toBe("ack");
    expect(callOrder).toContain("dispatch");
  });

  it("does NOT send ack for group messages when scope=direct", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "direct" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello",
          timestamp: 1700000000000,
          groupInfo: { groupId: "group123", type: "DELIVER" },
        },
      }),
    );

    expect(sendReactionSignal).not.toHaveBeenCalled();
  });

  it("sends ack for group messages when scope=all", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "all" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello",
          timestamp: 1700000000000,
          groupInfo: { groupId: "group123", type: "DELIVER" },
        },
      }),
    );

    expect(sendReactionSignal).toHaveBeenCalled();
  });

  it("sends ack for group messages when scope=group", async () => {
    const deps = makeDeps({
      messages: { ackReaction: "👀", ackReactionScope: "group" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello",
          timestamp: 1700000000000,
          groupInfo: { groupId: "group123", type: "DELIVER" },
        },
      }),
    );

    expect(sendReactionSignal).toHaveBeenCalled();
  });

  it("uses account-level ackReaction emoji over global config", async () => {
    const deps = makeDeps({
      accountOverrides: { ackReaction: "🔥" },
      messages: { ackReaction: "👀", ackReactionScope: "all" },
    });
    const handler = createSignalEventHandler(deps);
    await handler(makeEvent());

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "+15550001111",
      1700000000000,
      "🔥",
      expect.any(Object),
    );
  });
});
