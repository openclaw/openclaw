import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  signalAccountConfig as accountConfig,
  signalJsonServer,
  listenSignalServer as listen,
  type SignalRpcEnvelope,
} from "./signal-rpc.test-support.js";

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

async function realRpc(
  kind: "container" | "external-native",
  respond: (payload: SignalRpcEnvelope, index: number, response: ServerResponse) => void,
) {
  const requests: SignalRpcEnvelope[] = [];
  const server = signalJsonServer((payload, _request, response) => {
    requests.push(payload);
    respond(payload, requests.length, response);
  });
  const cfg = await listen(server, kind);
  vi.doUnmock("./client-adapter.js");
  vi.resetModules();
  const { sendMessageSignal: sendReal } = await import("./send.js");
  return {
    requests,
    send: (to = recipient, options: Partial<Parameters<typeof sendReal>[2]> = {}) =>
      sendReal(to, "hello", { cfg, ...options }),
    [Symbol.asyncDispose]: () => server[Symbol.asyncDispose](),
  };
}

describe("sendMessageSignal receipts", () => {
  beforeEach(() => {
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
    expect(result.receipt).toMatchObject({
      platformMessageIds: ["1234567891"],
      parts: [{ kind: "media", platformMessageId: "1234567891" }],
      raw: [{ chatId: "group-1", meta: { targetType: "group" } }],
    });
    expect(result.receipt.sentAt).toBeGreaterThan(0);
  });

  it("does not invent platform ids when signal-cli omits a timestamp", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({});
    const result = await send();
    expect(result.messageId).toBe("unknown");
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });

  it("records native quote metadata on the delivered receipt", async () => {
    signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567892 });
    const result = await send("hello", QUOTE);
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

it.each([
  ["container", 429, false],
  ["container", 400, true],
  ["external-native", -32603, false],
] as const)("replays %s rejection %s only when definitive", async (kind, code, fallback) => {
  const message = "quote storage not found during upstream outage";
  await using rpc = await realRpc(kind, (payload, index, response) => {
    response.writeHead(kind === "container" && index === 1 ? code : 200);
    const body = index > 1 ? { timestamp: 1700000000002 } : message;
    response.end(
      kind === "container"
        ? typeof body === "string"
          ? body
          : JSON.stringify(body)
        : JSON.stringify({ jsonrpc: "2.0", id: payload.id, error: { code, message } }),
    );
  });
  const delivery = rpc.send(recipient, { textMode: "plain", ...QUOTE });
  if (fallback) {
    await expect(delivery).resolves.toMatchObject({ messageId: "1700000000002" });
  } else {
    await expect(delivery).rejects.toThrow(
      `Signal ${kind === "container" ? "REST" : "RPC"} ${code}`,
    );
  }
  expect(rpc.requests).toHaveLength(fallback ? 2 : 1);
  expect(rpc.requests[0]).toHaveProperty(
    kind === "container" ? "quote_timestamp" : "params.quoteTimestamp",
    1700000000001,
  );
});

it.each([
  ["typed failure", [{ type: "NETWORK_FAILURE" }], false, "1 recipient: NETWORK_FAILURE"],
  [
    "boolean failure",
    [{ success: false, message: "not registered" }],
    false,
    "1 recipient: not registered",
  ],
  [
    "partial group success",
    [{ type: "SUCCESS" }, { type: "UNREGISTERED_FAILURE" }],
    true,
    undefined,
  ],
  [
    "all group failures",
    [{ type: "NETWORK_FAILURE" }, { type: "UNREGISTERED_FAILURE" }],
    true,
    "2 recipients: NETWORK_FAILURE, UNREGISTERED_FAILURE",
  ],
  ["direct success", [{ type: "SUCCESS" }], false, undefined],
  ["legacy success", undefined, false, undefined],
] as const)("handles native recipient delivery: %s", async (_name, results, group, error) => {
  await using rpc = await realRpc("external-native", (payload, _index, response) => {
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: { timestamp: 1234567890, results },
      }),
    );
  });
  const delivery = rpc.send(group ? "group:group-1" : recipient);
  if (error) {
    await expect(delivery).rejects.toThrow(`Signal send failed for ${error}`);
  } else {
    await expect(delivery).resolves.toMatchObject(receiptAt(1234567890));
  }
  expect(rpc.requests).toMatchObject([
    {
      jsonrpc: "2.0",
      method: "send",
      params: {
        account: "+15550001111",
        message: "hello",
        ...(group ? { groupId: "group-1" } : { recipient: [recipient] }),
      },
    },
  ]);
  expect(rpc.requests[0]?.params).not.toHaveProperty(group ? "recipient" : "groupId");
});
