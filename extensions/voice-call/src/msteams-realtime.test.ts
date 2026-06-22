import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  type RealtimeVoiceBridge,
  type RealtimeVoiceBridgeCreateRequest,
  type RealtimeVoiceProviderPlugin,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import type { CoreAgentDeps } from "./core-bridge.js";
import type { MsteamsSession } from "./msteams-media-stream.js";
import { createMsteamsRealtimeCall, type MsteamsRealtimeDeps } from "./msteams-realtime.js";
import { VisionBudget } from "./vision-budget.js";

// Capture the transcript handed to the consult agent, while keeping the rest of
// the realtime-voice SDK (createRealtimeVoiceBridgeSession, etc.) real.
const consultSpy = vi.hoisted(() =>
  vi.fn(
    async (_opts?: { transcript?: unknown }): Promise<{ text: string; mediaPaths?: string[] }> => ({
      text: "ok",
    }),
  ),
);
vi.mock("openclaw/plugin-sdk/realtime-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/realtime-voice")>();
  return { ...actual, consultRealtimeVoiceAgent: consultSpy };
});
vi.mock("./realtime-fast-context.js", () => ({
  resolveRealtimeFastContextConsult: vi.fn(async () => ({ handled: false })),
}));
vi.mock("./response-model.js", () => ({
  resolveVoiceResponseModel: vi.fn(() => ({ provider: "openai", model: "gpt-x" })),
}));

function createMockSession(recordingStatus: MsteamsSession["recordingStatus"] = "active"): {
  session: MsteamsSession;
  sent: unknown[];
  closedReason: string | null;
} {
  const sent: unknown[] = [];
  let closedReason: string | null = null;
  const session: MsteamsSession = {
    callId: "call-1",
    threadId: "thread-1",
    caller: { aadId: "aad-1", displayName: "Caller", tenantId: "tenant-1" },
    recordingStatus,
    send: (message) => {
      sent.push(message);
      return true;
    },
    close: (reason) => {
      closedReason = reason;
    },
  };
  return {
    session,
    sent,
    get closedReason() {
      return closedReason;
    },
  } as { session: MsteamsSession; sent: unknown[]; closedReason: string | null };
}

/** Mock realtime provider that captures the bridge create request so tests can drive callbacks. */
function createMockProvider(): {
  provider: RealtimeVoiceProviderPlugin;
  getRequest: () => RealtimeVoiceBridgeCreateRequest;
  submitToolResult: ReturnType<typeof vi.fn>;
  sendAudio: ReturnType<typeof vi.fn>;
  sendImage: ReturnType<typeof vi.fn>;
} {
  let request: RealtimeVoiceBridgeCreateRequest | undefined;
  const submitToolResult = vi.fn();
  const sendAudio = vi.fn();
  const sendImage = vi.fn();

  const bridge: RealtimeVoiceBridge = {
    supportsToolResultContinuation: true,
    connect: async () => {},
    sendAudio,
    sendImage,
    setMediaTimestamp: () => {},
    submitToolResult,
    acknowledgeMark: () => {},
    close: () => {},
    isConnected: () => true,
  };

  const provider = {
    id: "openai",
    label: "Mock Realtime",
    isConfigured: () => true,
    createBridge: (req: RealtimeVoiceBridgeCreateRequest) => {
      request = req;
      return bridge;
    },
  } as unknown as RealtimeVoiceProviderPlugin;

  return {
    provider,
    getRequest: () => {
      if (!request) {
        throw new Error("createBridge was not called");
      }
      return request;
    },
    submitToolResult,
    sendAudio,
    sendImage,
  };
}

const CONSULT_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  description: "consult",
  parameters: { type: "object", properties: {} },
};

