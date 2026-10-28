import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  signalAccountConfig as accountConfig,
  signalJsonServer,
  listenSignalServer as listen,
  type SignalRpcEnvelope,
} from "./signal-rpc.test-support.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

const { outboundAttachment, resolveOutboundAttachmentFromUrlMock, signalRpcRequestMock } =
  vi.hoisted(() => {
    const stagedAttachment = {
      path: "/tmp/image.png",
      contentType: "image/png" as string | undefined,
    };
    return {
      outboundAttachment: stagedAttachment,
      resolveOutboundAttachmentFromUrlMock: vi.fn(async (..._args: unknown[]) => ({
        path: stagedAttachment.path,
        contentType: stagedAttachment.contentType,
      })),
      signalRpcRequestMock: vi.fn(),
    };
  });

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

function sentAttachment(callIndex = 0): string {
  const params = signalRpcRequestMock.mock.calls[callIndex]?.[1] as
    | { attachments?: unknown }
    | undefined;
  const attachment = Array.isArray(params?.attachments) ? params.attachments[0] : undefined;
  if (typeof attachment !== "string") {
    throw new Error("Missing Signal attachment");
  }
  return attachment;
}

function inlineAttachmentBytes(attachment: string): Buffer {
  const marker = ";base64,";
  const markerAt = attachment.indexOf(marker);
  if (markerAt === -1) {
    throw new Error("Missing base64 marker");
  }
  return Buffer.from(attachment.slice(markerAt + marker.length), "base64");
}

async function withStagedPng(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "signal-send-"));
  const filePath = path.join(dir, "image.png");
  await writeFile(filePath, TINY_PNG);
  outboundAttachment.path = filePath;
  try {
    await run();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    outboundAttachment.path = "/tmp/image.png";
    outboundAttachment.contentType = "image/png";
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
    await withStagedPng(async () => {
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
      const attachment = sentAttachment();
      expect(attachment).toMatch(/^data:image\/png;filename=image\.png;base64,/);
      expect(inlineAttachmentBytes(attachment)).toEqual(TINY_PNG);
      expectSend(
        { attachments: [attachment], message: "" },
        { maxAttachmentBytes: maxBytes, transportKind: "external-native" },
      );
      expect(result).toMatchObject(receiptAt(1234567891));
      expect(result.receipt).toMatchObject({
        platformMessageIds: ["1234567891"],
        parts: [{ kind: "media", platformMessageId: "1234567891" }],
        raw: [{ chatId: "group-1", meta: { targetType: "group" } }],
      });
      expect(result.receipt.sentAt).toBeGreaterThan(0);
    });
  });

  it.each(["managed-native", "container"] as const)(
    "keeps the staged path for %s attachments",
    async (kind) => {
      signalRpcRequestMock.mockResolvedValueOnce({ timestamp: 1234567891 });

      await sendMessageSignal("group:group-1", "", {
        cfg: SIGNAL_TEST_CFG,
        transportKind: kind,
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp"],
      });

      expectSend({ attachments: ["/tmp/image.png"] }, { transportKind: kind });
    },
  );

  it("replays the same inline attachment when native quote metadata is rejected", async () => {
    signalRpcRequestMock
      .mockRejectedValueOnce(new Error("Signal RPC -32602: quote metadata invalid"))
      .mockResolvedValueOnce({ timestamp: 1234567892 });

    await withStagedPng(async () => {
      await sendMessageSignal("+15551234567", "caption", {
        cfg: SIGNAL_TEST_CFG,
        mediaUrl: "/tmp/image.png",
        replyToId: "1700000000001",
        replyToAuthor: "+15550002222",
        replyToBody: "original",
      });

      expect(signalRpcRequestMock).toHaveBeenCalledTimes(2);
      const first = sentAttachment(0);
      const second = sentAttachment(1);
      expect(second).toBe(first);
      expect(first).toMatch(/^data:image\/png;filename=image\.png;base64,/);
      expect(inlineAttachmentBytes(first)).toEqual(TINY_PNG);
      expect(signalRpcRequestMock.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          attachments: [first],
          quoteTimestamp: 1700000000001,
          quoteAuthor: "+15550002222",
        }),
      );
      expect(signalRpcRequestMock.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({ attachments: [first], message: "caption" }),
      );
      expect(signalRpcRequestMock.mock.calls[1]?.[1]).not.toHaveProperty("quoteTimestamp");
    });
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
