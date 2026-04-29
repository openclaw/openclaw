import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventType } from "@ag-ui/core";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@ag-ui/encoder", () => ({
  EventEncoder: vi.fn().mockImplementation(() => ({
    getContentType: () => "text/event-stream",
    encode: (event: unknown) => `data: ${JSON.stringify(event)}\n\n`,
  })),
}));

vi.mock("openclaw/plugin-sdk", () => ({
  emptyPluginConfigSchema: () => ({}),
}));

import { createAguiHttpHandler } from "./http-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReq(
  overrides: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): IncomingMessage & EventEmitter {
  const emitter = new EventEmitter() as IncomingMessage & EventEmitter;
  Object.assign(emitter, {
    method: overrides.method ?? "POST",
    url: "/v1/clawg-ui",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      ...overrides.headers,
    },
    destroy: vi.fn(),
  });

  // Simulate body streaming
  const bodyStr =
    overrides.body !== undefined ? JSON.stringify(overrides.body) : undefined;
  if (bodyStr !== undefined) {
    process.nextTick(() => {
      emitter.emit("data", Buffer.from(bodyStr));
      emitter.emit("end");
    });
  }

  return emitter as IncomingMessage & EventEmitter;
}

function createRes(): ServerResponse & {
  _chunks: string[];
  _headers: Record<string, string>;
  _ended: boolean;
} {
  const res = {
    statusCode: 200,
    _chunks: [] as string[],
    _headers: {} as Record<string, string>,
    _ended: false,
    setHeader(name: string, value: string) {
      res._headers[name.toLowerCase()] = value;
    },
    flushHeaders() {},
    write(chunk: string) {
      res._chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) {
        res._chunks.push(chunk);
      }
      res._ended = true;
    },
  };
  return res as unknown as ServerResponse & {
    _chunks: string[];
    _headers: Record<string, string>;
    _ended: boolean;
  };
}

