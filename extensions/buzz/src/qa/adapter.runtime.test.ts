import {
  parseQaTarget,
  type QaBusInboundMessageInput,
  type QaBusMessage,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuzzInboundMessage } from "../message-event.js";
import { parseBuzzQaCredentialPayload } from "./credentials.js";

const credentials = parseBuzzQaCredentialPayload({
  relayUrl: "wss://relay.qa.example",
  roomId: "123e4567-e89b-42d3-a456-426614174000",
  driverPrivateKey: "01".repeat(32),
  sutPrivateKey: "02".repeat(32),
});

const {
  release,
  heartbeatStop,
  readBuzzQaCredentialFile,
  sendMessage,
  closeRelay,
  relayDriverState,
} = vi.hoisted(() => ({
  release: vi.fn(async () => {}),
  heartbeatStop: vi.fn(async () => {}),
  readBuzzQaCredentialFile: vi.fn(),
  sendMessage: vi.fn(async () => ({ eventId: "native-inbound", timestamp: 1_750_000_000_000 })),
  closeRelay: vi.fn(async () => {}),
  relayDriverState: {
    onMessage: undefined as
      | ((message: Omit<BuzzInboundMessage, "kind" | "diff">) => Promise<void>)
      | undefined,
  },
}));
const acquireQaCredentialLease = vi.fn(async (_options: unknown) => ({
  source: "env" as const,
  kind: "buzz",
  payload: credentials,
  heartbeatIntervalMs: 0,
  leaseTtlMs: 0,
  heartbeat: vi.fn(async () => {}),
  release,
}));
vi.mock("./relay-client.js", () => ({
  createBuzzQaRelayDriver: async (params: {
    onMessage: NonNullable<typeof relayDriverState.onMessage>;
  }) => {
    relayDriverState.onMessage = params.onMessage;
    return {
      assertHealthy: vi.fn(),
      close: closeRelay,
      sendMessage,
    };
  },
}));

vi.mock("./credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials.js")>()),
  readBuzzQaCredentialFile,
}));

import { createBuzzQaTransportAdapter } from "./adapter.runtime.js";

const credentialHost: Parameters<typeof createBuzzQaTransportAdapter>[0]["credentials"] = {
  acquire: async (options) => (await acquireQaCredentialLease(options)) as never,
  startHeartbeat: () => ({ getFailure: () => null, stop: heartbeatStop, throwIfFailed: vi.fn() }),
};

type AdapterContext = Parameters<typeof createBuzzQaTransportAdapter>[0];

function createMessages() {
  let inboundIndex = 0;
  let outboundIndex = 0;
  return {
    addInboundMessage: vi.fn(async (input: QaBusInboundMessageInput): Promise<QaBusMessage> => ({
      ...input,
      id: ++inboundIndex === 1 ? "bus-inbound" : `bus-inbound-${inboundIndex}`,
      accountId: input.accountId ?? "sut",
      direction: "inbound",
      timestamp: input.timestamp ?? 1_750_000_000_000,
      reactions: [],
    })),
    addOutboundMessage: vi.fn(
      async (input: Parameters<AdapterContext["messages"]["addOutboundMessage"]>[0]) => {
        const target = parseQaTarget(input.to);
        return {
          ...input,
          id: `bus-outbound-${++outboundIndex}`,
          direction: "outbound" as const,
          conversation: { id: target.conversationId, kind: target.chatType },
        };
      },
    ),
    editMessage: vi.fn(),
  };
}
let messages: ReturnType<typeof createMessages>;

const inbound = {
  accountId: "sut",
  conversation: { id: "main", kind: "channel" as const },
  senderId: "driver",
  senderName: "QA Driver",
  text: "@openclaw root",
};

async function emitRelay(
  overrides: Partial<Parameters<NonNullable<typeof relayDriverState.onMessage>>[0]>,
) {
  await relayDriverState.onMessage?.({
    id: "native-sut-reply",
    senderPubkey: credentials.sutPublicKey,
    text: "fast reply",
    channelId: credentials.roomId,
    createdAt: 1_750_000_000,
    mentionedPubkeys: [],
    ...overrides,
  });
}

function createAdapter(adapterOptions: AdapterContext["adapterOptions"]) {
  return createBuzzQaTransportAdapter({
    adapterOptions,
    channelId: "buzz",
    credentials: credentialHost,
    driver: "live",
    messages,
    outputDir: ".artifacts/qa-e2e/buzz",
  });
}

