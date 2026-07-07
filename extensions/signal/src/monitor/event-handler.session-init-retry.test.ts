import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sleepMock: vi.fn(async () => undefined),
  logVerboseMock: vi.fn(),
  runtimeErrorMock: vi.fn(),
  dispatchInboundMessageMock: vi.fn(),
  recordInboundSessionMock: vi.fn(async () => undefined),
  sendTypingMock: vi.fn(async () => true),
  sendReadReceiptMock: vi.fn(async () => true),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    sleep: hoisted.sleepMock,
    logVerbose: hoisted.logVerboseMock,
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    dispatchInboundMessage: hoisted.dispatchInboundMessageMock,
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    recordInboundSession: hoisted.recordInboundSessionMock,
    readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
    upsertChannelPairingRequest: vi.fn(),
  };
});

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: hoisted.sendTypingMock,
  sendReadReceiptSignal: hoisted.sendReadReceiptMock,
}));

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
] = await Promise.all([import("./event-handler.test-harness.js"), import("./event-handler.js")]);

describe("signal reply session initialization retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.recordInboundSessionMock.mockResolvedValue(undefined);
    hoisted.sleepMock.mockResolvedValue(undefined);
    hoisted.dispatchInboundMessageMock
      .mockRejectedValueOnce(
        new Error(
          "reply session initialization conflicted for agent:main:signal:direct:+15550001111",
        ),
      )
      .mockResolvedValueOnce({ queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } });
  });

  it("retries one Signal inbound turn after a reply session initialization conflict", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: { messages: { inbound: { debounceMs: 0 } } } as never,
        historyLimit: 0,
        runtime: {
          log: vi.fn(),
          error: hoisted.runtimeErrorMock,
        } as never,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hello again",
          attachments: [],
        },
      }),
    );

    expect(hoisted.dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
    expect(hoisted.sleepMock).toHaveBeenCalledWith(200);
    expect(hoisted.logVerboseMock).toHaveBeenCalledWith(
      "signal inbound retry after reply session initialization conflict (1/2) delay=200ms",
    );
    expect(hoisted.runtimeErrorMock).not.toHaveBeenCalledWith(
      expect.stringContaining("signal debounce flush failed"),
    );
  });
});
