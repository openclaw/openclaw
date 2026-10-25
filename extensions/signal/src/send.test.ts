import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  signalAccountConfig as accountConfig,
  signalJsonServer,
  listenSignalServer as listen,
  type SignalRpcEnvelope,
} from "./signal-rpc.test-support.js";

const reactionStores = await vi.hoisted(() => import("./approval-reactions.test-support.js"));

const signalRpcRequestMock = vi.hoisted(() => vi.fn());
const resolveOutboundAttachmentFromUrlMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({ path: "/tmp/image.png", contentType: "image/png" })),
);

vi.mock("./client-adapter.js", () => ({
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
      resolveOutboundAttachmentFromUrlMock(...args),
  };
});

const { resolveSignalApprovalReactionTargetWithPersistence } =
  await import("./approval-reactions.js");
const { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } = await import("./send.js");

const SIGNAL_TEST_CFG = accountConfig("external-native", "http://signal.test");
const QUOTE = {
  replyToId: "1700000000001",
  replyToAuthor: "+15550002222",
  replyToBody: "original",
};
const recipient = "+15551234567";
const send = (text = "hello", options: Partial<Parameters<typeof sendMessageSignal>[2]> = {}) =>
  sendMessageSignal(recipient, text, { cfg: SIGNAL_TEST_CFG, ...options });
function expectSend(params: Record<string, unknown>, options: Record<string, unknown> = {}) {
  expect(signalRpcRequestMock).toHaveBeenCalledWith(
    "send",
    expect.objectContaining(params),
    expect.objectContaining(options),
  );
}

function receiptAt(timestamp: number) {
  return {
    messageId: String(timestamp),
    timestamp,
    receipt: { primaryPlatformMessageId: String(timestamp) },
  };
}

