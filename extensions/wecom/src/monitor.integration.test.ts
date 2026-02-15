import crypto from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encryptWecomPlaintext,
  computeWecomMsgSignature,
  WECOM_PKCS7_BLOCK_SIZE,
} from "./crypto/index.js";
import { handleWecomWebhookRequest, registerWecomWebhookTarget } from "./monitor.js";
import * as runtime from "./runtime.js";

const { undiciFetch } = vi.hoisted(() => {
  const undiciFetch = vi.fn();
  return { undiciFetch };
});

vi.mock("undici", () => ({
  fetch: undiciFetch,
  ProxyAgent: class ProxyAgent {},
}));

// Helpers to simulate HTTP request
function createMockRequest(bodyObj: any, query: URLSearchParams): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = "POST";
  req.url = `/wecom?${query.toString()}`;
  req.push(JSON.stringify(bodyObj));
  req.push(null);
  return req;
}

function createMockResponse(): ServerResponse & {
  _getData: () => string;
  _getStatusCode: () => number;
} {
  const req = new IncomingMessage(new Socket());
  const res = new ServerResponse(req);
  let data = "";
  res.write = (chunk: any) => {
    data += chunk;
    return true;
  };
  res.end = (chunk: any) => {
    if (chunk) data += chunk;
    return res;
  };
  (res as any)._getData = () => data;
  (res as any)._getStatusCode = () => res.statusCode;
  return res as any;
}

// PKCS7 Pad Helper for manual encryption
function pkcs7Pad(buf: Buffer, blockSize: number): Buffer {
  const mod = buf.length % blockSize;
  const pad = mod === 0 ? blockSize : blockSize - mod;
  const padByte = Buffer.from([pad]);
  return Buffer.concat([buf, Buffer.alloc(pad, padByte[0]!)]);
}

describe("Monitor Integration: Inbound Image", () => {
  const token = "MY_TOKEN";
  const encodingAESKey = "jWmYm7qr5nMoCAstdRmNjt3p7vsH8HkK+qiJqQ0aaaa="; // 32 bytes key
  const receiveId = "MY_CORPID";
  let unregisterTarget: (() => void) | null = null;

  // Mock Core Runtime
  const mockDeliver = vi.fn();
  const mockCore = {
    channel: {
      routing: {
        resolveAgentRoute: () => ({ agentId: "agent-1", sessionKey: "sess-1", accountId: "acc-1" }),
      },
      commands: {
        shouldComputeCommandAuthorized: () => false,
        resolveCommandAuthorizedFromAuthorizers: () => true,
      },
      pairing: {
        readAllowFromStore: async () => [],
      },
      session: {
        resolveStorePath: () => "store/path",
        readSessionUpdatedAt: () => 0,
        recordInboundSession: vi.fn(),
      },
      reply: {
        formatAgentEnvelope: () => "formatted-body",
        finalizeInboundContext: (ctx: any) => ctx,
        resolveEnvelopeFormatOptions: () => ({}),
        dispatchReplyWithBufferedBlockDispatcher: async (opts: any) => {
          // Simulate Agent processing by calling deliver immediately or later
          // For this test, verifying the Inbound Body is enough.
          // The delivery payload is what the AGENT sees.
          // But wait, dispatchReply... is for OUTBOUND streaming replies.
          // startAgentForStream calls it.
          // We really want to spy on what `rawBody` was passed to startAgentForStream context.

          // Actually `recordInboundSession` receives `ctx` which contains `RawBody`.
          return;
        },
      },
      text: { resolveMarkdownTableMode: () => "off", convertMarkdownTables: (t: string) => t },
    },
    logging: { shouldLogVerbose: () => true },
  };

  beforeEach(() => {
    vi.spyOn(runtime, "getWecomRuntime").mockReturnValue(mockCore as any);

    unregisterTarget?.();
    unregisterTarget = registerWecomWebhookTarget({
      account: {
        accountId: "test-acc",
        name: "Test",
        enabled: true,
        configured: true,
        token,
        encodingAESKey,
        receiveId,
        config: {} as any,
      },
      config: {} as any,
      runtime: { log: console.log, error: console.error },
      core: mockCore as any,
      path: "/wecom",
    });
  });

  afterEach(() => {
    unregisterTarget?.();
    unregisterTarget = null;
    vi.restoreAllMocks();
  });

  // Mock media saving
  const mockSaveMediaBuffer = vi
    .fn()
    .mockResolvedValue({ path: "/tmp/saved-image.jpg", contentType: "image/jpeg" });
  (mockCore.channel as any).media = { saveMediaBuffer: mockSaveMediaBuffer };

  it("should decrypt inbound image, save it, and inject into context", async () => {
    // 1. Prepare Encrypted Media (The "File" on WeCom Server)
    const fileContent = Buffer.from("fake-image-data");
    const aesKey = Buffer.from(encodingAESKey + "=", "base64");
    const iv = aesKey.subarray(0, 16);

    // Encrypt content (WeCom does this)
    const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
    cipher.setAutoPadding(false);
    const encryptedMedia = Buffer.concat([
      cipher.update(pkcs7Pad(fileContent, WECOM_PKCS7_BLOCK_SIZE)),
      cipher.final(),
    ]);

    // Mock HTTP fetch to return this encrypted media
    undiciFetch.mockResolvedValue(new Response(encryptedMedia));

    // 2. Prepare Inbound Message (The Webhook JSON)
    const imageUrl = "http://wecom.server/media/123";
    const inboundMsg = {
      msgtype: "image",
      image: { url: imageUrl },
      from: { userid: "yanhaidao" },
    };

    // 3. Encrypt the *Inbound Message* Payload (The Envelope)
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "123456";
    const encrypt = encryptWecomPlaintext({
      encodingAESKey,
      receiveId,
      plaintext: JSON.stringify(inboundMsg),
    });
    const msgSignature = computeWecomMsgSignature({ token, timestamp, nonce, encrypt });

    const query = new URLSearchParams({
      msg_signature: msgSignature,
      timestamp,
      nonce,
    });

    const bodyObj = {
      touser: receiveId,
      agentid: "10001",
      encrypt, // Standard WeCom POST body structure
    };

    // 4. Send Request
    const req = createMockRequest(bodyObj, query);
    const res = createMockResponse();

    await handleWecomWebhookRequest(req, res);

    // Wait for debounce timer to trigger agent (DEFAULT_DEBOUNCE_MS = 500ms)
    await new Promise((resolve) => setTimeout(resolve, 600));

    // 5. Verify
    // Check recordInboundSession was called with correct RawBody and Media Context
    expect(mockCore.channel.session.recordInboundSession).toHaveBeenCalled();
    const recordCall = (mockCore.channel.session.recordInboundSession as any).mock.calls[0][0];
    const ctx = recordCall.ctx;

    // Expect: [image]
    expect(ctx.RawBody).toBe("[image]");

    // Expect media to be saved
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer), // The decrypted buffer
      "image/jpeg",
      "inbound",
      expect.any(Number), // maxBytes
      "image.jpg",
    );
    const savedBuffer = mockSaveMediaBuffer.mock.calls[0][0];
    expect(savedBuffer.toString()).toBe("fake-image-data");

    // Expect Context Injection
    expect(ctx.MediaPath).toBe("/tmp/saved-image.jpg");
    expect(ctx.MediaType).toBe("image/jpeg");

    expect(undiciFetch).toHaveBeenCalledWith(
      imageUrl,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});
