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

// Capture the transcript handed to the consult agent, while keeping the rest of
// the realtime-voice SDK (createRealtimeVoiceBridgeSession, etc.) real.
const consultSpy = vi.hoisted(() =>
  vi.fn(async (_opts?: { transcript?: unknown }) => ({ text: "ok" })),
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
    send: (message) => sent.push(message),
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
} {
  let request: RealtimeVoiceBridgeCreateRequest | undefined;
  const submitToolResult = vi.fn();
  const sendAudio = vi.fn();

  const bridge: RealtimeVoiceBridge = {
    supportsToolResultContinuation: true,
    connect: async () => {},
    sendAudio,
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
});