describe("sendMessageSignal receipts", () => {
  beforeEach(() => {
    reactionStores.clearSignalApprovalReactionStoresForTest();
    signalRpcRequestMock.mockReset();
    resolveOutboundAttachmentFromUrlMock.mockClear();
  });

  it("routes a named container account across send, typing, and receipt RPCs", async () => {
    signalRpcRequestMock.mockResolvedValue({ timestamp: 1234567890 });
    const cfg = accountConfig("container", "http://container:8080", "work");
    await sendMessageSignal("+15551234567", "hello", { cfg, accountId: "work" });
    await sendTypingSignal("+15551234567", { cfg, accountId: "work" });
    await sendReadReceiptSignal("+15551234567", 1234567890, { cfg, accountId: "work" });
    expect(signalRpcRequestMock).toHaveBeenCalledTimes(3);
    for (const call of signalRpcRequestMock.mock.calls) {
      expect(call[2]).toMatchObject({
        baseUrl: "http://container:8080",
        transportKind: "container",
      });
    }
  });

  it("sends username aliases through the canonical username parameter", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567890 });
    await sendMessageSignal("signal:u:ALICE.42", "hello", { cfg: SIGNAL_TEST_CFG });
    expectSend({ username: ["alice.42"] });
  });

  it("attaches a media receipt for attachment sends", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567891 });
    const maxBytes = 12 * 1024 * 1024;
    const result = await sendMessageSignal("group:group-1", "", {
      cfg: SIGNAL_TEST_CFG,
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp"],
      maxBytes,
    });
    expect(resolveOutboundAttachmentFromUrlMock).toHaveBeenCalledWith(
      "/tmp/image.png",
      maxBytes,
      expect.objectContaining({ localRoots: ["/tmp"] }),
    );
    expectSend({ attachments: ["/tmp/image.png"], message: "" }, { maxAttachmentBytes: maxBytes });
    expect(result).toMatchObject(receiptAt(1234567891));
    const raw = {
      channel: "signal",
      messageId: "1234567891",
      chatId: "group-1",
      timestamp: 1234567891,
      meta: { targetType: "group" },
    };
    const { platformMessageIds, parts, raw: rawResults } = result.receipt;
    expect({ platformMessageIds, parts, raw: rawResults }).toEqual({
      platformMessageIds: ["1234567891"],
      raw: [raw],
      parts: [{ index: 0, platformMessageId: "1234567891", kind: "media", raw }],
    });
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("does not invent platform ids when signal-cli omits a timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({});
    const result = await send();
    expect(result.messageId).toBe("unknown");
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });

  it("does not register ordinary outbound text that includes approval reaction snippets", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567894 });
    const text =
      "The docs show this example:\nExec approval required\nID: exec-live-approval\n\nReact with:\n👍 allow once\n👎 deny\n\nReply with: /approve exec-live-approval allow-once|deny";
    await send(text, {
      cfg: {
        ...SIGNAL_TEST_CFG,
        channels: {
          signal: {
            ...SIGNAL_TEST_CFG.channels.signal,
            allowFrom: ["+15551234567"],
          },
        },
        approvals: {
          exec: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "signal", to: "+15551234567" }],
          },
        },
      },
    });
    expectSend({ message: text });
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: "+15551234567",
        messageId: "1234567894",
        reactionKey: "👍",
        targetAuthor: "+15550001111",
      }),
    ).resolves.toBeNull();
  });

  it("passes native quote metadata when replying to a Signal timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567892 });
    const result = await send("hello", QUOTE);
    expect(signalRpcRequestMock).toHaveBeenCalledTimes(1);
    expectSend({
      quoteTimestamp: 1700000000001,
      quoteAuthor: "+15550002222",
      quoteMessage: "original",
    });
    expect(result.receipt.replyToId).toBe("1700000000001");
    expect(result.receipt.parts[0]?.replyToId).toBe("1700000000001");
    expect(result.receipt.raw?.[0]?.meta).toEqual({
      targetType: "recipient",
      replyToId: "1700000000001",
      nativeReplyStatus: "sent",
    });
  });

  it("does not retry an unconfirmed quote timeout", async () => {
    const message = "Signal HTTP timed out after 10000ms";
    signalRpcRequestMock.mockRejectedValueOnce(new Error(message));
    await expect(send("hello", QUOTE)).rejects.toThrow(message);
    expect(signalRpcRequestMock).toHaveBeenCalledTimes(1);
  });
});

describe("Signal quoted-message provider replay safety", () => {
  it.each([
    { label: "HTTP 429", transportKind: "container", status: 429, fallback: false },
    { label: "HTTP 400", transportKind: "container", status: 400, fallback: true },
    { label: "RPC -32603", transportKind: "external-native", rpcCode: -32603, fallback: false },
  ] as const)("replays a real $label request only after definitive rejection", async (testCase) => {
    const requests: SignalRpcEnvelope[] = [];
    const server = signalJsonServer((payload, _request, response) => {
      requests.push(payload);
      if (requests.length === 1) {
        if (testCase.transportKind === "container") {
          response.writeHead(testCase.status, { "content-type": "text/plain" });
          response.end("quote storage not found during upstream outage");
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              error: {
                code: testCase.rpcCode,
                message: "quote storage not found during upstream outage",
              },
            }),
          );
        }
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          testCase.transportKind === "container"
            ? { timestamp: 1700000000002 }
            : { jsonrpc: "2.0", id: payload.id, result: { timestamp: 1700000000002 } },
        ),
      );
    });
    const cfg = await listen(server, testCase.transportKind);
    vi.doUnmock("./client-adapter.js");
    vi.resetModules();
    const { sendMessageSignal: sendWithRealContainer } = await import("./send.js");

    try {
      const delivery = sendWithRealContainer("+15551234567", "deliver only once", {
        cfg,
        textMode: "plain",
        ...QUOTE,
      });
      if (testCase.fallback) {
        await expect(delivery).resolves.toMatchObject({ messageId: "1700000000002" });
      } else {
        const expectedError =
          testCase.transportKind === "container"
            ? `Signal REST ${testCase.status}`
            : `Signal RPC ${testCase.rpcCode}`;
        await expect(delivery).rejects.toThrow(expectedError);
      }
      expect(requests).toHaveLength(testCase.fallback ? 2 : 1);
      const quoteTimestampPath =
        testCase.transportKind === "container" ? "quote_timestamp" : "params.quoteTimestamp";
      expect(requests[0]).toHaveProperty(quoteTimestampPath, 1700000000001);
    } finally {
      await server[Symbol.asyncDispose]();
    }
  });
});

