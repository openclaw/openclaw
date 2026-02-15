import * as crypto from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as agentApi from "./agent/api-client.js";
import * as cryptoHelpers from "./crypto/index.js";
import {
  sendActiveMessage,
  handleWecomWebhookRequest,
  registerWecomWebhookTarget,
} from "./monitor.js";
import * as runtime from "./runtime.js";

const { undiciFetch } = vi.hoisted(() => {
  const undiciFetch = vi.fn();
  return { undiciFetch };
});

vi.mock("undici", () => ({
  fetch: undiciFetch,
  ProxyAgent: class ProxyAgent {},
}));

vi.mock("./agent/api-client.js", () => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
  uploadMedia: vi.fn(),
}));

// Helpers
function createMockRequest(bodyObj: any): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = "POST";
  req.url = "/wecom?timestamp=123&nonce=456&signature=789";
  req.push(JSON.stringify(bodyObj));
  req.push(null);
  return req;
}

function createMockResponse(): ServerResponse {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  res.end = vi.fn() as any;
  res.setHeader = vi.fn();
  (res as any).statusCode = 200;
  return res;
}

describe("Monitor Active Features", () => {
  let capturedDeliver: ((payload: { text: string }) => Promise<void>) | undefined;
  let mockCore: any;
  let msgSeq = 0;
  let senderUserId = "";
  let senderChatId = "";
  // Valid 32-byte AES Key (Base64 encoded)
  const validKey = "jWmYm7qr5nMoCAstdRmNjt3p7vsH8HkK+qiJqQ0aaaa=";

  beforeEach(() => {
    vi.useFakeTimers();
    capturedDeliver = undefined;
    vi.restoreAllMocks();
    undiciFetch.mockClear();
    msgSeq += 1;
    senderUserId = `zhangsan-${msgSeq}`;
    senderChatId = `wr123-${msgSeq}`;

    // Spy on crypto.randomBytes (default export in monitor.ts usage)
    vi.spyOn(crypto.default, "randomBytes").mockImplementation((size) => {
      return Buffer.alloc(size, 0x11);
    });

    // Mock Crypto Helpers
    // Wespy on verifyWecomSignature to always pass
    vi.spyOn(cryptoHelpers, "verifyWecomSignature").mockReturnValue(true);

    // We spy on decryptWecomEncrypted to return our mock plaintext
    // Note: For this to work despite direct import in monitor.ts, we rely on Vitest's
    // module mocking capabilities or the fact that * exports might be live bindings.
    // If this fails, we will know.
    vi.spyOn(cryptoHelpers, "decryptWecomEncrypted").mockImplementation((opts) => {
      return JSON.stringify({
        msgid: `test-msg-id-${msgSeq}`,
        aibotid: "bot-1",
        chattype: "group",
        chatid: senderChatId,
        from: { userid: senderUserId },
        msgtype: "text",
        text: { content: "hello" },
        response_url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
      });
    });

    mockCore = {
      channel: {
        text: {
          resolveMarkdownTableMode: () => "off",
          convertMarkdownTables: (t: string) => t.replace(/\|/g, "-"),
        },
        commands: {
          shouldComputeCommandAuthorized: () => false,
          resolveCommandAuthorizedFromAuthorizers: () => true,
        },
        pairing: {
          readAllowFromStore: async () => [],
        },
        reply: {
          finalizeInboundContext: (c: any) => c,
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: () => "",
          dispatchReplyWithBufferedBlockDispatcher: async (opts: any) => {
            capturedDeliver = opts.dispatcherOptions.deliver;
            return;
          },
        },
        routing: { resolveAgentRoute: () => ({ agentId: "1", sessionKey: "1", accountId: "1" }) },
        session: {
          resolveStorePath: () => "",
          readSessionUpdatedAt: () => 0,
          recordInboundSession: vi.fn(),
        },
      },
      logging: { shouldLogVerbose: () => false },
    };

    vi.spyOn(runtime, "getWecomRuntime").mockReturnValue(mockCore);

    registerWecomWebhookTarget({
      account: {
        accountId: "1",
        enabled: true,
        configured: true,
        token: "T",
        encodingAESKey: validKey,
        receiveId: "R",
        config: {} as any,
      },
      config: {
        channels: {
          wecom: {
            enabled: true,
            agent: {
              corpId: "corp",
              corpSecret: "secret",
              agentId: 1000002,
              token: "token",
              encodingAESKey: "aes",
            },
          },
        },
      } as any,
      runtime: { log: () => {} },
      core: mockCore,
      path: "/wecom",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should protect <think> tags from table conversion", async () => {
    const req = createMockRequest({ encrypt: "mock-encrypt" });
    const res = createMockResponse();
    await handleWecomWebhookRequest(req, res);

    // The WeCom monitor debounces inbound messages before starting the agent.
    // `flushPending` triggers async agent start without awaiting it, so give the
    // microtask queue a chance to run after the timer fires.
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedDeliver).toBeDefined();

    const payload = { text: "Out | side\n<think>Inside | Think</think>" };
    const convertSpy = vi.spyOn(mockCore.channel.text, "convertMarkdownTables");

    await capturedDeliver!(payload);

    const calledArg = convertSpy.mock.calls[0][0];
    expect(calledArg).toContain("__THINK_PLACEHOLDER_0__");
    expect(calledArg).not.toContain("<think>");
  });

  it("should store response_url and allow active message sending", async () => {
    const req = createMockRequest({ encrypt: "mock-encrypt" });
    const res = createMockResponse();

    // We use a real key but mocked randomBytes.
    // However, `handleWecomWebhookRequest` calls `buildEncryptedJsonReply` -> `encryptWecomPlaintext`.
    // `encryptWecomPlaintext` uses the key. Since it's valid, it should work fine.
    // We don't verify the OUTPUT of handleWecomWebhookRequest, just that it runs and sets up state.

    await handleWecomWebhookRequest(req, res);

    const streamId = Buffer.alloc(16, 0x11).toString("hex");

    undiciFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    await sendActiveMessage(streamId, "Active Hello");

    expect(undiciFetch).toHaveBeenCalledWith(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify({ msgtype: "text", text: { content: "Active Hello" } }),
      }),
    );
  });

  it("should fallback non-image media to agent DM (and push a Chinese prompt)", async () => {
    const { uploadMedia, sendMedia } = agentApi as any;
    uploadMedia.mockResolvedValue("media-id-1");
    sendMedia.mockResolvedValue(undefined);

    const req = createMockRequest({ encrypt: "mock-encrypt" });
    const res = createMockResponse();
    await handleWecomWebhookRequest(req, res);

    await vi.advanceTimersByTimeAsync(600);
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedDeliver).toBeDefined();

    // Create a local PDF to force non-image content-type inference.
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = path.join(os.tmpdir(), `wecom-test-${Date.now()}.pdf`);
    await fs.writeFile(tmp, Buffer.from("pdf"));

    undiciFetch.mockResolvedValue(new Response("ok", { status: 200 }));

    await capturedDeliver!({ text: "here", mediaUrls: [tmp] } as any);

    expect(uploadMedia).toHaveBeenCalled();
    expect(sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        toUser: senderUserId,
        mediaType: "file",
      }),
    );
    // Ensure we attempted to push a prompt to response_url (uses undici fetch).
    expect(undiciFetch).toHaveBeenCalled();
  });

  // 注：本机路径（/Users/... 或 /tmp/...）短路发图逻辑属于运行态特性，
  // 单测在 fake timers + module singleton 状态下容易引入脆弱性；这里优先覆盖更关键的兜底链路与去重逻辑。
});
