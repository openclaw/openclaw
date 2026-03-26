/**
 * Tests for Signal emoji reaction handling.
 *
 * When a remote user reacts to a message with an emoji (👍, ❤️, etc.),
 * signal-cli sends a dataMessage with a `reaction` field. These should be
 * surfaced as system events to the agent session (matching Discord's pattern)
 * rather than leaking through as <media:unknown>.
 *
 * Two paths:
 * 1. Well-formed reactions (isSignalReactionMessage returns true) →
 *    handled by existing handleReactionOnlyInbound
 * 2. Bare/malformed reactions (isSignalReactionMessage returns false,
 *    e.g. targetAuthor absent) → new hasBareReactionField guard surfaces
 *    as system event
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchInboundMessageMock, enqueueSystemEventMock } = vi.hoisted(() => ({
  dispatchInboundMessageMock: vi.fn().mockResolvedValue({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  }),
  enqueueSystemEventMock: vi.fn(),
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn().mockResolvedValue(true),
  sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../../src/auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("../../../../src/infra/system-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/infra/system-events.js")>();
  return {
    ...actual,
    enqueueSystemEvent: enqueueSystemEventMock,
  };
});

vi.mock("../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

let createSignalEventHandler: typeof import("./event-handler.js").createSignalEventHandler;
let createBaseSignalEventHandlerDeps: typeof import("./event-handler.test-harness.js").createBaseSignalEventHandlerDeps;
let createSignalReceiveEvent: typeof import("./event-handler.test-harness.js").createSignalReceiveEvent;

describe("signal createSignalEventHandler emoji reaction handling", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ createSignalEventHandler } = await import("./event-handler.js"));
    ({ createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
      await import("./event-handler.test-harness.js"));
  });

  beforeEach(() => {
    dispatchInboundMessageMock.mockClear();
    enqueueSystemEventMock.mockClear();
  });

  it("drops a well-formed reaction envelope via handleReactionOnlyInbound", async () => {
    const deps = createBaseSignalEventHandlerDeps({
      isSignalReactionMessage: (r): r is NonNullable<typeof r> =>
        Boolean(r?.emoji && r?.targetSentTimestamp && (r?.targetAuthor || r?.targetAuthorUuid)),
    });
    const handler = createSignalEventHandler(deps);

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          timestamp: 1700000000000,
          message: "",
          reaction: {
            emoji: "👍",
            isRemove: false,
            targetAuthor: "+15550001111",
            targetSentTimestamp: 1699999000000,
          },
        },
      }),
    );

    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("surfaces a bare reaction (missing targetAuthor) as a system event", async () => {
    // isSignalReactionMessage returns false (default harness) → bare reaction guard kicks in
    const deps = createBaseSignalEventHandlerDeps({
      reactionMode: "all",
      shouldEmitSignalReactionNotification: () => true,
      buildSignalReactionSystemEventText: (params) =>
        `Signal reaction added: ${params.emojiLabel} by ${params.actorLabel} msg ${params.messageId}`,
    });
    const handler = createSignalEventHandler(deps);

    await handler(
      createSignalReceiveEvent({
        sourceName: "Alice",
        dataMessage: {
          timestamp: 1700000000000,
          message: "",
          reaction: {
            emoji: "👍",
            isRemove: false,
            // targetAuthor / targetAuthorUuid deliberately absent
            targetSentTimestamp: 1699999000000,
          },
        },
      }),
    );

    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("👍"),
      expect.objectContaining({
        contextKey: expect.stringContaining("reaction"),
      }),
    );
  });

  it("includes targetSentTimestamp in system event text when available", async () => {
    const capturedText: string[] = [];
    const deps = createBaseSignalEventHandlerDeps({
      reactionMode: "all",
      shouldEmitSignalReactionNotification: () => true,
      buildSignalReactionSystemEventText: (params) => {
        const text = `Signal reaction added: ${params.emojiLabel} by ${params.actorLabel} msg ${params.messageId}`;
        capturedText.push(text);
        return text;
      },
    });
    const handler = createSignalEventHandler(deps);

    await handler(
      createSignalReceiveEvent({
        sourceName: "Alice",
        dataMessage: {
          timestamp: 1700000000000,
          message: "",
          reaction: {
            emoji: "❤️",
            isRemove: false,
            targetSentTimestamp: 1699999000000,
          },
        },
      }),
    );

    expect(capturedText[0]).toContain("1699999000000");
  });

  it("drops a bare reaction-removal (isRemove: true) silently", async () => {
    const deps = createBaseSignalEventHandlerDeps();
    const handler = createSignalEventHandler(deps);

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          timestamp: 1700000000000,
          message: "",
          reaction: {
            emoji: "👍",
            isRemove: true,
            targetSentTimestamp: 1699999000000,
          },
        },
      }),
    );

    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("handles a bare reaction that arrives with a null-contentType attachment (signal-cli thumbnail)", async () => {
    const deps = createBaseSignalEventHandlerDeps({
      reactionMode: "all",
      shouldEmitSignalReactionNotification: () => true,
      buildSignalReactionSystemEventText: (params) =>
        `Signal reaction added: ${params.emojiLabel} by ${params.actorLabel}`,
    });
    const handler = createSignalEventHandler(deps);

    await handler(
      createSignalReceiveEvent({
        sourceName: "Alice",
        dataMessage: {
          timestamp: 1700000000000,
          message: "",
          reaction: {
            emoji: "👍",
            isRemove: false,
            targetSentTimestamp: 1699999000000,
          },
          attachments: [{ id: "thumb1", contentType: null, size: 0 }],
        },
      }),
    );

    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("👍"),
      expect.objectContaining({ contextKey: expect.stringContaining("reaction") }),
    );
  });

  it("does NOT intercept a reaction envelope that also has message text", async () => {
    const deps = createBaseSignalEventHandlerDeps();
    const handler = createSignalEventHandler(deps);

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          timestamp: 1700000000000,
          message: "hello",
          reaction: {
            emoji: "👍",
            isRemove: false,
            targetSentTimestamp: 1699999000000,
          },
        },
      }),
    );

    // Message has body text — should be dispatched normally
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT intercept a plain message without a reaction field", async () => {
    const deps = createBaseSignalEventHandlerDeps();
    const handler = createSignalEventHandler(deps);

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          timestamp: 1700000000000,
          message: "hey there",
        },
      }),
    );

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  });
});