describe("Signal native JSON-RPC recipient delivery", () => {
  it("rejects real per-recipient failures and preserves successful send receipts", async () => {
    const failureType = "NETWORK_FAILURE";
    const responses: Array<{
      timestamp: number;
      results?: Array<{ type?: string; success?: boolean; message?: string }>;
    }> = [
      { timestamp: 1234567890, results: [{ type: failureType }] },
      {
        timestamp: 1234567890,
        results: [{ success: false, message: "recipient is not registered" }],
      },
      {
        timestamp: 1234567891,
        results: [{ type: "SUCCESS" }, { type: "UNREGISTERED_FAILURE" }],
      },
      {
        timestamp: 1234567892,
        results: [{ type: "NETWORK_FAILURE" }, { type: "UNREGISTERED_FAILURE" }],
      },
      { timestamp: 1234567893, results: [{ type: "SUCCESS" }] },
      { timestamp: 1234567894 },
    ];
    const requests: NonNullable<SignalRpcEnvelope["params"]>[] = [];
    const server = signalJsonServer((envelope, request, response) => {
      expect({
        method: request.method,
        path: request.url,
        contentType: request.headers["content-type"],
        jsonrpc: envelope.jsonrpc,
        rpcMethod: envelope.method,
        account: envelope.params?.account,
        message: envelope.params?.message,
      }).toEqual({
        method: "POST",
        path: "/api/v1/rpc",
        contentType: "application/json",
        jsonrpc: "2.0",
        rpcMethod: "send",
        account: "+15550001111",
        message: "hello over real rpc",
      });
      requests.push({ recipient: envelope.params?.recipient, groupId: envelope.params?.groupId });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result: responses.shift() }));
    });
    const cfg = await listen(server, "external-native");
    signalRpcRequestMock.mockClear();
    vi.doUnmock("./client-adapter.js");
    vi.resetModules();
    const { sendMessageSignal: sendMessageSignalWithRealRpc } = await import("./send.js");
    const sendTo = (to = "+15551234567") =>
      sendMessageSignalWithRealRpc(to, "hello over real rpc", { cfg });

    try {
      await expect(sendTo()).rejects.toThrow(`Signal send failed for 1 recipient: ${failureType}`);
      await expect(sendTo()).rejects.toThrow(
        "Signal send failed for 1 recipient: recipient is not registered",
      );

      await expect(sendTo("group:group-1")).resolves.toMatchObject(receiptAt(1234567891));
      await expect(sendTo("group:group-1")).rejects.toThrow(
        "Signal send failed for 2 recipients: NETWORK_FAILURE, UNREGISTERED_FAILURE",
      );

      await expect(sendTo()).resolves.toMatchObject(receiptAt(1234567893));
      await expect(sendTo()).resolves.toMatchObject(receiptAt(1234567894));

      expect(signalRpcRequestMock).not.toHaveBeenCalled();
      const expectedDirectRequest = {
        recipient: ["+15551234567"],
        groupId: undefined,
      };
      const expectedGroupRequest = {
        recipient: undefined,
        groupId: "group-1",
      };
      expect(requests).toEqual([
        expectedDirectRequest,
        expectedDirectRequest,
        expectedGroupRequest,
        expectedGroupRequest,
        expectedDirectRequest,
        expectedDirectRequest,
      ]);
      expect(responses).toHaveLength(0);
    } finally {
      await server[Symbol.asyncDispose]();
    }
  });
});
