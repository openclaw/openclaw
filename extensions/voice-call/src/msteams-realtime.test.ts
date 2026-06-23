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
import {
  createMsteamsRealtimeCall,
  type MsteamsRealtimeDeps,
  pcm16Rms,
  shouldSuppressEcho,
  toTileCaption,
} from "./msteams-realtime.js";
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
  triggerGreeting: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
} {
  let request: RealtimeVoiceBridgeCreateRequest | undefined;
  const submitToolResult = vi.fn();
  const sendAudio = vi.fn();
  const sendImage = vi.fn();
  const triggerGreeting = vi.fn();
  const sendUserMessage = vi.fn();

  const bridge: RealtimeVoiceBridge = {
    supportsToolResultContinuation: true,
    connect: async () => {},
    sendAudio,
    sendImage,
    setMediaTimestamp: () => {},
    submitToolResult,
    acknowledgeMark: () => {},
    triggerGreeting,
    sendUserMessage,
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
    triggerGreeting,
    sendUserMessage,
  };
}

const CONSULT_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  description: "consult",
  parameters: { type: "object", properties: {} },
};

describe("pcm16Rms (echo-guard loudness)", () => {
  function tone(amplitude: number, samples = 320): Buffer {
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) {
      buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
    }
    return buf;
  }

  it("is 0 for silence and ~1 for a full-scale tone", () => {
    expect(pcm16Rms(Buffer.alloc(640))).toBe(0);
    expect(pcm16Rms(tone(32767))).toBeGreaterThan(0.9);
  });

  it("keeps quiet (echo-level) audio below the barge-in gate, loud speech above it", () => {
    // Quiet echo-ish audio stays under the 0.04 barge-in threshold → suppressed during playback.
    expect(pcm16Rms(tone(600))).toBeLessThan(0.04);
    // Genuine speech is well above it → passes through as a barge-in.
    expect(pcm16Rms(tone(6000))).toBeGreaterThan(0.04);
  });

  it("returns 0 for an empty or odd-length buffer", () => {
    expect(pcm16Rms(Buffer.alloc(0))).toBe(0);
    expect(pcm16Rms(Buffer.from([1]))).toBe(0);
  });
});

describe("shouldSuppressEcho (allowBargeIn / opening greeting loop)", () => {
  function tone(amplitude: number, samples = 320): Buffer {
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) {
      buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
    }
    return buf;
  }
  const loud = tone(6000); // > 0.04 barge-in RMS
  const quiet = tone(600); // < 0.04
  const inWindow = Date.now() + 5000;
  const past = Date.now() - 5000;

  it("suppresses quiet echo but passes a loud barge-in during playback (default)", () => {
    expect(shouldSuppressEcho(quiet, inWindow)).toBe(true);
    expect(shouldSuppressEcho(loud, inWindow)).toBe(false);
  });

  it("with allowBargeIn:false (opening greeting), suppresses even LOUD in-window input", () => {
    // The opening echo-loop fix: before the caller's first turn, loud greeting echo must not pass.
    expect(shouldSuppressEcho(loud, inWindow, { allowBargeIn: false })).toBe(true);
    expect(shouldSuppressEcho(quiet, inWindow, { allowBargeIn: false })).toBe(true);
  });

  it("allowBargeIn:false still passes input OUTSIDE the playback window", () => {
    expect(shouldSuppressEcho(loud, past, { allowBargeIn: false })).toBe(false);
  });

  it("never suppresses when suppressInputDuringPlayback is disabled", () => {
    expect(
      shouldSuppressEcho(quiet, inWindow, {
        suppressInputDuringPlayback: false,
        allowBargeIn: false,
      }),
    ).toBe(false);
  });
});