function parseEvents(
  chunks: string[],
): Array<{ type: string; [key: string]: unknown }> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      const match = line.match(/^data:\s*(.+)$/);
      if (match?.[1]) {
        try {
          events.push(JSON.parse(match[1]));
        } catch {
          /* skip */
        }
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// HMAC token utilities (duplicated from http-handler for testing)
// ---------------------------------------------------------------------------

import { createHmac } from "node:crypto";

function createDeviceToken(secret: string, deviceId: string): string {
  const encodedId = Buffer.from(deviceId).toString("base64url");
  const signature = createHmac("sha256", secret).update(deviceId).digest("hex").slice(0, 32);
  return `${encodedId}.${signature}`;
}

// ---------------------------------------------------------------------------
// Fake plugin API + runtime
// ---------------------------------------------------------------------------

function createFakeApi(
  approvedDevices: string[] = [],
  options: { pairingCode?: string } = {},
) {
  const { pairingCode = "TEST1234" } = options;

  const dispatchReplyFromConfig = vi.fn().mockResolvedValue({
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  });

  const upsertPairingRequest = vi.fn().mockResolvedValue({
    code: pairingCode,
  });

  const readAllowFromStore = vi.fn().mockResolvedValue(approvedDevices);

  return {
    config: { gateway: { auth: { token: "test-gateway-secret" } } },
    runtime: {
      config: {
        loadConfig: () => ({
          session: { store: "/tmp/test-sessions" },
        }),
      },
      channel: {
        routing: {
          resolveAgentRoute: vi.fn().mockReturnValue({
            sessionKey: "agui:test-session",
            agentId: "main",
            accountId: "default",
          }),
        },
        session: {
          resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store"),
          readSessionUpdatedAt: vi.fn().mockReturnValue(undefined),
          recordInboundSession: vi.fn().mockResolvedValue(undefined),
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn().mockReturnValue({}),
          formatAgentEnvelope: vi
            .fn()
            .mockImplementation(({ body }: { body: string }) => body),
          finalizeInboundContext: vi
            .fn()
            .mockImplementation((ctx: Record<string, unknown>) => ctx),
          dispatchReplyFromConfig,
        },
        pairing: {
          upsertPairingRequest,
          readAllowFromStore,
        },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const GATEWAY_SECRET = "test-gateway-secret";
const APPROVED_DEVICE_ID = "12345678-1234-1234-1234-123456789abc";

describe("AG-UI HTTP handler", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set env token before handler creation so the factory can resolve it
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
    // Create fake API with the approved device
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as any);
  });

  it("rejects non-POST with 405", async () => {
    const req = createReq({ method: "GET" });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("rejects invalid bearer token with 401", async () => {
    const req = createReq({
      headers: { authorization: "Bearer invalid.token" },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns empty run for messages with only system role", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "system", content: "sys" }],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const events = parseEvents(res._chunks);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
  });

  it("returns empty run for empty messages array (AG-UI session init)", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-empty",
        runId: "r-empty",
        messages: [],
      },
    });
    const res = createRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const events = parseEvents(res._chunks);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.RUN_FINISHED,
    ]);
    expect(events[0].threadId).toBe("t-empty");
    expect(events[0].runId).toBe("r-empty");
  });

  it("accepts tool-only messages (tool result submission)", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-tool-only",
        runId: "r-tool-only",
        messages: [
          { role: "tool", toolCallId: "tc-1", content: "72°F sunny" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    // Should proceed with normal SSE flow
    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("emits RUN_STARTED as first SSE event", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events[0]?.threadId).toBe("t1");
    expect(events[0]?.runId).toBe("r1");
  });

  it("emits RUN_FINISHED after dispatch completes", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(res._ended).toBe(true);
  });

  it("calls dispatchReplyFromConfig with correct sessionKey and runId", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    expect(rt.channel.reply.dispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const call = rt.channel.reply.dispatchReplyFromConfig.mock.calls[0][0];
    expect(call.ctx.SessionKey).toBe("agui:test-session:thread:t1");
    expect(call.replyOptions.runId).toBe("r1");
  });

  it("sends TEXT_MESSAGE events when dispatcher.sendBlockReply is called", async () => {
    // Override dispatchReplyFromConfig to call the dispatcher
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher }: { dispatcher: any }) => {
        dispatcher.sendBlockReply({ text: "Hello from agent" });
        dispatcher.sendFinalReply({ text: "" });
        return { queuedFinal: true, counts: { tool: 0, block: 1, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    const contentEvt = events.find(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    expect(contentEvt?.delta).toBe("Hello from agent\n\n");
  });

  it("sendToolResult does not crash and stream completes (tool events come from hooks)", async () => {
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher }: { dispatcher: any }) => {
        const ok = dispatcher.sendToolResult({ text: "tool output" });
        expect(ok).toBe(true);
        dispatcher.sendFinalReply({ text: "done" });
        return { queuedFinal: true, counts: { tool: 1, block: 0, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(res._ended).toBe(true);
  });

  it("emits RUN_ERROR on dispatch failure", async () => {
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockRejectedValue(
      new Error("agent failed"),
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_ERROR);
    const errEvt = events.find((e) => e.type === EventType.RUN_ERROR);
    expect(errEvt?.message).toContain("agent failed");
    expect(res._ended).toBe(true);
  });

  it("suppresses text output when client tool was called", async () => {
    const { setClientToolCalled } = await import("./tool-store.js");

    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher, ctx }: { dispatcher: any; ctx: any }) => {
        // Simulate a client tool being called (flag set by before_tool_call hook)
        setClientToolCalled(ctx.SessionKey);
        // Agent tries to send text after tool call — should be suppressed
        dispatcher.sendBlockReply({ text: "unwanted text" });
        dispatcher.sendFinalReply({ text: "also unwanted" });
        return { queuedFinal: true, counts: { tool: 1, block: 0, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ct",
        runId: "r-ct",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ name: "get_weather", description: "Get weather" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    // Should NOT contain text message events
    expect(types).not.toContain(EventType.TEXT_MESSAGE_START);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_CONTENT);
    // Should still finish the run
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("keeps tool calls and text in a single run (no run splitting)", async () => {
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher }: { dispatcher: any }) => {
        // Tool call followed by text — should stay in the same run
        dispatcher.sendBlockReply({ text: "Here is the result" });
        dispatcher.sendFinalReply({ text: "" });
        return { queuedFinal: true, counts: { tool: 1, block: 1, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-single",
        runId: "r-single",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);

    // Exactly one RUN_STARTED and one RUN_FINISHED — no splitting
    const runStarted = events.filter((e) => e.type === EventType.RUN_STARTED);
    const runFinished = events.filter((e) => e.type === EventType.RUN_FINISHED);
    expect(runStarted.length).toBe(1);
    expect(runFinished.length).toBe(1);
    expect(runStarted[0]?.runId).toBe("r-single");
    expect(runFinished[0]?.runId).toBe("r-single");

    // Text events are present in the same run
    expect(events.map((e) => e.type)).toContain(EventType.TEXT_MESSAGE_START);
    expect(events.map((e) => e.type)).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(events.map((e) => e.type)).toContain(EventType.TEXT_MESSAGE_END);
  });

  // -------------------------------------------------------------------------
  // Reasoning events
  // -------------------------------------------------------------------------

  it("emits REASONING events when onReasoningStream/onReasoningEnd are invoked", async () => {
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher, replyOptions }: { dispatcher: any; replyOptions: any }) => {
        // Simulate reasoning stream
        replyOptions.onReasoningStream({ text: "Let me think..." });
        replyOptions.onReasoningStream({ text: "The answer is 42." });
        replyOptions.onReasoningEnd();
        // Then final text
        dispatcher.sendFinalReply({ text: "The answer is 42." });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-reason",
        runId: "r-reason",
        messages: [{ role: "user", content: "Think carefully" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);

    // Reasoning events should appear
    expect(types).toContain(EventType.REASONING_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_CONTENT);
    expect(types).toContain(EventType.REASONING_MESSAGE_END);
    expect(types).toContain(EventType.REASONING_END);

    // Reasoning message start should have role: "reasoning"
    const reasonStart = events.find((e) => e.type === EventType.REASONING_MESSAGE_START);
    expect(reasonStart?.role).toBe("reasoning");

    // Two content deltas
    const reasonContent = events.filter((e) => e.type === EventType.REASONING_MESSAGE_CONTENT);
    expect(reasonContent).toHaveLength(2);
    expect(reasonContent[0]?.delta).toBe("Let me think...");
    expect(reasonContent[1]?.delta).toBe("The answer is 42.");

    // All reasoning events share the same messageId
    const reasoningEvents = events.filter(
      (e) => typeof e.type === "string" && (e.type as string).startsWith("REASONING_"),
    );
    const messageIds = new Set(reasoningEvents.map((e) => e.messageId));
    expect(messageIds.size).toBe(1);

    // Reasoning messageId differs from text messageId
    const textStart = events.find((e) => e.type === EventType.TEXT_MESSAGE_START);
    expect(textStart?.messageId).not.toBe(reasoningEvents[0]?.messageId);

    // Text message still present after reasoning
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("does not emit REASONING events when no reasoning stream fires", async () => {
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher }: { dispatcher: any }) => {
        dispatcher.sendFinalReply({ text: "Just text." });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-noreason",
        runId: "r-noreason",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);

    expect(types).not.toContain(EventType.REASONING_START);
    expect(types).not.toContain(EventType.REASONING_MESSAGE_START);
  });

  it("auto-closes reasoning if sendFinalReply fires before onReasoningEnd", async () => {
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher, replyOptions }: { dispatcher: any; replyOptions: any }) => {
        replyOptions.onReasoningStream({ text: "Thinking..." });
        // No onReasoningEnd call — sendFinalReply should close it
        dispatcher.sendFinalReply({ text: "Done." });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-autoclose",
        runId: "r-autoclose",
        messages: [{ role: "user", content: "Think" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);

    // Reasoning should be properly closed even without explicit onReasoningEnd
    expect(types).toContain(EventType.REASONING_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_END);
    expect(types).toContain(EventType.REASONING_END);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  // -------------------------------------------------------------------------
  // Step events
  // -------------------------------------------------------------------------

  it("emits STEP_STARTED and STEP_FINISHED from onItemEvent", async () => {
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher, replyOptions }: { dispatcher: any; replyOptions: any }) => {
        replyOptions.onItemEvent({ itemId: "step-1", phase: "started", title: "Searching" });
        replyOptions.onItemEvent({ itemId: "step-1", phase: "completed", title: "Searching" });
        dispatcher.sendFinalReply({ text: "Found it." });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-step",
        runId: "r-step",
        messages: [{ role: "user", content: "Search" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.STEP_STARTED);
    expect(types).toContain(EventType.STEP_FINISHED);

    const stepStart = events.find((e) => e.type === EventType.STEP_STARTED);
    expect(stepStart?.stepName).toBe("Searching");
  });

  it("deduplicates STEP_STARTED for the same itemId", async () => {
    const rt = (fakeApi as any).runtime;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ dispatcher, replyOptions }: { dispatcher: any; replyOptions: any }) => {
        replyOptions.onItemEvent({ itemId: "s1", phase: "started", title: "Step A" });
        replyOptions.onItemEvent({ itemId: "s1", phase: "started", title: "Step A" }); // duplicate
        replyOptions.onItemEvent({ itemId: "s1", phase: "completed", title: "Step A" });
        dispatcher.sendFinalReply({ text: "Done." });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-dedup",
        runId: "r-dedup",
        messages: [{ role: "user", content: "Go" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    const stepStarts = events.filter((e) => e.type === EventType.STEP_STARTED);
    expect(stepStarts).toHaveLength(1);
  });

  it("includes tool messages in conversation context for new run", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-resume",
        runId: "r-resume",
        messages: [
          { role: "user", content: "Weather in Tokyo?" },
          { role: "tool", toolCallId: "tc-1", content: "72°F sunny" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    // Should proceed with normal SSE flow (has user message + tool context)
    const events = parseEvents(res._chunks);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("passes X-OpenClaw-Agent-Id header as accountId to resolveAgentRoute", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-agent-id": "auditor",
      },
      body: {
        threadId: "t-agent",
        runId: "r-agent",
        messages: [{ role: "user", content: "Hello auditor" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    expect(rt.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "clawg-ui",
        accountId: "auditor",
      }),
    );
  });

  it("does not pass accountId when X-OpenClaw-Agent-Id header is absent", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-no-agent",
        runId: "r-no-agent",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    expect(rt.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "clawg-ui",
        accountId: undefined,
      }),
    );
  });

  it("uses deviceId as peer ID for identity linking", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-peer",
        runId: "r-peer",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    expect(rt.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "clawg-ui",
        peer: { kind: "direct", id: APPROVED_DEVICE_ID },
      }),
    );
  });

  it("appends thread suffix to session key for thread separation", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "My-Thread-42",
        runId: "r-thread",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.dispatchReplyFromConfig.mock.calls[0][0];
    expect(call.ctx.SessionKey).toBe("agui:test-session:thread:my-thread-42");
  });

  it("uses base session key when threadId is absent", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        runId: "r-no-thread",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.dispatchReplyFromConfig.mock.calls[0][0];
    // threadId defaults to "clawg-ui-<uuid>" so it will have a thread suffix
    expect(call.ctx.SessionKey).toMatch(/^agui:test-session:thread:clawg-ui-/);
  });

  // -------------------------------------------------------------------------
  // X-OpenClaw-Session-Key — per-user session scoping
  // -------------------------------------------------------------------------

  it("appends user suffix to session key when X-OpenClaw-Session-Key is provided", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": "alice@example.com",
      },
      body: {
        threadId: "t-user",
        runId: "r-user",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.dispatchReplyFromConfig.mock.calls[0][0];
    expect(call.ctx.SessionKey).toBe(
      "agui:test-session:user:alice@example.com:thread:t-user",
    );
  });

  it("composes user and thread suffixes together in order", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": "alice",
      },
      body: {
        threadId: "t-1",
        runId: "r-1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.dispatchReplyFromConfig.mock.calls[0][0];
    expect(call.ctx.SessionKey).toBe("agui:test-session:user:alice:thread:t-1");
  });

  it("namespaces header value under route.sessionKey and never replaces it", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": "totally-different",
      },
      body: {
        threadId: "t-hostile",
        runId: "r-hostile",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.dispatchReplyFromConfig.mock.calls[0][0];
    expect(call.ctx.SessionKey.startsWith("agui:test-session:")).toBe(true);
    expect(call.ctx.SessionKey).toContain(":user:totally-different");
  });

  it("falls back to route.sessionKey scoping when X-OpenClaw-Session-Key is absent", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-nouser",
        runId: "r-nouser",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.dispatchReplyFromConfig.mock.calls[0][0];
    expect(call.ctx.SessionKey).toBe("agui:test-session:thread:t-nouser");
    expect(call.ctx.SessionKey).not.toContain(":user:");
  });

  it.each([
    ["path traversal", "../evil"],
    ["forward slash", "a/b"],
    ["backslash", "a\\b"],
    ["null byte", "a\0b"],
  ])(
    "rejects X-OpenClaw-Session-Key with %s (400 invalid_request_error)",
    async (_label, value) => {
      const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
      const req = createReq({
        headers: {
          authorization: `Bearer ${token}`,
          "x-openclaw-session-key": value,
        },
        body: {
          threadId: "t",
          runId: "r",
          messages: [{ role: "user", content: "Hello" }],
        },
      });
      const res = createRes();
      await handler(req, res);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res._chunks.join(""));
      expect(body.error.type).toBe("invalid_request_error");
    },
  );

  it("rejects X-OpenClaw-Session-Key exceeding 256 characters", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": "a".repeat(257),
      },
      body: {
        threadId: "t",
        runId: "r",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res._chunks.join(""));
    expect(body.error.type).toBe("invalid_request_error");
  });

  it.each([
    ["whitespace", "alice space"],
    ["exclamation", "alice!"],
    ["hash", "alice#b"],
  ])(
    "rejects X-OpenClaw-Session-Key with disallowed character (%s)",
    async (_label, value) => {
      const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
      const req = createReq({
        headers: {
          authorization: `Bearer ${token}`,
          "x-openclaw-session-key": value,
        },
        body: {
          threadId: "t",
          runId: "r",
          messages: [{ role: "user", content: "Hello" }],
        },
      });
      const res = createRes();
      await handler(req, res);

      expect(res.statusCode).toBe(400);
    },
  );

  it.each([
    ["email", "alice@example.com"],
    ["uuid", "12345678-1234-1234-1234-123456789abc"],
    ["colon-separated", "tenant-1:alice"],
    ["dot-and-underscore", "user_1.alice"],
  ])(
    "accepts well-formed identifier (%s) and composes it under route.sessionKey",
    async (_label, value) => {
      const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
      const req = createReq({
        headers: {
          authorization: `Bearer ${token}`,
          "x-openclaw-session-key": value,
        },
        body: {
          threadId: "t-ok",
          runId: "r-ok",
          messages: [{ role: "user", content: "Hello" }],
        },
      });
      const res = createRes();
      await handler(req, res);

      expect(res.statusCode).toBe(200);
      const rt = (fakeApi as any).runtime;
      const call = rt.channel.reply.dispatchReplyFromConfig.mock.calls[0][0];
      expect(call.ctx.SessionKey).toBe(
        `agui:test-session:user:${value}:thread:t-ok`,
      );
    },
  );

  it("does not call resolveAgentRoute or dispatchReplyFromConfig when X-OpenClaw-Session-Key is invalid", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: {
        authorization: `Bearer ${token}`,
        "x-openclaw-session-key": "../escape",
      },
      body: {
        threadId: "t",
        runId: "r",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    expect(rt.channel.routing.resolveAgentRoute).not.toHaveBeenCalled();
    expect(rt.channel.reply.dispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("handles client disconnect by aborting", async () => {
    const rt = (fakeApi as any).runtime;
    let capturedAbortSignal: AbortSignal | undefined;
    rt.channel.reply.dispatchReplyFromConfig.mockImplementation(
      async ({ replyOptions }: { replyOptions: any }) => {
        capturedAbortSignal = replyOptions.abortSignal;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    // Simulate client disconnect
    (req as EventEmitter).emit("close");

    expect(capturedAbortSignal).toBeDefined();
    expect(capturedAbortSignal!.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AG-UI context forwarding
// ---------------------------------------------------------------------------

describe("AG-UI RunAgentInput.context forwarding", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as any);
  });

  it("includes context entries in BodyForAgent", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ctx",
        runId: "r-ctx",
        messages: [{ role: "user", content: "Approve writes" }],
        context: [
          {
            description: "Pending tool-call approvals",
            value: '[{"callId":"write_123","toolName":"write"}]',
          },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.BodyForAgent).toContain("## Context provided by the UI");
    expect(call.BodyForAgent).toContain("### Pending tool-call approvals");
    expect(call.BodyForAgent).toContain("write_123");
  });

  it("does not set BodyForAgent when context is empty", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ctx-empty",
        runId: "r-ctx-empty",
        messages: [{ role: "user", content: "Hello" }],
        context: [],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.BodyForAgent).toBeUndefined();
  });

  it("filters out context entries with empty description and value", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ctx-filter",
        runId: "r-ctx-filter",
        messages: [{ role: "user", content: "Hello" }],
        context: [
          { description: "", value: "" },
          { description: "App state", value: "editing" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.BodyForAgent).toContain("### App state");
    expect(call.BodyForAgent).toContain("editing");
    // Should not have an empty heading
    expect(call.BodyForAgent).not.toContain("### \n");
  });

  it("does not set BodyForAgent when all context entries are empty", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ctx-all-empty",
        runId: "r-ctx-all-empty",
        messages: [{ role: "user", content: "Hello" }],
        context: [
          { description: "", value: "" },
          { description: "", value: "" },
        ],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.BodyForAgent).toBeUndefined();
  });

  it("does not set BodyForAgent when context is absent", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-ctx-none",
        runId: "r-ctx-none",
        messages: [{ role: "user", content: "Hello" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    const call = rt.channel.reply.finalizeInboundContext.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.BodyForAgent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Device Pairing Tests
// ---------------------------------------------------------------------------

describe("Device pairing", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
  });

  it("returns pairing_pending with pairingCode and token when no auth header", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as any);

    const req = createReq({
      headers: {}, // No authorization header
      body: {},
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res._chunks[0]);
    expect(body.error.type).toBe("pairing_pending");
    expect(body.error.pairing.pairingCode).toBe("TEST1234");
    expect(body.error.pairing.token).toBeDefined();
    expect(body.error.pairing.instructions).toContain("openclaw pairing approve clawg-ui");
  });

  it("calls upsertPairingRequest when initiating pairing", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as any);

    const req = createReq({
      headers: {}, // No authorization header
      body: {},
    });
    const res = createRes();
    await handler(req, res);

    const rt = (fakeApi as any).runtime;
    expect(rt.channel.pairing.upsertPairingRequest).toHaveBeenCalledTimes(1);
    expect(rt.channel.pairing.upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "clawg-ui",
      }),
    );
  });

  it("rejects invalid HMAC signature with 401", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as any);

    // Token with invalid signature
    const req = createReq({
      headers: { authorization: "Bearer aW52YWxpZC1kZXZpY2UtaWQ.invalidsignature" },
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(401);
  });

  it("returns pairing_pending for valid token but unapproved device", async () => {
    // No approved devices
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as any);

    // Create valid HMAC token for a device that's not approved
    const unapprovedDeviceId = "87654321-4321-4321-4321-abcdef123456";
    const token = createDeviceToken(GATEWAY_SECRET, unapprovedDeviceId);

    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res._chunks[0]);
    expect(body.error.type).toBe("pairing_pending");
    expect(body.error.message).toContain("pending approval");
  });

  it("proceeds normally for valid token with approved device", async () => {
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as any);

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);

    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: { messages: [{ role: "user", content: "Hello" }] },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res._chunks);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("returns 429 rate_limit when max pending pairing requests reached", async () => {
    // Simulate rate limit by returning empty code
    fakeApi = createFakeApi([], { pairingCode: "" });
    handler = createAguiHttpHandler(fakeApi as any);

    const req = createReq({
      headers: {}, // No authorization header - initiates pairing
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res._chunks[0]);
    expect(body.error.type).toBe("rate_limit");
    expect(body.error.message).toContain("Too many pending pairing requests");
  });
});
