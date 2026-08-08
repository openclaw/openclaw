import { beforeEach, describe, expect, it, vi } from "vitest";

const deliveryMocks = vi.hoisted(() => ({
  deliverMatrixReplies: vi.fn(),
  sendTypingMatrix: vi.fn(),
}));

vi.mock("./replies.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./replies.js")>()),
  deliverMatrixReplies: deliveryMocks.deliverMatrixReplies,
}));

vi.mock("./handler-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./handler-runtime.js")>()),
  loadMatrixSendModule: async () => ({ sendTypingMatrix: deliveryMocks.sendTypingMatrix }),
}));

import { createMatrixReplyDispatcher } from "./handler-reply-dispatcher.js";

type MatrixDispatcherConfig = Parameters<typeof createMatrixReplyDispatcher>[0];

function createDispatcher() {
  const logVerboseMessage = vi.fn();
  const runtimeError = vi.fn();
  const client = {} as MatrixDispatcherConfig["client"];
  const draftController = {
    clearDraftConsumed: vi.fn(),
    advanceDraftBlockBoundary: vi.fn(),
    resetReplyToIdForNextBlock: vi.fn(),
    updateDraftFromLatestFullText: vi.fn(),
  } as unknown as MatrixDispatcherConfig["draftController"];
  const dispatcher = createMatrixReplyDispatcher({
    cfg: {},
    prefixOptions: { responsePrefixContextProvider: () => ({}) },
    humanDelay: undefined,
    typingCallbacks: { onReplyStart: async () => {} },
    streaming: "off",
    draftStream: undefined,
    draftController,
    client,
    roomId: "!room:example.org",
    runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
    textLimit: 4_000,
    replyToMode: "off",
    accountId: "default",
    mediaLocalRoots: [],
    tableMode: "code",
    logVerboseMessage,
  });

  return { client, dispatcher, draftController, logVerboseMessage, runtimeError };
}

describe("Matrix reply dispatcher block typing", () => {
  const acceptedDelivery = {
    messageIds: ["$accepted"],
    receipt: {
      primaryPlatformMessageId: "$accepted",
      platformMessageIds: ["$accepted"],
      parts: [{ platformMessageId: "$accepted", kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    visibleReplySent: true,
    content: "Already delivered block",
  };

  beforeEach(() => {
    deliveryMocks.deliverMatrixReplies.mockReset().mockResolvedValue(acceptedDelivery);
    deliveryMocks.sendTypingMatrix.mockReset().mockResolvedValue(undefined);
  });

  it("records a failed typing restart without failing or replaying the accepted block", async () => {
    const failure = new Error("Matrix homeserver typing endpoint unavailable");
    deliveryMocks.sendTypingMatrix.mockRejectedValueOnce(failure);
    const { client, dispatcher, draftController, logVerboseMessage, runtimeError } =
      createDispatcher();

    await expect(
      dispatcher.deliverReply({ text: "Already delivered block" }, { kind: "block" }),
    ).resolves.toBe(acceptedDelivery);

    expect(deliveryMocks.deliverMatrixReplies).toHaveBeenCalledOnce();
    expect(deliveryMocks.sendTypingMatrix).toHaveBeenCalledExactlyOnceWith(
      "!room:example.org",
      true,
      undefined,
      client,
    );
    expect(draftController.advanceDraftBlockBoundary).toHaveBeenCalledOnce();
    expect(logVerboseMessage).toHaveBeenCalledExactlyOnceWith(
      "matrix typing action=start failed target=!room:example.org: Error: Matrix homeserver typing endpoint unavailable",
    );
    expect(runtimeError).not.toHaveBeenCalled();
    expect(dispatcher.nonFinalReplyDeliveryFailed()).toBe(false);
  });

  it("does not log when block typing restarts successfully", async () => {
    const { dispatcher, logVerboseMessage } = createDispatcher();

    await expect(
      dispatcher.deliverReply({ text: "Already delivered block" }, { kind: "block" }),
    ).resolves.toBe(acceptedDelivery);

    expect(deliveryMocks.deliverMatrixReplies).toHaveBeenCalledOnce();
    expect(deliveryMocks.sendTypingMatrix).toHaveBeenCalledOnce();
    expect(logVerboseMessage).not.toHaveBeenCalled();
  });

  it("does not restart typing after a final delivery", async () => {
    const { dispatcher, logVerboseMessage } = createDispatcher();

    await expect(
      dispatcher.deliverReply({ text: "Already delivered block" }, { kind: "final" }),
    ).resolves.toBe(acceptedDelivery);

    expect(deliveryMocks.deliverMatrixReplies).toHaveBeenCalledOnce();
    expect(deliveryMocks.sendTypingMatrix).not.toHaveBeenCalled();
    expect(logVerboseMessage).not.toHaveBeenCalled();
  });
});