describe("Buzz QA transport adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messages = createMessages();
    relayDriverState.onMessage = undefined;
    sendMessage.mockResolvedValue({
      eventId: "native-inbound",
      timestamp: 1_750_000_000_000,
    });
    readBuzzQaCredentialFile.mockResolvedValue(credentials);
  });

  it("uses private file credentials by default", async () => {
    const options = {
      credentialFile: "private/buzz-qa.json",
      repoRoot: "/repo",
    };
    await createAdapter(options);
    expect(readBuzzQaCredentialFile).toHaveBeenCalledWith({
      filePath: options.credentialFile,
      repoRoot: options.repoRoot,
    });
    expect(acquireQaCredentialLease).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "buzz", source: "env" }),
    );
  });

  it("delegates the profile credential source to the shared manager", async () => {
    const adapter = await createAdapter({});

    try {
      expect(readBuzzQaCredentialFile).not.toHaveBeenCalled();
      expect(acquireQaCredentialLease).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "buzz", source: undefined }),
      );
    } finally {
      await adapter.cleanup?.();
      await adapter.cleanupAfterGatewayStop?.();
    }
  });

  it("sends a portable mentioned message through the native Buzz relay driver", async () => {
    const { addInboundMessage } = messages;
    const adapter = await createAdapter({ credentialSource: "convex", sutAccountId: "sut" });

    const text = "@openclaw reply exactly: QA-CHANNEL-CANARY-OK";
    const message = await adapter.sendInbound({
      ...inbound,
      text,
      conversation: { id: "qa-routing-primary", kind: "group" },
    });

    expect(sendMessage).toHaveBeenCalledWith({
      mentionSut: true,
      text,
    });
    expect(addInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "sut",
        senderId: credentials.driverPublicKey,
        timestamp: 1_750_000_000_000,
      }),
    );
    expect(message.id).toBe("bus-inbound");

    const gateway = {
      call: vi.fn(async () => ({
        channelAccounts: { buzz: [{ accountId: "default", running: true }] },
      })),
    };
    await adapter.waitReady({ gateway });
    expect(gateway.call).toHaveBeenCalledWith(
      "channels.status",
      { probe: false, timeoutMs: 2_000 },
      { timeoutMs: 5_000 },
    );
  });

  it("maps native Buzz reply relations back to portable thread ids", async () => {
    const { addOutboundMessage } = messages;
    sendMessage
      .mockResolvedValueOnce({ eventId: "native-root", timestamp: 1_750_000_000_000 })
      .mockResolvedValueOnce({ eventId: "native-follow-up", timestamp: 1_750_000_001_000 });
    const adapter = await createAdapter({ credentialSource: "convex", sutAccountId: "sut" });

    const root = await adapter.sendInbound(inbound);
    await emitRelay({
      id: "native-sut-root",
      text: "root reply",
      threadId: "native-root",
      replyToId: "native-root",
    });
    const followUp = await adapter.sendInbound({
      ...inbound,
      text: "@openclaw follow-up",
      threadId: root.id,
    });
    await emitRelay({
      id: "native-sut-follow-up",
      text: "thread reply",
      createdAt: 1_750_000_001,
      threadId: "native-root",
      replyToId: "native-follow-up",
    });

    expect(sendMessage).toHaveBeenLastCalledWith({
      mentionSut: true,
      text: "@openclaw follow-up",
      threadId: "native-root",
    });
    expect(addOutboundMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        to: "channel:main",
        threadId: root.id,
        replyToId: followUp.id,
      }),
    );
  });

  it("waits for a racing inbound id mapping before recording reply relations", async () => {
    let releaseInbound = () => {};
    const inboundGate = new Promise<void>((resolve) => {
      releaseInbound = resolve;
    });
    const { addInboundMessage, addOutboundMessage } = messages;
    const recordInbound = addInboundMessage.getMockImplementation()!;
    addInboundMessage.mockImplementationOnce(async (input) => {
      await inboundGate;
      return recordInbound(input);
    });
    const adapter = await createAdapter({ credentialSource: "convex", sutAccountId: "sut" });

    const inboundPromise = adapter.sendInbound({
      ...inbound,
      conversation: { id: "main", kind: "group" },
    });
    await vi.waitFor(() => expect(addInboundMessage).toHaveBeenCalledOnce());
    const outboundPromise = emitRelay({
      threadId: "native-inbound",
      replyToId: "native-inbound",
    });
    expect(addOutboundMessage).not.toHaveBeenCalled();

    releaseInbound();
    await inboundPromise;
    await outboundPromise;

    expect(addOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "bus-inbound",
        replyToId: "bus-inbound",
      }),
    );
  });

  it("closes relay observation before stopping and releasing the credential lease", async () => {
    const adapter = await createAdapter({ credentialSource: "convex" });

    await adapter.cleanup?.();
    await adapter.cleanupAfterGatewayStop?.();

    expect(closeRelay).toHaveBeenCalledOnce();
    expect(heartbeatStop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(closeRelay.mock.invocationCallOrder[0]).toBeLessThan(
      heartbeatStop.mock.invocationCallOrder[0] ?? 0,
    );
    expect(heartbeatStop.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
