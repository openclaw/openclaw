import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventType } from "@ag-ui/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@ag-ui/encoder", () => ({
  // Regular (constructable) function — production does `new EventEncoder(...)`,
  // and this vitest version cannot `new` a mock whose implementation is an
  // arrow function (arrows have no [[Construct]]).
  EventEncoder: vi.fn().mockImplementation(function () {
    return {
      getContentType: () => "text/event-stream",
      encode: (event: unknown) => `data: ${JSON.stringify(event)}\n\n`,
    };
  }),
}));

// The handler ensures a SQLite session entry exists before runEmbeddedAgent.
// Mock the session store so unit tests don't touch a real store; getSessionEntry
// returns undefined (cold turn -> upsert runs, then no-op).
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: vi.fn(() => undefined),
  upsertSessionEntry: vi.fn(async () => {}),
}));

import { createAguiHttpHandler } from "./http-handler.js";
import {
  createReq,
  createRes,
  parseEvents,
  createDeviceToken,
  createFakeApi,
  GATEWAY_SECRET,
  APPROVED_DEVICE_ID,
} from "./http-handler.test-helpers.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AG-UI HTTP handler", () => {
  let fakeApi: ReturnType<typeof createFakeApi>;
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set env token before handler creation so the factory can resolve it
    process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_SECRET;
    // Create fake API with the approved device
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);
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
    const events = parseEvents(res.chunks);
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
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
    const events = parseEvents(res.chunks);
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
    expect(events[0]!.threadId).toBe("t-empty");
    expect(events[0]!.runId).toBe("r-empty");
  });

  it("accepts tool-only messages (tool result submission)", async () => {
    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t-tool-only",
        runId: "r-tool-only",
        messages: [{ role: "tool", toolCallId: "tc-1", content: "72°F sunny" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    // Should proceed with normal SSE flow
    const events = parseEvents(res.chunks);
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

    const events = parseEvents(res.chunks);
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

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(res.ended).toBe(true);
  });

  it("calls runEmbeddedAgent with correct sessionKey and runId", async () => {
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

    const rt = fakeApi.runtime;
    expect(rt.agent.runEmbeddedAgent).toHaveBeenCalledTimes(1);
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey).toBe("agui:test-session:thread:t1");
    expect(call.runId).toBe("r1");
  });

  it("sends TEXT_MESSAGE events when runEmbeddedAgent streams via onPartialReply", async () => {
    // The handler forwards onPartialReply snapshots as TEXT_MESSAGE_CONTENT
    // deltas. A single cumulative snapshot of "Hello from agent" (from an empty
    // start) yields exactly that text as the delta.
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      params.onPartialReply({ text: "Hello from agent" });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

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

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    const contentEvt = events.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
    expect(contentEvt?.delta).toBe("Hello from agent");
  });

  it("emits INCREMENTAL reasoning deltas from OpenClaw's cumulative snapshots", async () => {
    // OpenClaw delivers reasoning as a running snapshot (each callback carries
    // the FULL thinking-so-far — see btw.ts `reasoningText += delta`). The
    // adapter must forward only the newly-appended suffix, otherwise the
    // frontend stacks every snapshot into an exploding wall of repeated text.
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      params.onReasoningStream({ text: "**Writing**\n\nThe" });
      params.onReasoningStream({ text: "**Writing**\n\nThe user" });
      params.onReasoningStream({ text: "**Writing**\n\nThe user wants" });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);
    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: {
        threadId: "t1",
        runId: "r1",
        messages: [{ role: "user", content: "Write a sonnet" }],
      },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    const deltas = events
      .filter((e) => e.type === EventType.REASONING_MESSAGE_CONTENT)
      .map((e) => e.delta);

    // Each delta is ONLY the new suffix, not the full cumulative snapshot.
    expect(deltas).toEqual(["**Writing**\n\nThe", " user", " wants"]);
    // Concatenating the deltas reconstructs the reasoning exactly once — no
    // stacking, no repeated "**Writing**" title.
    expect(deltas.join("")).toBe("**Writing**\n\nThe user wants");
  });

  it("backend-tool run completes and streams to completion (tool events come from hooks)", async () => {
    // Backend/server-side tool calls no longer flow through a dispatcher —
    // they execute in-loop and render via the before_tool_call /
    // tool_result_persist hooks. From the handler's perspective the run simply
    // streams its final assistant text and finishes.
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      params.onPartialReply({ text: "done" });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

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

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_FINISHED);
    expect(res.ended).toBe(true);
  });

  it("emits RUN_ERROR on run failure", async () => {
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockRejectedValue(new Error("agent failed"));

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

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.RUN_ERROR);
    const errEvt = events.find((e) => e.type === EventType.RUN_ERROR);
    expect(errEvt?.message).toContain("agent failed");
    expect(res.ended).toBe(true);
  });

  it("suppresses text output when client tool was called", async () => {
    const { setClientToolCalled } = await import("./tool-store.js");

    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      // Simulate a client tool being called (flag set by before_tool_call hook)
      setClientToolCalled(params.sessionKey);
      // Agent tries to stream text after the tool call — handlePartialReply must
      // suppress it because a client tool was already invoked.
      params.onPartialReply({ text: "unwanted text" });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

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

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);
    // Should NOT contain text message events
    expect(types).not.toContain(EventType.TEXT_MESSAGE_START);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_CONTENT);
    // Should still finish the run
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("keeps tool calls and text in a single run (no run splitting)", async () => {
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      // Tool call followed by text — should stay in the same run
      params.onPartialReply({ text: "Here is the result" });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

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

    const events = parseEvents(res.chunks);

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
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      // Simulate reasoning stream the way OpenClaw's embedded run actually does
      // (embedded-agent-subscribe.ts): a CUMULATIVE `text` snapshot plus the
      // incremental `delta` it already computed. The adapter forwards `delta`.
      // The text message must open lazily on the first text delta (AFTER
      // reasoning), so the reasoning panel renders above the answer.
      params.onReasoningStream({
        text: "Let me think...",
        delta: "Let me think...",
      });
      params.onReasoningStream({
        text: "Let me think...The answer is 42.",
        delta: "The answer is 42.",
      });
      params.onReasoningEnd();
      // Then final text
      params.onPartialReply({ text: "The answer is 42." });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

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

    const events = parseEvents(res.chunks);
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

    // Reasoning must be announced BEFORE the answer text so an AG-UI client renders the
    // reasoning panel ABOVE the answer. Regression guard: an eager assistant-message
    // -start hook once opened the text message at turn start (before reasoning),
    // which pushed the reasoning panel to the bottom of the message.
    expect(types.indexOf(EventType.REASONING_START)).toBeLessThan(
      types.indexOf(EventType.TEXT_MESSAGE_START),
    );
  });

  it("does not emit REASONING events when no reasoning stream fires", async () => {
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      params.onPartialReply({ text: "Just text." });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

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

    const events = parseEvents(res.chunks);
    const types = events.map((e) => e.type);

    expect(types).not.toContain(EventType.REASONING_START);
    expect(types).not.toContain(EventType.REASONING_MESSAGE_START);
  });

  it("auto-closes reasoning if final text fires before onReasoningEnd", async () => {
    const rt = fakeApi.runtime;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      params.onReasoningStream({ text: "Thinking..." });
      // No onReasoningEnd call — the first text delta (closeReasoningIfOpen in
      // handlePartialReply) and run close should close the reasoning block.
      params.onPartialReply({ text: "Done." });
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

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

    const events = parseEvents(res.chunks);
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
  //
  // The two former step-event tests ("emits STEP_STARTED and STEP_FINISHED from
  // onItemEvent" and "deduplicates STEP_STARTED for the same itemId") have been
  // removed. They exercised the reply pipeline's `replyOptions.onItemEvent`
  // callback, which drove STEP_STARTED/STEP_FINISHED AG-UI events. The refactor
  // deleted the reply-pipeline branch entirely; the single runEmbeddedAgent path
  // exposes no item/step callback and the handler emits no STEP_* events, so
  // there is no equivalent new behavior to assert against.

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
    const events = parseEvents(res.chunks);
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

    const rt = fakeApi.runtime;
    expect(rt.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "ag-ui",
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

    const rt = fakeApi.runtime;
    expect(rt.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "ag-ui",
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

    const rt = fakeApi.runtime;
    expect(rt.channel.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "ag-ui",
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey).toBe("agui:test-session:thread:my-thread-42");
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    // threadId defaults to "ag-ui-<uuid>" so it will have a thread suffix
    expect(call.sessionKey).toMatch(/^agui:test-session:thread:ag-ui-/);
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey).toBe("agui:test-session:user:alice@example.com:thread:t-user");
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey).toBe("agui:test-session:user:alice:thread:t-1");
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey.startsWith("agui:test-session:")).toBe(true);
    expect(call.sessionKey).toContain(":user:totally-different");
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call.sessionKey).toBe("agui:test-session:thread:t-nouser");
    expect(call.sessionKey).not.toContain(":user:");
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
      const body = JSON.parse(res.chunks.join(""));
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
    const body = JSON.parse(res.chunks.join(""));
    expect(body.error.type).toBe("invalid_request_error");
  });

  it.each([
    ["whitespace", "alice space"],
    ["exclamation", "alice!"],
    ["hash", "alice#b"],
  ])("rejects X-OpenClaw-Session-Key with disallowed character (%s)", async (_label, value) => {
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
  });

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
      const rt = fakeApi.runtime;
      const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
      expect(call.sessionKey).toBe(`agui:test-session:user:${value}:thread:t-ok`);
    },
  );

  it("does not call resolveAgentRoute or runEmbeddedAgent when X-OpenClaw-Session-Key is invalid", async () => {
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

    const rt = fakeApi.runtime;
    expect(rt.channel.routing.resolveAgentRoute).not.toHaveBeenCalled();
    expect(rt.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("handles client disconnect by aborting", async () => {
    const rt = fakeApi.runtime;
    let capturedAbortSignal: AbortSignal | undefined;
    rt.agent.runEmbeddedAgent.mockImplementation(async (params: any) => {
      capturedAbortSignal = params.abortSignal;
      return { meta: { stopReason: "stop", pendingToolCalls: [] }, payloads: [] };
    });

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
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);
  });

  // Context is no longer injected via finalizeInboundContext's BodyForAgent;
  // the handler now appends formatContextEntries(...) to the `prompt` passed to
  // runEmbeddedAgent (via promptSuffix). These tests assert the equivalent
  // behavior on that prompt.
  it("includes context entries in the run prompt", async () => {
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.prompt).toContain("## Context provided by the UI");
    expect(call.prompt).toContain("### Pending tool-call approvals");
    expect(call.prompt).toContain("write_123");
  });

  it("does not inject a context block into the prompt when context is empty", async () => {
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.prompt).not.toContain("## Context provided by the UI");
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.prompt).toContain("### App state");
    expect(call.prompt).toContain("editing");
    // Should not have an empty heading
    expect(call.prompt).not.toContain("### \n");
  });

  it("does not inject a context block into the prompt when all context entries are empty", async () => {
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.prompt).not.toContain("## Context provided by the UI");
  });

  it("does not inject a context block into the prompt when context is absent", async () => {
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

    const rt = fakeApi.runtime;
    const call = rt.agent.runEmbeddedAgent.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.prompt).not.toContain("## Context provided by the UI");
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
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

    const req = createReq({
      headers: {}, // No authorization header
      body: {},
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.chunks[0]!);
    expect(body.error.type).toBe("pairing_pending");
    expect(body.error.pairing.pairingCode).toBe("TEST1234");
    expect(body.error.pairing.token).toBeDefined();
    expect(body.error.pairing.instructions).toContain("openclaw pairing approve ag-ui");
  });

  it("calls upsertPairingRequest when initiating pairing", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

    const req = createReq({
      headers: {}, // No authorization header
      body: {},
    });
    const res = createRes();
    await handler(req, res);

    const rt = fakeApi.runtime;
    expect(rt.channel.pairing.upsertPairingRequest).toHaveBeenCalledTimes(1);
    expect(rt.channel.pairing.upsertPairingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "ag-ui",
      }),
    );
  });

  it("rejects invalid HMAC signature with 401", async () => {
    fakeApi = createFakeApi([]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

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
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

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
    const body = JSON.parse(res.chunks[0]!);
    expect(body.error.type).toBe("pairing_pending");
    expect(body.error.message).toContain("pending approval");
  });

  it("proceeds normally for valid token with approved device", async () => {
    fakeApi = createFakeApi([APPROVED_DEVICE_ID]);
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

    const token = createDeviceToken(GATEWAY_SECRET, APPROVED_DEVICE_ID);

    const req = createReq({
      headers: { authorization: `Bearer ${token}` },
      body: { messages: [{ role: "user", content: "Hello" }] },
    });
    const res = createRes();
    await handler(req, res);

    const events = parseEvents(res.chunks);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events.some((e) => e.type === EventType.RUN_FINISHED)).toBe(true);
  });

  it("returns 429 rate_limit when max pending pairing requests reached", async () => {
    // Simulate rate limit by returning empty code
    fakeApi = createFakeApi([], { pairingCode: "" });
    handler = createAguiHttpHandler(fakeApi as unknown as OpenClawPluginApi);

    const req = createReq({
      headers: {}, // No authorization header - initiates pairing
      body: { messages: [{ role: "user", content: "hi" }] },
    });
    const res = createRes();
    await handler(req, res);

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.chunks[0]!);
    expect(body.error.type).toBe("rate_limit");
    expect(body.error.message).toContain("Too many pending pairing requests");
  });
});
