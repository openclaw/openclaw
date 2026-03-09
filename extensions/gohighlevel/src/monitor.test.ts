import { createHmac } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { GoHighLevelAccountSchemaBase } from "./config-schema.js";

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

describe("escalation config schema", () => {
  it("accepts escalation config with custom patterns and tag", () => {
    const result = GoHighLevelAccountSchemaBase.safeParse({
      escalation: {
        enabled: true,
        tag: "needs-human",
        patterns: ["please hold", "transferring you"],
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.escalation?.tag).toBe("needs-human");
      expect(result.data.escalation?.patterns).toEqual(["please hold", "transferring you"]);
    }
  });

  it("defaults escalation.enabled to true when omitted", () => {
    const result = GoHighLevelAccountSchemaBase.safeParse({
      escalation: { tag: "custom-tag" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.escalation?.enabled).toBe(true);
    }
  });

  it("allows disabling escalation", () => {
    const result = GoHighLevelAccountSchemaBase.safeParse({
      escalation: { enabled: false },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.escalation?.enabled).toBe(false);
    }
  });

  it("accepts config without escalation section", () => {
    const result = GoHighLevelAccountSchemaBase.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.escalation).toBeUndefined();
    }
  });

  it("rejects unknown fields inside escalation", () => {
    const result = GoHighLevelAccountSchemaBase.safeParse({
      escalation: { unknown: true },
    });
    expect(result.success).toBe(false);
  });
});

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

  it("accepts real GHL Workflow payload with nested message.body", async () => {
    // Real GHL Workflow payloads nest the body under `message.body` and
    // include `customData` with configured fields — top-level `body` is NOT set.
    const workflowPayload = {
      contact_id: "dbSKd404POvJ6ZSyRSlX",
      first_name: "Rakesh",
      last_name: "Parikatil",
      full_name: "Rakesh Parikatil",
      phone: "+13238287989",
      email: "rparikatil@yahoo.com",
      tags: "lead-type-adult,junior-advanced",
      contact_type: "lead",
      location: { name: "LBTA", id: "loc-123" },
      message: { type: 2, body: "Yes" },
      workflow: { id: "d64c0407", name: "Customer Replied Webhook" },
      customData: { event_type: "customer.replied", body: "Yes" },
    };
    const body = JSON.stringify(workflowPayload);
    const signature = createHmac("sha256", "test-secret").update(body).digest("hex");
    const req = createMockReq({
      body,
      headers: { "x-ghl-signature": signature },
    });
    const res = createMockRes();
    const handled = await handleGoHighLevelWebhookRequest(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._body).toBe("{}");
  });
});
