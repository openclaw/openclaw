import { createHmac } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the runtime and API before importing
vi.mock("./runtime.js", () => ({
  getGoHighLevelRuntime: () => ({
    logging: { shouldLogVerbose: () => false },
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          agentId: "default",
          accountId: "default",
          sessionKey: "test-session",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/test",
        readSessionUpdatedAt: () => undefined,
        recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockResolvedValue(undefined),
      },
      text: {
        chunkMarkdownText: (text: string) => [text],
        chunkMarkdownTextWithMode: (text: string) => [text],
        resolveChunkMode: () => "markdown",
      },
      pairing: {
        buildPairingReply: () => "pairing reply",
      },
      media: {
        fetchRemoteMedia: vi.fn(),
        saveMediaBuffer: vi.fn(),
      },
    },
  }),
}));

vi.mock("./api.js", () => ({
  sendGHLMessage: vi.fn().mockResolvedValue({ messageId: "msg-1" }),
}));

// Import after mocks
import { handleGoHighLevelWebhookRequest, registerGoHighLevelWebhookTarget } from "./monitor.js";

function createMockReq(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const { method = "POST", url = "/gohighlevel", headers = {}, body = "" } = options;
  const req = {
    method,
    url,
    headers: { ...headers, host: "localhost" },
    on: vi.fn((event: string, cb: (chunk?: Buffer) => void) => {
      if (event === "data" && body) {
        cb(Buffer.from(body));
      }
      if (event === "end") {
        cb();
      }
      return req;
    }),
    removeListener: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
    destroyed: false,
  } as unknown as IncomingMessage;
  return req;
}

function createMockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 200,
    _body: "",
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    end: vi.fn(function (this: { _body: string }, body?: string) {
      this._body = body ?? "";
    }),
  } as unknown as ServerResponse & { _status: number; _body: string };
  Object.defineProperty(res, "statusCode", {
    get() {
      return res._status;
    },
    set(v: number) {
      res._status = v;
    },
  });
  return res;
}

describe("handleGoHighLevelWebhookRequest", () => {
  const account = {
    accountId: "default",
    enabled: true,
    config: {
      dmPolicy: "open",
      webhookSecret: "test-secret",
    },
    credentialSource: "inline" as const,
    apiKey: "test-key",
    locationId: "loc-123",
  };

  let unregister: () => void;

  beforeEach(async () => {
    // Register a webhook target using the actual runtime mock
    const { getGoHighLevelRuntime } = vi.mocked(await import("./runtime.js"));
    unregister = registerGoHighLevelWebhookTarget({
      account: account as never,
      config: {} as never,
      runtime: { log: vi.fn(), error: vi.fn() },
      core: getGoHighLevelRuntime() as never,
      path: "/gohighlevel",
    });
  });

  it("returns false for unregistered paths", async () => {
    const req = createMockReq({ url: "/unknown" });
    const res = createMockRes();
    const handled = await handleGoHighLevelWebhookRequest(req, res);
    expect(handled).toBe(false);
  });

  it("rejects non-POST requests with 405", async () => {
    const req = createMockReq({ method: "GET" });
    const res = createMockRes();
    const handled = await handleGoHighLevelWebhookRequest(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(405);
  });

  it("rejects requests with invalid signature", async () => {
    const body = JSON.stringify({
      direction: "inbound",
      contactId: "c1",
      conversationId: "conv1",
      body: "hello",
    });
    const req = createMockReq({
      body,
      headers: { "x-ghl-signature": "invalid-sig" },
    });
    const res = createMockRes();
    const handled = await handleGoHighLevelWebhookRequest(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(401);
  });

  it("accepts requests with valid signature and returns 200", async () => {
    const body = JSON.stringify({
      direction: "inbound",
      contactId: "c1",
      conversationId: "conv1",
      body: "hello",
    });
    const signature = createHmac("sha256", "test-secret").update(body).digest("hex");
    const req = createMockReq({
      body,
      headers: { "x-ghl-signature": signature },
    });
    const res = createMockRes();
    const handled = await handleGoHighLevelWebhookRequest(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
  });

  it("rejects empty body", async () => {
    const req = createMockReq({ body: "" });
    const res = createMockRes();
    const handled = await handleGoHighLevelWebhookRequest(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const req = createMockReq({ body: "not json{" });
    const res = createMockRes();
    const handled = await handleGoHighLevelWebhookRequest(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
  });
});
