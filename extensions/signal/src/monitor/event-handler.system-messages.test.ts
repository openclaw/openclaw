import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

const { sendTypingMock, sendReadReceiptMock, dispatchInboundMessageMock } = vi.hoisted(() => ({
  sendTypingMock: vi.fn(),
  sendReadReceiptMock: vi.fn(),
  dispatchInboundMessageMock: vi.fn(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: sendTypingMock,
  sendReadReceiptSignal: sendReadReceiptMock,
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

vi.mock("../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

function makeDeps() {
  return createBaseSignalEventHandlerDeps({
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
    historyLimit: 0,
  });
}

describe("signal system message filtering", () => {
  beforeEach(() => {
    sendTypingMock.mockReset().mockResolvedValue(true);
    sendReadReceiptMock.mockReset().mockResolvedValue(true);
    dispatchInboundMessageMock.mockClear();
  });

  it("filters expiration timer update (expiresInSeconds, no text)", async () => {
    const handler = createSignalEventHandler(makeDeps());
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: null,
          attachments: [],
          expiresInSeconds: 604800,
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("filters expiration timer update with isExpirationUpdate flag", async () => {
    const handler = createSignalEventHandler(makeDeps());
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: null,
          attachments: [],
          isExpirationUpdate: true,
          expiresInSeconds: 604800,
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("filters groupV2Change messages", async () => {
    const handler = createSignalEventHandler(makeDeps());
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: null,
          attachments: [],
          groupV2Change: { editor: "+15550001111", changes: [] },
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("does NOT filter normal message with expiresInSeconds=0", async () => {
    const handler = createSignalEventHandler(makeDeps());
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello",
          attachments: [],
          expiresInSeconds: 0,
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );
    expect(dispatchInboundMessageMock).toHaveBeenCalled();
  });

  it("does NOT filter message with text even if expiresInSeconds > 0", async () => {
    const handler = createSignalEventHandler(makeDeps());
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello with timer",
          attachments: [],
          expiresInSeconds: 604800,
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );
    expect(dispatchInboundMessageMock).toHaveBeenCalled();
  });
});