describe("toTileCaption", () => {
  it("collapses whitespace and trims", () => {
    expect(toTileCaption("  Here's   the\nchart  ")).toBe("Here's the chart");
  });

  it("returns undefined for empty or blank text", () => {
    expect(toTileCaption(undefined)).toBeUndefined();
    expect(toTileCaption("   \n  ")).toBeUndefined();
  });

  it("truncates long text to 140 chars with an ellipsis", () => {
    const cap = toTileCaption("x".repeat(200));
    expect(cap).toHaveLength(140);
    expect(cap?.endsWith("…")).toBe(true);
  });
});

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

  it("opening greeting: suppresses caller audio incl. loud echo until the first caller turn, then allows barge-in", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: { provider: mock.provider, providerConfig: {} },
    });
    const req = mock.getRequest();

    const tone = (amplitude: number): Buffer => {
      const buf = Buffer.alloc(640);
      for (let i = 0; i < 320; i += 1) {
        buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, i * 2);
      }
      return buf;
    };

    // The bot's greeting is playing (model audio) — stamps the echo-suppression playout window.
    req.onAudio(Buffer.alloc(960));
    mock.sendAudio.mockClear();

    // Before the caller has spoken, ALL in-window input is treated as echo — even a LOUD frame (the
    // bot's own greeting echoing back on a speakerphone) — so the model can't re-greet itself in a loop.
    call.pushAudio(tone(500));
    call.pushAudio(tone(8000));
    expect(mock.sendAudio).not.toHaveBeenCalled();

    // The caller actually speaks once → the opening echo-only window ends; normal RMS barge-in resumes.
    req.onTranscript?.("user", "hello", true);
    req.onAudio(Buffer.alloc(960)); // bot speaking again
    mock.sendAudio.mockClear();

    // Quiet echo still dropped; a genuine loud barge-in now reaches the model.
    call.pushAudio(tone(500));
    expect(mock.sendAudio).not.toHaveBeenCalled();
    call.pushAudio(tone(8000));
    expect(mock.sendAudio).toHaveBeenCalledTimes(1);
  });

  it("DTMF respects the recording gate — ignored while inactive, accepted after recording is active", () => {
    const ctx = createMockSession("inactive"); // Media Access API: recording not active yet
    const mock = createMockProvider();
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: { provider: mock.provider, providerConfig: {} },
    });

    // Recording inactive: a keypress is dropped — not forwarded to the realtime model.
    call.notifyDtmf("1");
    expect(mock.sendUserMessage).not.toHaveBeenCalled();

    // Recording goes active → the next keypress reaches the model.
    call.setRecordingActive(true);
    call.notifyDtmf("2");
    expect(mock.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(String(mock.sendUserMessage.mock.calls[0]?.[0] ?? "")).toContain('"2"');
  });

  it("echo guard tracks the playout clock, not last-send time (burst-generated audio)", () => {
    vi.useFakeTimers();
    try {
      const ctx = createMockSession();
      const mock = createMockProvider();
      const call = createMsteamsRealtimeCall({
        session: ctx.session,
        deps: { provider: mock.provider, providerConfig: {} },
      });
      const req = mock.getRequest();

      // The model bursts ~10s of audio in one delta (faster than realtime); the worker queues it and
      // plays it out over wall-clock time. 24 kHz 16-bit mono → 480000 bytes ≈ 10s.
      req.onAudio(Buffer.alloc(480_000));
      mock.sendAudio.mockClear();

      const quiet = Buffer.alloc(640);
      for (let i = 0; i < 320; i += 1) {
        quiet.writeInt16LE(i % 2 === 0 ? 500 : -500, i * 2);
      }

      // 2s later the OLD last-send window (600ms) would have expired — but the bot is still speaking
      // on the call, so its echo must still be suppressed.
      vi.advanceTimersByTime(2_000);
      call.pushAudio(quiet);
      expect(mock.sendAudio).not.toHaveBeenCalled();

      // Once the playout estimate + window has passed, quiet caller audio flows again.
      vi.advanceTimersByTime(10_000);
      call.pushAudio(quiet);
      expect(mock.sendAudio).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notify mode: signals onDeliveryComplete once after the model's audio drains", () => {
    vi.useFakeTimers();
    try {
      const ctx = createMockSession();
      const mock = createMockProvider();
      const onDeliveryComplete = vi.fn();
      createMsteamsRealtimeCall({
        session: ctx.session,
        deps: { provider: mock.provider, providerConfig: {}, onDeliveryComplete },
      });
      const req = mock.getRequest();

      // A partial, and a non-assistant final, do not start the drain watch.
      req.onTranscript?.("assistant", "Here is", false);
      req.onTranscript?.("user", "ok", true);
      vi.advanceTimersByTime(5000);
      expect(onDeliveryComplete).not.toHaveBeenCalled();

      // First assistant-final starts the drain watch — it is NOT fired synchronously.
      req.onTranscript?.("assistant", "Here is your result.", true);
      expect(onDeliveryComplete).not.toHaveBeenCalled();

      // Once the audio has been quiet long enough it fires exactly once, even across later turns.
      vi.advanceTimersByTime(2000);
      req.onTranscript?.("assistant", "Anything else?", true);
      vi.advanceTimersByTime(2000);
      expect(onDeliveryComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifyInboundFrame pushes a changed frame to the model and dedupes an unchanged one", () => {
    const ctx = createMockSession(); // recording active
    const mock = createMockProvider();
    let frameData = "AAA";
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        getLatestFrame: (source) =>
          source === "camera"
            ? undefined
            : {
                source: "screenshare",
                dataBase64: frameData,
                mime: "image/jpeg",
                width: 100,
                height: 100,
                ts: 0,
              },
      },
    });

    call.notifyInboundFrame();
    expect(mock.sendImage).toHaveBeenCalledTimes(1);

    // Same frame → deduped (no second push).
    call.notifyInboundFrame();
    expect(mock.sendImage).toHaveBeenCalledTimes(1);

    // Scene change → pushed again.
    frameData = "BBB";
    call.notifyInboundFrame();
    expect(mock.sendImage).toHaveBeenCalledTimes(2);
  });

  it("pushes camera and screen-share simultaneously when the caller shares both", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        getLatestFrame: (source) => ({
          source: source === "camera" ? "camera" : "screenshare",
          dataBase64: source === "camera" ? "CAM" : "SCREEN",
          mime: "image/jpeg",
          width: 100,
          height: 100,
          ts: 0,
        }),
      },
    });

    call.notifyInboundFrame();
    // Both sources present and distinct → one push each (screen-share + camera).
    expect(mock.sendImage).toHaveBeenCalledTimes(2);
    // Unchanged on the next tick → deduped per source.
    call.notifyInboundFrame();
    expect(mock.sendImage).toHaveBeenCalledTimes(2);
  });

  it("cues a 'thinking' expression while a waiting tool runs", () => {
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

    const thinking = ctx.sent.find(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        (m as { type?: string }).type === "expression" &&
        (m as { emotion?: string }).emotion === "thinking",
    );
    expect(thinking).toBeDefined();
  });

  it("group gate (deterministic): drops model audio in a meeting until the caller addresses the bot", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        groupCallGate: { requireAddress: true, wakePhrases: ["aria"], followUpWindowMs: 12_000 },
      },
    });
    const req = mock.getRequest();
    call.setHumanCount(3); // meeting

    const audioFrames = (): number =>
      ctx.sent.filter((m) => (m as { type?: string }).type === "audio.frame").length;

    // Unaddressed caller turn → the model's reply audio is dropped at the egress.
    req.onTranscript?.("user", "so as I was saying about the budget", true);
    req.onAudio(Buffer.alloc(960));
    expect(audioFrames()).toBe(0);

    // Addressed turn opens the gate → audio flows.
    req.onTranscript?.("user", "hey aria, what do you think?", true);
    req.onAudio(Buffer.alloc(960));
    expect(audioFrames()).toBe(1);

    // 1:1 never gates regardless of address state.
    call.setHumanCount(1);
    req.onTranscript?.("user", "back to the budget", true);
    req.onAudio(Buffer.alloc(960));
    expect(audioFrames()).toBe(2);
  });

  it("group gate: a wake phrase on a PARTIAL transcript reopens audio (fragmented/echo-clipped wake)", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        groupCallGate: { requireAddress: true, wakePhrases: ["aria"], followUpWindowMs: 12_000 },
      },
    });
    const req = mock.getRequest();
    call.setHumanCount(3);
    const audioFrames = (): number =>
      ctx.sent.filter((m) => (m as { type?: string }).type === "audio.frame").length;

    // Unaddressed turn → dropped.
    req.onTranscript?.("user", "the budget again", true);
    req.onAudio(Buffer.alloc(960));
    expect(audioFrames()).toBe(0);

    // Wake phrase arrives ONLY as a partial (never finalized) → still opens the gate. The old latched
    // gate updated only on a FINAL transcript, so this case stayed silent forever.
    req.onTranscript?.("user", "hey aria", false);
    req.onAudio(Buffer.alloc(960));
    expect(audioFrames()).toBe(1);
  });

  it("group gate: self-heals on a timer — closes after the follow-up window, reopens on re-address", () => {
    vi.useFakeTimers();
    try {
      const ctx = createMockSession();
      const mock = createMockProvider();
      const call = createMsteamsRealtimeCall({
        session: ctx.session,
        deps: {
          provider: mock.provider,
          providerConfig: {},
          groupCallGate: { requireAddress: true, wakePhrases: ["aria"], followUpWindowMs: 12_000 },
        },
      });
      const req = mock.getRequest();
      call.setHumanCount(3);
      const audioFrames = (): number =>
        ctx.sent.filter((m) => (m as { type?: string }).type === "audio.frame").length;

      // Addressed → open.
      req.onTranscript?.("user", "hey aria", true);
      req.onAudio(Buffer.alloc(960));
      expect(audioFrames()).toBe(1);

      // Window elapses with NO further transcripts → gate closes by time (never a permanent latch).
      vi.advanceTimersByTime(13_000);
      req.onAudio(Buffer.alloc(960));
      expect(audioFrames()).toBe(1);

      // Re-address after the silence → reopens. (The old boolean latch could never recover here.)
      req.onTranscript?.("user", "aria you there", true);
      req.onAudio(Buffer.alloc(960));
      expect(audioFrames()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("look_at_screen history scope reviews keyframes from earlier in the call", async () => {
    consultSpy.mockClear();
    consultSpy.mockResolvedValueOnce({ text: "Slide 3 covered pricing." });
    const ctx = createMockSession();
    const mock = createMockProvider();
    const history = [
      {
        source: "screenshare" as const,
        dataBase64: "S1",
        mime: "image/jpeg",
        width: 1,
        height: 1,
        ts: 1,
      },
      {
        source: "screenshare" as const,
        dataBase64: "S2",
        mime: "image/jpeg",
        width: 1,
        height: 1,
        ts: 2,
      },
      {
        source: "screenshare" as const,
        dataBase64: "S3",
        mime: "image/jpeg",
        width: 1,
        height: 1,
        ts: 3,
      },
    ];
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        toolPolicy: "safe-read-only",
        agentRuntime: { resolveThinkingDefault: () => "high" } as unknown as CoreAgentDeps,
        voiceConfig: {
          realtime: {},
          agentId: "main",
          responseTimeoutMs: 5000,
        } as unknown as VoiceCallConfig,
        cfg: {} as unknown as OpenClawConfig,
        getLatestFrame: () => history.at(-1),
        getFrameHistory: () => history,
      },
    });

    mock.getRequest().onToolCall?.({
      itemId: "i1",
      callId: "tc1",
      name: "look_at_screen",
      args: { question: "what did the earlier slide say?", scope: "history" },
    });
    await vi.waitFor(() => {
      expect(consultSpy).toHaveBeenCalledTimes(1);
    });
    const consultArgs = consultSpy.mock.calls[0]?.[0] as { images?: unknown[] } | undefined;
    expect(consultArgs?.images).toHaveLength(3);
  });

  it("verbal interrupt ('stop') flushes playback deterministically while audio is playing out", () => {
    vi.useFakeTimers();
    try {
      const ctx = createMockSession();
      const mock = createMockProvider();
      createMsteamsRealtimeCall({
        session: ctx.session,
        deps: { provider: mock.provider, providerConfig: {} },
      });
      const req = mock.getRequest();
      const cancels = (): number =>
        ctx.sent.filter((m) => (m as { type?: string }).type === "assistant.cancel").length;

      // ~10s of model audio queued for playout.
      req.onAudio(Buffer.alloc(480_000));

      // A normal caller turn does NOT flush.
      req.onTranscript?.("user", "tell me more about the budget", true);
      expect(cancels()).toBe(0);

      // "Stop." while still playing → immediate assistant.cancel (worker queue flush).
      req.onTranscript?.("user", "Stop.", true);
      expect(cancels()).toBe(1);

      // After playout ended, "stop" has nothing to flush → no extra cancel.
      vi.advanceTimersByTime(15_000);
      req.onTranscript?.("user", "stop", true);
      expect(cancels()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("meeting recap: posts minutes on close when enabled, and stays off by default", async () => {
    consultSpy.mockClear();
    const makeCall = (meetingRecap: boolean) => {
      const ctx = createMockSession();
      const mock = createMockProvider();
      const call = createMsteamsRealtimeCall({
        session: ctx.session,
        deps: {
          provider: mock.provider,
          providerConfig: {},
          agentRuntime: { resolveThinkingDefault: () => "high" } as unknown as CoreAgentDeps,
          voiceConfig: {
            realtime: {},
            agentId: "main",
            responseTimeoutMs: 5000,
            msteams: { meetingRecap },
          } as unknown as VoiceCallConfig,
          cfg: {} as unknown as OpenClawConfig,
        },
      });
      const req = mock.getRequest();
      // Four finished turns = a real conversation worth recapping.
      req.onTranscript?.("user", "let's review the budget", true);
      req.onTranscript?.("assistant", "the budget is on track", true);
      req.onTranscript?.("user", "decide we ship friday", true);
      req.onTranscript?.("assistant", "noted, shipping friday", true);
      return call;
    };

    // Disabled (default) → no recap run.
    makeCall(false).close();
    expect(consultSpy).not.toHaveBeenCalled();

    // Enabled → two detached runs: (1) author the summary prose, (2) deliver it with the .docx.
    consultSpy.mockClear();
    makeCall(true).close();
    await vi.waitFor(() => {
      expect(consultSpy).toHaveBeenCalledTimes(2);
    });
    type RecapCall = {
      args?: { question?: string };
      deliveryContext?: { to?: string };
      extraSystemPrompt?: string;
      trustLocalMedia?: boolean;
    };
    const summary = consultSpy.mock.calls[0]?.[0] as RecapCall | undefined;
    const send = consultSpy.mock.calls[1]?.[0] as RecapCall | undefined;

    // Step 1 — the summary run sees the transcript and is told to author minutes (no send/file write).
    expect(String(summary?.args?.question)).toContain("meeting minutes");
    expect(String(summary?.args?.question)).toContain("shipping friday");
    expect(String(summary?.extraSystemPrompt)).toContain("do NOT call the message tool");
    // Both runs LOCK delivery to the caller (1:1 → user:<callerAadId>), so a missing DM reference can't
    // fall back to the operator's own chat. (bugfix: minutes delivered to wrong recipient)
    expect(summary?.deliveryContext?.to).toBe("user:aad-1");

    // Step 2 — the send run delivers to the same locked target and attaches the prebuilt .docx as media.
    expect(send?.deliveryContext?.to).toBe("user:aad-1");
    expect(String(send?.extraSystemPrompt)).toContain('target "user:aad-1"');
    expect(String(send?.extraSystemPrompt)).toContain("meeting-minutes-call-1.docx");
    expect(send?.trustLocalMedia).toBe(true);
  });

  it("outbound greeting fires on answer (recording active), not on connect", () => {
    const ctx = createMockSession("inactive"); // ringing — not yet answered
    const mock = createMockProvider();
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        greetingInstructions: "Deliver the Dubai time.",
        greetingOnRecordingActive: true,
      },
    });
    mock.getRequest();

    // Still ringing (no recording.status yet) → the greeting must not have been spoken...
    expect(mock.triggerGreeting).not.toHaveBeenCalled();
    // ...and only on answer (recording active) is it spoken, exactly once across repeats.
    call.setRecordingActive(true);
    call.setRecordingActive(true);
    expect(mock.triggerGreeting).toHaveBeenCalledTimes(1);
    expect(mock.triggerGreeting).toHaveBeenCalledWith("Deliver the Dubai time.");
  });

  it("surfaces a DTMF keypress to the model as a user message (#21)", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    const call = createMsteamsRealtimeCall({
      session: ctx.session,
      deps: { provider: mock.provider, providerConfig: {} },
    });
    call.notifyDtmf("1");
    expect(mock.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(mock.sendUserMessage.mock.calls[0]?.[0]).toContain('"1"');
  });

  it("injects the caller's name into the realtime instructions (roster greeting)", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: {
        provider: mock.provider,
        providerConfig: {},
        instructions: "You are a helpful assistant.",
      },
    });
    const req = mock.getRequest();
    expect(req.instructions).toContain("You are a helpful assistant.");
    expect(req.instructions).toContain("CALLER IDENTITY");
    expect(req.instructions).toContain("Caller"); // session.caller.displayName
  });

  it("adds the bilingual preamble only when msteams.bilingual is on (#19)", () => {
    const build = (bilingual: boolean) => {
      const ctx = createMockSession();
      const mock = createMockProvider();
      createMsteamsRealtimeCall({
        session: ctx.session,
        deps: {
          provider: mock.provider,
          providerConfig: {},
          instructions: "Base.",
          voiceConfig: { realtime: {}, msteams: { bilingual } } as unknown as VoiceCallConfig,
        },
      });
      return mock.getRequest().instructions ?? "";
    };
    expect(build(true)).toContain("BILINGUAL");
    expect(build(false)).not.toContain("BILINGUAL");
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

  it("provider onClose (realtime WS drop) hangs up the Teams session (B2)", () => {
    // Without this, onClose only set closed=true: the caller sat in silence and a later
    // close(reason) early-returned, leaving the Teams call un-hangup-able.
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: { provider: mock.provider, providerConfig: {} },
    });

    mock.getRequest().onClose?.("error");

    expect(ctx.closedReason).toBe("realtime-closed");
  });

  it("a failed realtime connect() hangs up the Teams session (B1 trigger path)", async () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    // The bridge never comes up: connect() rejects.
    const failingProvider = {
      id: "openai",
      label: "Mock Realtime",
      isConfigured: () => true,
      createBridge: (req: RealtimeVoiceBridgeCreateRequest) => {
        const bridge = (
          mock.provider as unknown as {
            createBridge: (r: RealtimeVoiceBridgeCreateRequest) => RealtimeVoiceBridge;
          }
        ).createBridge(req);
        return {
          ...bridge,
          connect: async () => {
            throw new Error("model down");
          },
        };
      },
    } as unknown as RealtimeVoiceProviderPlugin;

    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: { provider: failingProvider, providerConfig: {} },
    });

    await vi.waitFor(() => {
      expect(ctx.closedReason).toBe("realtime-unavailable");
    });
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

  it("exposes look_at_screen AND show_to_caller under 'safe-read-only' (the default policy)", () => {
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
    // show_to_caller is a CORE call feature; its production consult pins "owner" internally, so it is
    // offered under the default policy too (off only under "none"). (bugfix: screen-share "I can't share")
    expect(toolNames).toContain("show_to_caller");
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
          getLatestFrame: (source) =>
            source === "camera"
              ? undefined
              : {
                  source: "screenshare",
                  dataBase64: frameData,
                  mime: "image/jpeg",
                  width: 1,
                  height: 1,
                  ts: 0,
                },
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

  it("answers an unhandled custom tool call instead of stalling the model turn (B6)", () => {
    const ctx = createMockSession();
    const mock = createMockProvider();
    const customTool: RealtimeVoiceTool = {
      type: "function",
      name: "operator_custom_tool",
      description: "operator-configured",
      parameters: { type: "object", properties: {} },
    };
    createMsteamsRealtimeCall({
      session: ctx.session,
      deps: { provider: mock.provider, providerConfig: {}, tools: [CONSULT_TOOL, customTool] },
    });

    mock.getRequest().onToolCall?.({
      itemId: "i-custom",
      callId: "custom-1",
      name: "operator_custom_tool",
      args: {},
    });

    // Previously this fell through without a submitToolResult — the model's turn waited forever.
    expect(mock.submitToolResult).toHaveBeenCalledWith(
      "custom-1",
      expect.objectContaining({ text: expect.stringContaining("not available") }),
      undefined,
    );
  });

  it("transcript coalescing never merges different speakers (B7)", async () => {
    consultSpy.mockClear();
    const ctx = createMockSession();
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

    call.setCurrentSpeaker("Sara");
    req.onTranscript?.("user", "the budget is fine", true);
    call.setCurrentSpeaker("Omar");
    req.onTranscript?.("user", "no it is not", true);

    req.onToolCall?.({
      itemId: "i-b7",
      callId: "c-b7",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "q" },
    });
    await vi.waitFor(() => expect(consultSpy).toHaveBeenCalled());
    const transcript =
      (consultSpy.mock.calls.at(-1)?.[0] as { transcript?: Array<{ role: string; text: string }> })
        ?.transcript ?? [];
    // Two attributed entries — NOT one merged entry crediting Omar's words to Sara.
    expect(transcript).toEqual([
      { role: "user", text: "Sara: the budget is fine" },
      { role: "user", text: "Omar: no it is not" },
    ]);
  });

  it("caps a coalesced transcript entry so one speaker's run cannot grow unbounded (B7)", async () => {
    consultSpy.mockClear();
    const ctx = createMockSession();
    const mock = createMockProvider();
    createMsteamsRealtimeCall({
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

    const fragment = "x".repeat(400);
    for (let i = 0; i < 5; i += 1) {
      req.onTranscript?.("user", fragment, true);
    }

    req.onToolCall?.({
      itemId: "i-b7cap",
      callId: "c-b7cap",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      args: { question: "q" },
    });
    await vi.waitFor(() => expect(consultSpy).toHaveBeenCalled());
    const transcript =
      (consultSpy.mock.calls.at(-1)?.[0] as { transcript?: Array<{ text: string }> })?.transcript ??
      [];
    // 5 × 400-char fragments split across entries instead of one ever-growing entry.
    expect(transcript.length).toBeGreaterThan(1);
    for (const entry of transcript) {
      expect(entry.text.length).toBeLessThanOrEqual(1400);
    }
  });

  it("history-scope look does not poison the live-look cache (B9)", async () => {
    consultSpy.mockClear();
    const ctx = createMockSession();
    const mock = createMockProvider();
    const liveFrame = {
      source: "screenshare" as const,
      dataBase64: "LIVE",
      mime: "image/jpeg",
      width: 1,
      height: 1,
      ts: 0,
    };
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
        getLatestFrame: () => liveFrame,
        getFrameHistory: () => [liveFrame], // history ends at the same (static) frame
      },
    });
    const req = mock.getRequest();

    consultSpy.mockResolvedValueOnce({ text: "live answer" });
    req.onToolCall?.({
      itemId: "i-l1",
      callId: "look-live-1",
      name: "look_at_screen",
      args: { question: "now" },
    });
    await vi.waitFor(() => expect(consultSpy).toHaveBeenCalledTimes(1));

    consultSpy.mockResolvedValueOnce({ text: "history answer" });
    req.onToolCall?.({
      itemId: "i-h1",
      callId: "look-history-1",
      name: "look_at_screen",
      args: { question: "earlier", scope: "history" },
    });
    await vi.waitFor(() => expect(consultSpy).toHaveBeenCalledTimes(2));

    // A live look on the SAME static frame must serve the cached LIVE answer — the history run
    // previously overwrote the cache, so this returned "history answer".
    mock.submitToolResult.mockClear();
    req.onToolCall?.({
      itemId: "i-l2",
      callId: "look-live-2",
      name: "look_at_screen",
      args: { question: "now again" },
    });
    await vi.waitFor(() => expect(mock.submitToolResult).toHaveBeenCalled());
    expect(consultSpy).toHaveBeenCalledTimes(2); // cache hit — no third vision run
    expect(mock.submitToolResult).toHaveBeenCalledWith(
      "look-live-2",
      { text: "live answer" },
      undefined,
    );
  });

  it("refuses post_meeting_minutes until recording status is active (B10)", () => {
    consultSpy.mockClear();
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
      itemId: "i-min",
      callId: "minutes-1",
      name: "post_meeting_minutes",
      args: {},
    });

    expect(mock.submitToolResult).toHaveBeenCalledWith(
      "minutes-1",
      expect.objectContaining({ text: expect.stringContaining("recording isn't active") }),
      undefined,
    );
    expect(consultSpy).not.toHaveBeenCalled();
  });

  it("refuses a background task with no task text instead of acking a no-op (B10)", () => {
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
      itemId: "i-task-empty",
      callId: "task-empty",
      name: "openclaw_agent_task",
      args: {},
    });

    // Previously this acked "I'm on it … I'll message you" then silently did nothing.
    const acked = mock.submitToolResult.mock.calls.some(
      (args) =>
        typeof (args[1] as { text?: string })?.text === "string" &&
        (args[1] as { text: string }).text.includes("I'm on it"),
    );
    expect(acked).toBe(false);
    expect(mock.submitToolResult).toHaveBeenCalledWith(
      "task-empty",
      expect.objectContaining({ text: expect.stringContaining("didn't catch") }),
      undefined,
    );
  });

  it("a failed ambient vision push stays retryable and refunds its budget hit (B12)", () => {
    vi.useFakeTimers();
    try {
      const ctx = createMockSession();
      const mock = createMockProvider();
      // One slot per minute: a burned hit on the failed push would starve the retry below.
      const budget = new VisionBudget(1);
      mock.sendImage.mockImplementationOnce(() => {
        throw new Error("bridge not ready");
      });
      createMsteamsRealtimeCall({
        session: ctx.session,
        deps: {
          provider: mock.provider,
          providerConfig: {},
          getLatestFrame: (source) =>
            source === "camera"
              ? undefined
              : {
                  source: "screenshare",
                  dataBase64: "AAAA",
                  mime: "image/jpeg",
                  width: 1,
                  height: 1,
                  ts: 0,
                },
          visionBudget: budget,
        },
      });

      vi.advanceTimersByTime(6000); // first push throws
      expect(mock.sendImage).toHaveBeenCalledTimes(1);
      // Frame NOT latched as pushed + budget hit refunded → the backstop retries it.
      vi.advanceTimersByTime(6000);
      expect(mock.sendImage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