describe("createMsteamsRealtimeCall", () => {
  it("forwards configured tools to the realtime bridge", () => {
    const { session } = createMockSession();
    const mock = createMockProvider();
    const deps: MsteamsRealtimeDeps = {
      provider: mock.provider,
      providerConfig: {},
      tools: [CONSULT_TOOL],
    };

    createMsteamsRealtimeCall({ session, deps });

    expect(mock.getRequest().tools).toEqual([CONSULT_TOOL]);
  });

  it("plays model audio back to the caller as audio.frame and flushes on barge-in", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: { provider: mock.provider, providerConfig: {} },
    });

    const req = mock.getRequest();
    // Model emits 24 kHz PCM; bridge should resample + forward as audio.frame.
    req.onAudio(Buffer.alloc(960));
    const frame = ctx.sent.find(
      (m): m is { type: string; payloadBase64: string } =>
        typeof m === "object" && m !== null && (m as { type?: string }).type === "audio.frame",
    );
    expect(frame).toBeDefined();
    expect(typeof frame?.payloadBase64).toBe("string");

    // Barge-in -> assistant.cancel so the worker flushes its playback queue.
    req.onClearAudio();
    const cancel = ctx.sent.find(
      (m) =>
        typeof m === "object" && m !== null && (m as { type?: string }).type === "assistant.cancel",
    );
    expect(cancel).toBeDefined();
  });

  it("forwards caller audio into the bridge", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: { provider: mock.provider, providerConfig: {} },
    });

    call.pushAudio(Buffer.alloc(640)); // one 20 ms 16 kHz frame
    expect(mock.sendAudio).toHaveBeenCalledTimes(1);
    const forwarded = mock.sendAudio.mock.calls[0]?.[0] as Buffer;
    expect(forwarded.length).toBeGreaterThan(0);
  });

  it("answers a consult tool call with an unavailable result when no agent runtime is wired", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: { provider: mock.provider, providerConfig: {}, tools: [CONSULT_TOOL] },
    });

    mock.getRequest().onToolCall?.({
      itemId: "item-1",
      callId: "tool-call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "do a thing" },
    });

    expect(mock.submitToolResult).toHaveBeenCalledWith(
      "tool-call-1",
      expect.objectContaining({ text: expect.any(String) }),
      undefined,
    );
  });

  it("exposes the async task tool under owner policy and acks a task call immediately", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        toolPolicy: "owner",
        // Minimal fakes: enough to enable async + reach the (caught) background run.
        agentRuntime: {} as unknown as CoreAgentDeps,
        voiceConfig: {} as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
      },
    });

    const req = mock.getRequest();
    const toolNames = (req.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("openclaw_agent_task");

    req.onToolCall?.({
      itemId: "item-2",
      callId: "task-call-1",
      name: "openclaw_agent_task",
      args: { task: "do a big multi-step thing" },
    });

    // The model is acknowledged synchronously; the agent runs in the background.
    expect(mock.submitToolResult).toHaveBeenCalledWith(
      "task-call-1",
      expect.objectContaining({ text: expect.any(String) }),
      undefined,
    );
  });

  it("close(reason) closes the Teams session (manager hangup); close() does not (caller hangup)", () => {
    // Manager-driven hangup passes a reason -> the worker session is closed so the call actually ends.
    const ctxA = createMockSession();
    const mockA = createMockProvider();
    const callA = createMsteamsRealtimeCall({
      session: ctxA.session,
      deps: { provider: mockA.provider, providerConfig: {} },
    });
    callA.close("completed");
    expect(ctxA.closedReason).toBe("completed");

    // Caller-driven session.end passes no reason -> the session is already closing, do not re-close it.
    const ctxB = createMockSession();
    const mockB = createMockProvider();
    const callB = createMsteamsRealtimeCall({
      session: ctxB.session,
      deps: { provider: mockB.provider, providerConfig: {} },
    });
    callB.close();
    expect(ctxB.closedReason).toBeNull();
  });

  it("hides look_at_screen and show_to_caller under the 'none' tool policy", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        toolPolicy: "none",
        agentRuntime: {} as unknown as CoreAgentDeps,
        voiceConfig: {} as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
        getLatestFrame: () => undefined,
      },
    });
    const toolNames = (mock.getRequest().tools ?? []).map((t) => t.name);
    expect(toolNames).not.toContain("look_at_screen");
    expect(toolNames).not.toContain("show_to_caller");
    expect(toolNames).not.toContain("openclaw_agent_task");
  });

  it("exposes look_at_screen but not show_to_caller under 'safe-read-only'", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        toolPolicy: "safe-read-only",
        agentRuntime: {} as unknown as CoreAgentDeps,
        voiceConfig: {} as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
        getLatestFrame: () => undefined,
      },
    });
    const toolNames = (mock.getRequest().tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("look_at_screen");
    expect(toolNames).not.toContain("show_to_caller");
  });

  it("exposes look_at_screen and show_to_caller under 'owner'", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        toolPolicy: "owner",
        agentRuntime: {} as unknown as CoreAgentDeps,
        voiceConfig: {} as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
        getLatestFrame: () => undefined,
      },
    });
    const toolNames = (mock.getRequest().tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("look_at_screen");
    expect(toolNames).toContain("show_to_caller");
  });

  it("refuses a background task (no ack) when the caller has no AAD delivery target", () => {
    const ctx = createMockSession();
    ctx.session.caller.aadId = null; // anonymous caller — no Teams chat to deliver to
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        toolPolicy: "owner",
        agentRuntime: {} as unknown as CoreAgentDeps,
        voiceConfig: {} as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
      },
    });

    mock.getRequest().onToolCall?.({
      itemId: "item-3",
      callId: "task-call-2",
      name: "openclaw_agent_task",
      args: { task: "do a big multi-step thing" },
    });

    const texts = mock.submitToolResult.mock.calls
      .filter((args) => args[0] === "task-call-2")
      .map((args) => (args[1] as { text: string }).text);
    // Refused with the no-target message, and never acked a delivery it can't make.
    expect(texts.some((t) => t.includes("don't have a Teams chat"))).toBe(true);
    expect(texts.some((t) => t.includes("I'll message you"))).toBe(false);
  });

  it('acks a background task with a call-back message when deliverVia is "call"', () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        toolPolicy: "owner",
        agentRuntime: {} as unknown as CoreAgentDeps,
        voiceConfig: {} as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
      },
    });

    mock.getRequest().onToolCall?.({
      itemId: "item-call",
      callId: "task-call-2",
      name: "openclaw_agent_task",
      args: { task: "find Dubai time", deliverVia: "call" },
    });

    // Ack should promise a call back (not a chat message).
    const acked = mock.submitToolResult.mock.calls.some(
      (args) =>
        args[0] === "task-call-2" &&
        typeof (args[1] as { text?: string })?.text === "string" &&
        /call you back/i.test((args[1] as { text: string }).text),
    );
    expect(acked).toBe(true);
  });

  it("exposes look_at_screen and answers with a no-frame message when nothing is shared", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        toolPolicy: "owner",
        agentRuntime: { resolveThinkingDefault: () => "high" } as unknown as CoreAgentDeps,
        voiceConfig: { realtime: {}, agentId: "main" } as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
        getLatestFrame: () => undefined, // nothing shared yet
      },
    });

    const req = mock.getRequest();
    expect((req.tools ?? []).map((t) => t.name)).toContain("look_at_screen");

    req.onToolCall?.({
      itemId: "i-look-0",
      callId: "look-0",
      name: "look_at_screen",
      args: { question: "what's on my screen?" },
    });

    const texts = mock.submitToolResult.mock.calls
      .filter((args) => args[0] === "look-0")
      .map((args) => (args[1] as { text: string }).text);
    expect(texts.some((t) => t.includes("can't see anything yet"))).toBe(true);
  });

  it("look_at_screen runs the agent with the latest frame as an image", async () => {
    consultSpy.mockClear();
    consultSpy.mockResolvedValueOnce({ text: "Your screen shows a stack trace on line 42." });
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        toolPolicy: "owner",
        agentRuntime: { resolveThinkingDefault: () => "high" } as unknown as CoreAgentDeps,
        voiceConfig: { realtime: {}, agentId: "main" } as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
        getLatestFrame: () => ({
          source: "screenshare",
          dataBase64: "AQID",
          mime: "image/jpeg",
          width: 1280,
          height: 720,
          ts: 0,
        }),
      },
    });

    mock.getRequest().onToolCall?.({
      itemId: "i-look-1",
      callId: "look-1",
      name: "look_at_screen",
      args: { question: "read the error on my screen" },
    });

    await vi.waitFor(() => expect(consultSpy).toHaveBeenCalled());
    const arg = consultSpy.mock.calls.at(-1)?.[0] as {
      images?: Array<{ type: string; data: string; mimeType: string }>;
    };
    expect(arg.images?.[0]).toMatchObject({ type: "image", data: "AQID", mimeType: "image/jpeg" });
  });

  it("realtime subagent session key honors sessionScope (per-phone keys by caller AAD across calls)", async () => {
    const keyFor = async (opts: {
      sessionScope?: "per-phone" | "per-call";
      aadId: string | null;
      callId: string;
    }): Promise<string> => {
      consultSpy.mockClear();
      consultSpy.mockResolvedValueOnce({ text: "ok" });
      const ctx = createMockSession();
      ctx.session.callId = opts.callId;
      ctx.session.caller.aadId = opts.aadId;
      const mock = createMockProvider();
      createMsteamsRealtimeCall({
        session: ctx.session,
        deps: {
          provider: mock.provider,
          providerConfig: {},
          tools: [CONSULT_TOOL],
          toolPolicy: "owner",
          agentRuntime: { resolveThinkingDefault: () => "high" } as unknown as CoreAgentDeps,
          voiceConfig: {
            realtime: {},
            agentId: "main",
            ...(opts.sessionScope ? { sessionScope: opts.sessionScope } : {}),
          } as unknown as VoiceCallConfig,
          cfg: {} as unknown as OpenClawConfig,
          getLatestFrame: () => ({
            source: "screenshare",
            dataBase64: "AQID",
            mime: "image/jpeg",
            width: 1,
            height: 1,
            ts: 0,
          }),
        },
      });
      mock.getRequest().onToolCall?.({
        itemId: "i",
        callId: "look",
        name: "look_at_screen",
        args: { question: "?" },
      });
      await vi.waitFor(() => expect(consultSpy).toHaveBeenCalled());
      const lastCall = consultSpy.mock.calls.at(-1);
      if (!lastCall) {
        throw new Error("consult was not called");
      }
      return (lastCall[0] as { sessionKey: string }).sessionKey;
    };

    // per-phone (default): the same caller AAD across two different calls reuses one subagent key.
    const k1 = await keyFor({ aadId: "aad-X", callId: "call-A" });
    const k2 = await keyFor({ aadId: "aad-X", callId: "call-B" });
    expect(k1).toContain("aad-X");
    expect(k1).not.toContain("call-A");
    expect(k2).toBe(k1);

    // per-call scope keys by callId instead of the caller.
    const perCall = await keyFor({ sessionScope: "per-call", aadId: "aad-X", callId: "call-C" });
    expect(perCall).toContain("call-C");
    expect(perCall).not.toContain("aad-X");

    // anonymous caller (no AAD) falls back to per-call so distinct callers never collide.
    const anon = await keyFor({ aadId: null, callId: "call-D" });
    expect(anon).toContain("call-D");
  });

  it("look_at_screen caches the answer for an unchanged frame and re-runs when it changes", async () => {
    consultSpy.mockClear();
    consultSpy.mockResolvedValue({ text: "A stack trace." });
    const ctx = createMockSession();
    const mock = createMockProvider();
    let frameData = "AQID";
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        toolPolicy: "owner",
        agentRuntime: { resolveThinkingDefault: () => "high" } as unknown as CoreAgentDeps,
        voiceConfig: { realtime: {}, agentId: "main" } as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
        getLatestFrame: () => ({
          source: "screenshare",
          dataBase64: frameData,
          mime: "image/jpeg",
          width: 100,
          height: 100,
          ts: 0,
        }),
      },
    });
    const req = mock.getRequest();

    req.onToolCall?.({
      itemId: "i1",
      callId: "c1",
      name: "look_at_screen",
      args: { question: "x" },
    });
    await vi.waitFor(() => expect(consultSpy).toHaveBeenCalledTimes(1));

    // Same frame again → cache hit, no second vision run.
    req.onToolCall?.({
      itemId: "i2",
      callId: "c2",
      name: "look_at_screen",
      args: { question: "x2" },
    });
    await new Promise<void>((r) => {
      setTimeout(r, 30);
    });
    expect(consultSpy).toHaveBeenCalledTimes(1);

    // Frame changed → re-runs.
    frameData = "BAUG";
    req.onToolCall?.({
      itemId: "i3",
      callId: "c3",
      name: "look_at_screen",
      args: { question: "now?" },
    });
    await vi.waitFor(() => expect(consultSpy).toHaveBeenCalledTimes(2));
  });

  it("refuses a consult tool call until Teams recording status is active (Media Access API)", () => {
    const ctx = createMockSession("inactive");
    const mock = createMockProvider();
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        // Wire an agent so refusal is the recording gate, not "agent unavailable".
        agentRuntime: {} as unknown as CoreAgentDeps,
        voiceConfig: { realtime: {} } as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
      },
    });

    const req = mock.getRequest();
    req.onToolCall?.({
      itemId: "item-3",
      callId: "tool-call-blocked",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "do real work" },
    });

    const refused = mock.submitToolResult.mock.calls.some(
      (args) =>
        args[0] === "tool-call-blocked" &&
        typeof (args[1] as { text?: string })?.text === "string" &&
        (args[1] as { text: string }).text.includes("recording isn't active"),
    );
    expect(refused).toBe(true);

    // Once the worker reports recording active, the gate opens for the next call.
    mock.submitToolResult.mockClear();
    call.setRecordingActive(true);
    req.onToolCall?.({
      itemId: "item-4",
      callId: "tool-call-allowed",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "do real work" },
    });
    const refusedAgain = mock.submitToolResult.mock.calls.some(
      (args) =>
        args[0] === "tool-call-allowed" &&
        typeof (args[1] as { text?: string })?.text === "string" &&
        (args[1] as { text: string }).text.includes("recording isn't active"),
    );
    expect(refusedAgain).toBe(false);
  });

  it("refuses a background task (no ack) until recording status is active", () => {
    const ctx = createMockSession("inactive");
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        toolPolicy: "owner",
        agentRuntime: {} as unknown as CoreAgentDeps,
        voiceConfig: {} as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
      },
    });

    mock.getRequest().onToolCall?.({
      itemId: "item-5",
      callId: "task-blocked",
      name: "openclaw_agent_task",
      args: { task: "a long job" },
    });

    // Refused with the recording message — NOT the "I'll message you" ack.
    const taskRefused = mock.submitToolResult.mock.calls.some(
      (args) =>
        args[0] === "task-blocked" &&
        typeof (args[1] as { text?: string })?.text === "string" &&
        (args[1] as { text: string }).text.includes("recording isn't active"),
    );
    expect(taskRefused).toBe(true);
    const acked = mock.submitToolResult.mock.calls.some(
      (args) =>
        typeof (args[1] as { text?: string })?.text === "string" &&
        (args[1] as { text: string }).text.includes("message you on Microsoft Teams"),
    );
    expect(acked).toBe(false);
  });

  it("can opt out of the recording gate via requireRecordingStatus: false", () => {
    const ctx = createMockSession("inactive");
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        requireRecordingStatus: false,
      },
    });

    mock.getRequest().onToolCall?.({
      itemId: "item-6",
      callId: "tool-call-optout",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "do a thing" },
    });

    // Gate disabled: reaches the agent path, which reports unavailable (no runtime),
    // not the recording refusal.
    const refused = mock.submitToolResult.mock.calls.some(
      (args) =>
        typeof (args[1] as { text?: string })?.text === "string" &&
        (args[1] as { text: string }).text.includes("recording isn't active"),
    );
    expect(refused).toBe(false);
  });

  it("drops pre-recording transcripts from the consult context (Media Access API)", async () => {
    consultSpy.mockClear();
    const ctx = createMockSession("inactive");
    const mock = createMockProvider();
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        tools: [CONSULT_TOOL],
        agentRuntime: { resolveThinkingDefault: () => undefined } as unknown as CoreAgentDeps,
        voiceConfig: {
          agentId: "main",
          realtime: { toolPolicy: "owner" },
        } as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
      },
    });
    const req = mock.getRequest();

    // Final transcript BEFORE recording is active — must not be retained.
    req.onTranscript?.("user", "pre recording secret", true);
    // Recording goes active; subsequent transcript is retained.
    call.setRecordingActive(true);
    req.onTranscript?.("user", "after recording question", true);

    req.onToolCall?.({
      itemId: "item-7",
      callId: "tool-call-ctx",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "what did I say" },
    });

    await vi.waitFor(() => expect(consultSpy).toHaveBeenCalled());
    const passedTranscript = JSON.stringify(consultSpy.mock.calls.at(-1)?.[0]?.transcript ?? []);
    expect(passedTranscript).not.toContain("pre recording secret");
    expect(passedTranscript).toContain("after recording question");
  });

  it("cues an expression early on the assistant transcript, deduped and self-correcting", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: { provider: mock.provider, providerConfig: {} },
    });
    const req = mock.getRequest();

    const expressions = () =>
      ctx.sent.filter(
        (m): m is { type: string; emotion: string } =>
          typeof m === "object" && m !== null && (m as { type?: unknown }).type === "expression",
      );

    // Partial (non-final) assistant chunk already cues — no waiting for the final.
    req.onTranscript?.("assistant", "Sorry,", false);
    expect(expressions().at(-1)?.emotion).toBe("sad");
    // Same emotion again → no duplicate cue.
    req.onTranscript?.("assistant", "Sorry, I", false);
    expect(expressions()).toHaveLength(1);
    // Emotion shifts as more text arrives (a surprise marker overrides the earlier "sorry") → corrected cue.
    req.onTranscript?.("assistant", "Sorry, wow — this is incredible!", true);
    expect(expressions().at(-1)?.emotion).toBe("surprised");
    // User turns never cue expression.
    req.onTranscript?.("user", "wow really", true);
    expect(expressions().filter((e) => e.emotion === "surprised")).toHaveLength(1);
  });

  it("ambient vision pushes the latest changed frame, deduped", () => {
    vi.useFakeTimers();
    try {
      const ctx = createMockSession();
      const mock = createMockProvider();
      let frameData = "AAAA";
      createMsteamsRealtimeCall({
        session: ctx.session,
        deps: {
          provider: mock.provider,
          providerConfig: {},
          getLatestFrame: () => ({
            source: "screenshare",
            dataBase64: frameData,
            mime: "image/jpeg",
            width: 1,
            height: 1,
            ts: 0,
          }),
          visionBudget: new VisionBudget(0), // unlimited
        },
      });

      vi.advanceTimersByTime(6000);
      expect(mock.sendImage).toHaveBeenCalledTimes(1); // first frame pushed
      vi.advanceTimersByTime(6000);
      expect(mock.sendImage).toHaveBeenCalledTimes(1); // unchanged → skipped
      frameData = "BBBB";
      vi.advanceTimersByTime(6000);
      expect(mock.sendImage).toHaveBeenCalledTimes(2); // changed → pushed
      expect(mock.sendImage.mock.calls.at(-1)?.[0]).toMatchObject({
        dataBase64: "BBBB",
        mime: "image/jpeg",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("show_to_caller displays an agent-produced image on the tile", async () => {
    consultSpy.mockClear();
    // A real 1×1 PNG on disk — the agent run "produces" it; the bridge reads + displays it.
    const imgPath = join(tmpdir(), `oc-show-test-${process.pid}-${Date.now()}.png`);
    writeFileSync(
      imgPath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    try {
      consultSpy.mockResolvedValueOnce({ text: "Here's my screen.", mediaPaths: [imgPath] });
      const ctx = createMockSession();
      const mock = createMockProvider();
      createMsteamsRealtimeCall({
        session: ctx.session,
        deps: {
          provider: mock.provider,
          providerConfig: {},
          tools: [CONSULT_TOOL],
          toolPolicy: "owner",
          agentRuntime: { resolveThinkingDefault: () => "high" } as unknown as CoreAgentDeps,
          voiceConfig: { realtime: {}, agentId: "main" } as unknown as VoiceCallConfig,
          cfg: {} as unknown as OpenClawConfig,
        },
      });

      mock.getRequest().onToolCall?.({
        itemId: "i-show-1",
        callId: "show-1",
        name: "show_to_caller",
        args: { request: "show me your screen" },
      });

      await vi.waitFor(() =>
        expect(
          ctx.sent.some(
            (m) =>
              typeof m === "object" &&
              m !== null &&
              (m as { type?: unknown }).type === "display.image",
          ),
        ).toBe(true),
      );
      const display = ctx.sent.find(
        (m) =>
          typeof m === "object" && m !== null && (m as { type?: unknown }).type === "display.image",
      ) as { dataBase64: string; mime: string };
      expect(display.mime).toBe("image/png");
      expect(typeof display.dataBase64).toBe("string");
      expect(display.dataBase64.length).toBeGreaterThan(0);
    } finally {
      rmSync(imgPath, { force: true });
    }
  });
});
