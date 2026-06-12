import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { VoiceCallConfig } from "../config.js";
import { CallManager } from "../manager.js";
import { installVoiceCallStateRuntimeForTests } from "../manager.test-harness.js";
import type { MsteamsTtsProvider } from "../msteams-tts.js";
import { createVoiceCallBaseConfig } from "../test-fixtures.js";
import type { HangupCallInput, InitiateCallInput, PlayTtsInput, WebhookContext } from "../types.js";
import { MsteamsProvider } from "./msteams.js";

const generateVoiceResponseMock = vi.hoisted(() => vi.fn());

vi.mock("../response-generator.js", () => ({
  generateVoiceResponse: generateVoiceResponseMock,
}));

// Outbound place-call uses the SSRF-guarded fetch; mock it (returns { response, release }).
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const STUB_WEBHOOK_CTX: WebhookContext = {
  rawBody: "",
  headers: {},
  url: "/",
} as unknown as WebhookContext;

const STUB_HANGUP_INPUT: HangupCallInput = {} as unknown as HangupCallInput;
const STUB_PLAY_TTS_INPUT: PlayTtsInput = {} as unknown as PlayTtsInput;
const STUB_INITIATE_INPUT: InitiateCallInput = {} as unknown as InitiateCallInput;

const SECRET = "test-shared-secret";
const STREAM_PATH = "/voice/msteams/stream";

function signHmac(ts: number, callId: string): string {
  return crypto.createHmac("sha256", SECRET).update(`${ts}.${callId}`).digest("hex");
}

/**
 * Minimal realtime-voice provider whose bridge does nothing. `created()` flips once the
 * provider bridges a call, so tests can wait for the realtime session.start to register.
 * `failConnect` makes the bridge's connect() reject (model never comes up).
 */
function createMockRealtimeProvider(opts?: { failConnect?: boolean }): {
  plugin: RealtimeVoiceProviderPlugin;
  created: () => boolean;
} {
  let created = false;
  const bridge: RealtimeVoiceBridge = {
    supportsToolResultContinuation: true,
    connect: async () => {
      if (opts?.failConnect) {
        throw new Error("model down");
      }
    },
    sendAudio: () => {},
    sendImage: () => {},
    setMediaTimestamp: () => {},
    submitToolResult: () => {},
    acknowledgeMark: () => {},
    close: () => {},
    isConnected: () => true,
  };
  const plugin = {
    id: "openai",
    label: "Mock Realtime",
    isConfigured: () => true,
    createBridge: () => {
      created = true;
      return bridge;
    },
  } as unknown as RealtimeVoiceProviderPlugin;
  return { plugin, created: () => created };
}

function randomPort(): number {
  return 31000 + Math.floor(Math.random() * 9000);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("MsteamsProvider (stub surface)", () => {
  it("identifies as the msteams provider", () => {
    const p = new MsteamsProvider({});
    expect(p.name).toBe("msteams");
  });

  it("verifyWebhook accepts unconditionally — Teams does not use the webhook plane", () => {
    const p = new MsteamsProvider({});
    expect(p.verifyWebhook(STUB_WEBHOOK_CTX)).toEqual({ ok: true });
  });

  it("parseWebhookEvent returns no events", () => {
    const p = new MsteamsProvider({});
    const result = p.parseWebhookEvent(STUB_WEBHOOK_CTX);
    expect(result.events).toEqual([]);
    expect(result.statusCode).toBe(204);
  });

  it("initiateCall throws when outbound calling is not enabled", async () => {
    const p = new MsteamsProvider({});
    await expect(p.initiateCall(STUB_INITIATE_INPUT)).rejects.toThrow(
      /outbound calling is disabled/,
    );
  });

  it("initiateCall (outbound enabled) signs + POSTs /api/calls and returns the worker callId", async () => {
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ callId: "graph-call-9" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(),
    });
    const p = new MsteamsProvider({
      sharedSecret: SECRET,
      outbound: { enabled: true, workerBaseUrl: "https://worker.example", tenantId: "tenant-1" },
    });
    const result = await p.initiateCall({
      callId: "internal-1",
      from: "msteams-bot",
      to: "user:aad-123",
      message: "Your report is ready.",
      webhookUrl: "http://localhost/voice/webhook",
    } as unknown as Parameters<MsteamsProvider["initiateCall"]>[0]);

    expect(result).toEqual({ providerCallId: "graph-call-9", status: "initiated" });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    const req = fetchWithSsrFGuardMock.mock.calls[0][0] as {
      url: string;
      init: RequestInit;
      policy: { allowedHostnames: string[]; allowPrivateNetwork?: boolean };
    };
    expect(req.url).toBe("https://worker.example/api/calls");
    expect(req.init.method).toBe("POST");
    expect(JSON.parse(req.init.body as string)).toEqual({
      userObjectId: "aad-123",
      tenantId: "tenant-1",
    });
    const headers = req.init.headers as Record<string, string>;
    expect(headers["x-openclawteamsbridge-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["x-openclawteamsbridge-timestamp"]).toMatch(/^\d+$/);
    expect(req.policy.allowedHostnames).toContain("worker.example");
  });

  it("initiateCall throws when workerBaseUrl / tenantId / sharedSecret / target are missing", async () => {
    const baseInput = {
      callId: "internal-x",
      from: "msteams-bot",
      to: "user:aad-123",
      webhookUrl: "http://localhost/voice/webhook",
    } as unknown as Parameters<MsteamsProvider["initiateCall"]>[0];

    // workerBaseUrl missing.
    await expect(
      new MsteamsProvider({ sharedSecret: SECRET, outbound: { enabled: true } }).initiateCall(
        baseInput,
      ),
    ).rejects.toThrow(/workerBaseUrl is not configured/);

    // sharedSecret missing (no HMAC key to sign the place-call request).
    await expect(
      new MsteamsProvider({
        outbound: { enabled: true, workerBaseUrl: "https://worker.example", tenantId: "tenant-1" },
      }).initiateCall(baseInput),
    ).rejects.toThrow(/sharedSecret is not configured/);

    // tenantId missing.
    await expect(
      new MsteamsProvider({
        sharedSecret: SECRET,
        outbound: { enabled: true, workerBaseUrl: "https://worker.example" },
      }).initiateCall(baseInput),
    ).rejects.toThrow(/tenantId is not configured/);

    // Empty target user object id (to resolves to "").
    await expect(
      new MsteamsProvider({
        sharedSecret: SECRET,
        outbound: { enabled: true, workerBaseUrl: "https://worker.example", tenantId: "tenant-1" },
      }).initiateCall({ ...baseInput, to: "user:" }),
    ).rejects.toThrow(/userObjectId \(to\) is required/);
  });

  it("initiateCall surfaces a worker non-2xx response and a missing callId", async () => {
    const provider = new MsteamsProvider({
      sharedSecret: SECRET,
      outbound: { enabled: true, workerBaseUrl: "https://worker.example", tenantId: "tenant-1" },
    });
    const input = {
      callId: "internal-err",
      from: "msteams-bot",
      to: "user:aad-123",
      webhookUrl: "http://localhost/voice/webhook",
    } as unknown as Parameters<MsteamsProvider["initiateCall"]>[0];

    // Worker rejects: the status + body tail are surfaced.
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("user not found", { status: 404, statusText: "Not Found" }),
      release: vi.fn(),
    });
    await expect(provider.initiateCall(input)).rejects.toThrow(/worker returned 404/);

    // Worker accepts but omits the callId: we cannot correlate the media WS later.
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(),
    });
    await expect(provider.initiateCall(input)).rejects.toThrow(/did not include a callId/);
  });

  it("initiateCall attaches the caught error as the cause when the worker request fails", async () => {
    const provider = new MsteamsProvider({
      sharedSecret: SECRET,
      outbound: { enabled: true, workerBaseUrl: "https://worker.example", tenantId: "tenant-1" },
    });
    const networkError = new Error("ECONNREFUSED");
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockRejectedValueOnce(networkError);
    await provider
      .initiateCall({
        callId: "internal-cause",
        from: "msteams-bot",
        to: "user:aad-123",
        webhookUrl: "http://localhost/voice/webhook",
      } as unknown as Parameters<MsteamsProvider["initiateCall"]>[0])
      .then(
        () => {
          throw new Error("expected initiateCall to reject");
        },
        (err: unknown) => {
          expect(err).toBeInstanceOf(Error);
          expect((err as Error).message).toMatch(/request to worker failed/);
          // The original network error is preserved for diagnostics.
          expect((err as Error).cause).toBe(networkError);
        },
      );
  });

  it("hangupCall is a no-op when no session exists", async () => {
    const p = new MsteamsProvider({});
    await expect(p.hangupCall(STUB_HANGUP_INPUT)).resolves.toBeUndefined();
  });

  it("playTts throws when there is no active session for the call", async () => {
    const p = new MsteamsProvider({});
    await expect(p.playTts(STUB_PLAY_TTS_INPUT)).rejects.toThrow(/no active session/);
  });

  it("getCallStatus reports terminal when no session is active (drives restart reaping)", async () => {
    const p = new MsteamsProvider({});
    const status = await p.getCallStatus({ providerCallId: "anything" });
    expect(status.status).toBe("completed");
    expect(status.isTerminal).toBe(true);
  });
});

/** Capture the callbacks the provider passes into the realtime transcription session. */
interface CapturedStt {
  callbacks: RealtimeTranscriptionSessionCreateRequest;
  session: RealtimeTranscriptionSession & {
    connect: ReturnType<typeof vi.fn>;
    sendAudio: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

/** Mutable knobs the tests flip before driving the provider. */
interface SttControl {
  /** When true, the next created STT session's connect() rejects. */
  failConnect: boolean;
}

function createMockTranscriptionProvider(captured: { current?: CapturedStt }, control: SttControl) {
  return {
    id: "mock-stt",
    label: "Mock STT",
    isConfigured: () => true,
    createSession: (req: RealtimeTranscriptionSessionCreateRequest) => {
      let connected = false;
      const shouldFail = control.failConnect;
      const session = {
        connect: vi.fn(async () => {
          if (shouldFail) {
            throw new Error("stt down");
          }
          connected = true;
        }),
        sendAudio: vi.fn(),
        close: vi.fn(),
        isConnected: () => connected,
      };
      captured.current = { callbacks: req, session };
      return session as unknown as RealtimeTranscriptionSession;
    },
  };
}

function createMockTtsProvider(): MsteamsTtsProvider {
  return {
    // One 20 ms PCM 16 kHz frame (640 bytes), already resampled by msteams-tts.
    synthesizePcm16k: vi.fn(async () => Buffer.alloc(640, 1)),
  };
}

describe("MsteamsProvider (audio loop wiring)", () => {
  let provider: MsteamsProvider | undefined;
  let storeDir: string | undefined;

  afterEach(async () => {
    await provider?.stop();
    provider = undefined;
    generateVoiceResponseMock.mockReset();
    if (storeDir) {
      // Best-effort: the sync sqlite store may still hold the file open on
      // Windows (EBUSY). Leaving the temp dir behind is harmless.
      try {
        fs.rmSync(storeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      storeDir = undefined;
    }
  });

  async function setup(opts?: {
    outbound?: {
      enabled: boolean;
      workerBaseUrl?: string;
      tenantId?: string;
      answerTimeoutMs?: number;
    };
  }): Promise<{
    port: number;
    captured: { current?: CapturedStt };
    manager: CallManager;
    tts: MsteamsTtsProvider;
    sttControl: SttControl;
    provider: MsteamsProvider;
  }> {
    installVoiceCallStateRuntimeForTests();
    const port = randomPort();
    const config: VoiceCallConfig = {
      ...createVoiceCallBaseConfig(),
      inboundPolicy: "open",
      fromNumber: "+10000000000",
    };
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "msteams-test-"));
    const manager = new CallManager(config, storeDir);

    const captured: { current?: CapturedStt } = {};
    const sttControl: SttControl = { failConnect: false };
    const transcriptionProvider = createMockTranscriptionProvider(captured, sttControl);
    const tts = createMockTtsProvider();

    provider = new MsteamsProvider({
      port,
      path: STREAM_PATH,
      sharedSecret: SECRET,
      outbound: opts?.outbound,
    });
    await provider.start();
    await manager.initialize(provider, "http://localhost/voice/webhook");
    provider.setCallManager(manager);
    provider.setTranscriptionProvider(
      transcriptionProvider as unknown as Parameters<
        MsteamsProvider["setTranscriptionProvider"]
      >[0],
      {},
      undefined,
    );
    provider.setTtsProvider(tts);
    provider.setResponseRuntime({
      coreConfig: {},
      agentRuntime: {} as unknown as Parameters<
        MsteamsProvider["setResponseRuntime"]
      >[0]["agentRuntime"],
      voiceConfig: config,
    });
    // Give the WS server a moment to bind.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    return { port, captured, manager, tts, sttControl, provider };
  }

  function connect(port: number, callId: string): Promise<{ ws: WebSocket; inbound: unknown[] }> {
    const ts = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${port}${STREAM_PATH}/${callId}`, {
      headers: {
        "x-openclawteamsbridge-timestamp": String(ts),
        "x-openclawteamsbridge-signature": signHmac(ts, callId),
      },
    });
    const inbound: unknown[] = [];
    ws.on("message", (data: Buffer) => {
      try {
        inbound.push(JSON.parse(data.toString("utf8")));
      } catch {
        // ignore non-JSON
      }
    });
    return new Promise((resolve, reject) => {
      ws.once("open", () => {
        resolve({ ws, inbound });
      });
      ws.once("error", reject);
    });
  }

  function framesOf(inbound: unknown[]): Array<{ type: string; payloadBase64?: string }> {
    return inbound.filter(
      (m): m is { type: string; payloadBase64?: string } =>
        Boolean(m) && typeof m === "object" && (m as { type?: unknown }).type === "audio.frame",
    );
  }

  it("registers the call, streams the greeting back, and forwards caller audio to STT", async () => {
    const { port, captured, manager } = await setup();
    const callId = "teams-call-1";
    const { ws, inbound } = await connect(port, callId);

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-1",
        caller: { aadId: "aad-123", displayName: "Alice", tenantId: "tenant-1" },
        // Recording active so caller audio may be forwarded to STT (Media Access API).
        recordingStatus: "active",
      }),
    );

    // Call registered with the manager (inbound) and STT session connected.
    await waitFor(() => manager.getCallByProviderCallId(callId) !== undefined);
    await waitFor(() => captured.current?.session.connect.mock.calls.length === 1);

    const record = manager.getCallByProviderCallId(callId);
    expect(record?.direction).toBe("inbound");
    expect(record?.from).toBe("aad-123");
    expect(record?.to).toBe("+10000000000");

    // Greeting is synthesized and streamed back as audio.frame messages.
    await waitFor(() => framesOf(inbound).length > 0);
    const greetingFrame = framesOf(inbound)[0];
    expect(greetingFrame.type).toBe("audio.frame");
    expect(typeof greetingFrame.payloadBase64).toBe("string");
    expect(Buffer.from(greetingFrame.payloadBase64 ?? "", "base64").length).toBe(640);

    // Inbound caller audio is forwarded to the STT session.
    const callerPcm = Buffer.alloc(640, 7);
    ws.send(
      JSON.stringify({
        type: "audio.frame",
        seq: 0,
        timestampMs: 0,
        payloadBase64: callerPcm.toString("base64"),
      }),
    );
    await waitFor(() => (captured.current?.session.sendAudio.mock.calls.length ?? 0) > 0);
    const forwarded = captured.current?.session.sendAudio.mock.calls[0]?.[0] as Buffer;
    expect(forwarded.equals(callerPcm)).toBe(true);

    ws.close();
  });

  it("keys the call on a per-call-unique caller id when the Teams aadId is absent", async () => {
    const { port, manager } = await setup();
    const callId = "teams-no-aad";
    const { ws } = await connect(port, callId);

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-no-aad",
        caller: { displayName: "Anon" }, // no aadId
        recordingStatus: "active",
      }),
    );

    await waitFor(() => manager.getCallByProviderCallId(callId) !== undefined);
    const record = manager.getCallByProviderCallId(callId);
    // Not the shared literal "teams" (which would collide every anonymous
    // caller into one session); a per-call value preserves caller separation.
    expect(record?.from).toBe(`teams:${callId}`);

    ws.close();
  });

  it("generates a reply on final transcript by composing generateVoiceResponse + manager.speak", async () => {
    generateVoiceResponseMock.mockResolvedValue({ text: "Sure, happy to help." });
    const { port, captured, manager } = await setup();
    const speakSpy = vi.spyOn(manager, "speak");
    const callId = "teams-call-2";
    const { ws } = await connect(port, callId);

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-2",
        caller: { aadId: "aad-9", displayName: "Bob", tenantId: "tenant-9" },
        recordingStatus: "active",
      }),
    );
    await waitFor(() => captured.current !== undefined);
    const record = manager.getCallByProviderCallId(callId);
    const internalCallId = record?.callId;
    expect(internalCallId).toBeDefined();

    // Simulate the STT provider emitting a final transcript.
    captured.current?.callbacks.onTranscript?.("what's the weather");

    await waitFor(() => generateVoiceResponseMock.mock.calls.length > 0);
    const responseArgs = generateVoiceResponseMock.mock.calls[0][0] as {
      userMessage: string;
      callId: string;
    };
    expect(responseArgs.userMessage).toBe("what's the weather");
    expect(responseArgs.callId).toBe(internalCallId);

    await waitFor(() =>
      speakSpy.mock.calls.some(
        (call) => call[0] === internalCallId && call[1] === "Sure, happy to help.",
      ),
    );

    ws.close();
  });

  it("drops transcripts until Teams recording status is active (Media Access API)", async () => {
    generateVoiceResponseMock.mockResolvedValue({ text: "should not be reached" });
    const { port, captured } = await setup();
    const callId = "teams-call-rec";
    const { ws } = await connect(port, callId);

    // session.start WITHOUT recordingStatus -> recording is not active.
    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-rec",
        caller: { aadId: "aad-rec" },
      }),
    );
    await waitFor(() => captured.current !== undefined);

    // A transcript before recording is active must not reach the agent.
    captured.current?.callbacks.onTranscript?.("do something");
    await new Promise<void>((r) => {
      setTimeout(r, 50);
    });
    expect(generateVoiceResponseMock).not.toHaveBeenCalled();

    // Worker reports recording active -> subsequent transcripts are processed.
    ws.send(JSON.stringify({ type: "recording.status", status: "active" }));
    await new Promise<void>((r) => {
      setTimeout(r, 20);
    });
    captured.current?.callbacks.onTranscript?.("now do it");
    await waitFor(() => generateVoiceResponseMock.mock.calls.length > 0);
    expect(
      (generateVoiceResponseMock.mock.calls[0][0] as { userMessage: string }).userMessage,
    ).toBe("now do it");

    ws.close();
  });

  it("drops inbound video frames until Teams recording status is active (Media Access API)", async () => {
    const { port, captured, provider: videoProvider } = await setup();
    const callId = "teams-call-vid";
    const { ws } = await connect(port, callId);

    // session.start WITHOUT recordingStatus -> recording not active.
    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-vid",
        caller: { aadId: "aad-vid" },
      }),
    );
    await waitFor(() => captured.current !== undefined);

    // A video frame before recording is active must be dropped (not buffered).
    ws.send(
      JSON.stringify({
        type: "video.frame",
        source: "screenshare",
        ts: 1,
        width: 1280,
        height: 720,
        mime: "image/jpeg",
        dataBase64: "AQID",
      }),
    );
    await new Promise<void>((r) => {
      setTimeout(r, 50);
    });
    expect(videoProvider.getLatestVideoFrame(callId)).toBeUndefined();

    // Worker reports recording active -> subsequent frames are buffered.
    ws.send(JSON.stringify({ type: "recording.status", status: "active" }));
    await new Promise<void>((r) => {
      setTimeout(r, 20);
    });
    ws.send(
      JSON.stringify({
        type: "video.frame",
        source: "screenshare",
        ts: 2,
        width: 640,
        height: 360,
        mime: "image/jpeg",
        dataBase64: "BAUG",
      }),
    );
    await waitFor(() => videoProvider.getLatestVideoFrame(callId) !== undefined);
    expect(videoProvider.getLatestVideoFrame(callId)).toMatchObject({
      dataBase64: "BAUG",
      width: 640,
      height: 360,
    });

    ws.close();
  });

  it("attaches the latest shared video frame to the streaming agent turn (inbound vision)", async () => {
    generateVoiceResponseMock.mockResolvedValue({ text: "I see a stack trace." });
    const { port, captured } = await setup();
    const callId = "teams-call-svid";
    const { ws } = await connect(port, callId);

    // Recording active so the frame buffers and the transcript is processed.
    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "t",
        caller: { aadId: "a" },
        recordingStatus: "active",
      }),
    );
    await waitFor(() => captured.current !== undefined);

    ws.send(
      JSON.stringify({
        type: "video.frame",
        source: "screenshare",
        ts: 1,
        width: 800,
        height: 600,
        mime: "image/jpeg",
        dataBase64: "AQID",
      }),
    );
    await new Promise<void>((r) => {
      setTimeout(r, 30);
    });

    // A transcript drives a turn; the latest frame should ride along as an image.
    captured.current?.callbacks.onTranscript?.("what's on my screen?");
    await waitFor(() => generateVoiceResponseMock.mock.calls.length > 0);
    const arg = generateVoiceResponseMock.mock.calls.at(-1)?.[0] as {
      images?: Array<{ type: string; data: string; mimeType: string }>;
    };
    expect(arg.images?.[0]).toMatchObject({ type: "image", data: "AQID", mimeType: "image/jpeg" });

    ws.close();
  });

  it("does not forward caller audio to STT until recording status is active (Media Access API)", async () => {
    const { port, captured } = await setup();
    const callId = "teams-call-audio-gate";
    const { ws } = await connect(port, callId);

    // session.start WITHOUT recordingStatus -> recording is not active.
    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-audio-gate",
        caller: { aadId: "aad-gate" },
      }),
    );
    await waitFor(() => captured.current?.session.connect.mock.calls.length === 1);

    // Caller audio before recording is active must NOT reach the STT provider.
    const preRecordingPcm = Buffer.alloc(640, 3);
    ws.send(
      JSON.stringify({
        type: "audio.frame",
        seq: 0,
        timestampMs: 0,
        payloadBase64: preRecordingPcm.toString("base64"),
      }),
    );
    await new Promise<void>((r) => {
      setTimeout(r, 50);
    });
    expect(captured.current?.session.sendAudio).not.toHaveBeenCalled();

    // Worker reports recording active -> subsequent caller audio is forwarded.
    ws.send(JSON.stringify({ type: "recording.status", status: "active" }));
    await new Promise<void>((r) => {
      setTimeout(r, 20);
    });
    const recordedPcm = Buffer.alloc(640, 9);
    ws.send(
      JSON.stringify({
        type: "audio.frame",
        seq: 1,
        timestampMs: 20,
        payloadBase64: recordedPcm.toString("base64"),
      }),
    );
    await waitFor(() => (captured.current?.session.sendAudio.mock.calls.length ?? 0) > 0);
    const forwarded = captured.current?.session.sendAudio.mock.calls[0]?.[0] as Buffer;
    expect(forwarded.equals(recordedPcm)).toBe(true);

    ws.close();
  });

  it("tears down the Teams session when the STT session fails to connect", async () => {
    const { port, captured, manager, sttControl } = await setup();
    // Force the STT session created on session.start to reject its connect().
    sttControl.failConnect = true;
    const callId = "teams-call-stt-fail";
    const { ws } = await connect(port, callId);

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-stt-fail",
        caller: { aadId: "aad-fail" },
        recordingStatus: "active",
      }),
    );

    // connect() rejects -> the provider tears the call down (no silent live call).
    await waitFor(() => captured.current?.session.connect.mock.calls.length === 1);
    await waitFor(() => captured.current?.session.close.mock.calls.length === 1);
    await waitFor(() => manager.getCallByProviderCallId(callId) === undefined);
  });

  it("attaches an outbound call (placed via the worker) to the existing CallRecord on session.start", async () => {
    const { port, captured, manager } = await setup({
      outbound: { enabled: true, workerBaseUrl: "https://worker.example", tenantId: "tenant-1" },
    });
    const graphCallId = "graph-out-1";
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ callId: graphCallId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(),
    });
    try {
      // Place the call through the manager (creates the CallRecord + maps providerCallId).
      const placed = await manager.initiateCall("user:aad-out", undefined, {
        message: "The current time in Dubai is 5:41 PM.",
        mode: "notify",
      });
      expect(placed.success).toBe(true);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
      const internalCall = manager.getCallByProviderCallId(graphCallId);
      expect(internalCall?.direction).toBe("outbound");

      // The worker dials back: open the media WS with the SAME callId + direction.
      const { ws } = await connect(port, graphCallId);
      ws.send(
        JSON.stringify({
          type: "session.start",
          callId: graphCallId,
          threadId: "thread-out",
          caller: { aadId: "bot" },
          direction: "outbound",
          recordingStatus: "active",
        }),
      );

      // Attaches to the EXISTING record (STT created) — not a new inbound call.
      await waitFor(() => (captured.current?.session.connect.mock.calls.length ?? 0) === 1);
      expect(manager.getCallByProviderCallId(graphCallId)?.callId).toBe(internalCall?.callId);
      ws.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("finalizes a placed outbound call that never connects back within answerTimeoutMs", async () => {
    const { manager } = await setup({
      outbound: {
        enabled: true,
        workerBaseUrl: "https://worker.example",
        tenantId: "tenant-1",
        // Short safety-net so the no-answer path fires fast in the test.
        answerTimeoutMs: 120,
      },
    });
    const graphCallId = "graph-noanswer-1";
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ callId: graphCallId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(),
    });
    try {
      const placed = await manager.initiateCall("user:aad-noanswer", undefined, {
        message: "Your report is ready.",
        mode: "notify",
      });
      expect(placed.success).toBe(true);
      // Hold the live record: finalizeCall sets endReason in place, then removes it
      // from activeCalls, so we read endReason from the captured reference.
      const record = manager.getCallByProviderCallId(graphCallId);
      expect(record?.callId).toBeDefined();

      // The media WS never connects: the no-answer timer fires and finalizes the
      // CallRecord so it does not linger as active (no leak).
      await waitFor(() => record?.endReason !== undefined);
      expect(record?.endReason).toBe("timeout");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("closes a late callee answer after the outbound no-answer timeout instead of treating it as inbound", async () => {
    const { port, captured, manager } = await setup({
      outbound: {
        enabled: true,
        workerBaseUrl: "https://worker.example",
        tenantId: "tenant-1",
        answerTimeoutMs: 120,
      },
    });
    const graphCallId = "graph-late-1";
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ callId: graphCallId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(),
    });
    try {
      const placed = await manager.initiateCall("user:aad-late", undefined, {
        message: "Your report is ready.",
        mode: "notify",
      });
      expect(placed.success).toBe(true);
      // Hold the live record (removed from activeCalls once finalized).
      const record = manager.getCallByProviderCallId(graphCallId);

      // Wait for the no-answer timer to finalize the call.
      await waitFor(() => record?.endReason !== undefined);

      // The callee answers late: the worker opens the media WS with the same callId.
      // It must be closed (already finalized), NOT attached or registered as a fresh
      // inbound call — so no new STT session is created.
      const { ws } = await connect(port, graphCallId);
      const closed = new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
      });
      ws.send(
        JSON.stringify({
          type: "session.start",
          callId: graphCallId,
          threadId: "thread-late",
          caller: { aadId: "bot" },
          direction: "outbound",
          recordingStatus: "active",
        }),
      );

      await closed;
      // No bridge state was created for the late connect.
      expect(captured.current).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends assistant.cancel on barge-in (STT speech start)", async () => {
    const { port, captured } = await setup();
    const callId = "teams-call-3";
    const { ws, inbound } = await connect(port, callId);

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-3",
        caller: { aadId: "aad-3", displayName: "Cara", tenantId: "tenant-3" },
      }),
    );
    await waitFor(() => captured.current !== undefined);

    captured.current?.callbacks.onSpeechStart?.();

    await waitFor(() =>
      inbound.some(
        (m) =>
          Boolean(m) &&
          typeof m === "object" &&
          (m as { type?: unknown }).type === "assistant.cancel",
      ),
    );
    const cancel = inbound.find(
      (m): m is { type: string; turnId: number } =>
        Boolean(m) &&
        typeof m === "object" &&
        (m as { type?: unknown }).type === "assistant.cancel",
    );
    expect(typeof cancel?.turnId).toBe("number");

    ws.close();
  });

  it("ends the call and closes the STT session on session.end", async () => {
    const { port, captured, manager } = await setup();
    const callId = "teams-call-4";
    const { ws } = await connect(port, callId);

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-4",
        caller: { aadId: "aad-4", displayName: "Dan", tenantId: "tenant-4" },
      }),
    );
    await waitFor(() => captured.current !== undefined);
    const internalCallId = manager.getCallByProviderCallId(callId)?.callId;

    ws.send(JSON.stringify({ type: "session.end", reason: "caller-hangup" }));

    await waitFor(() => (captured.current?.session.close.mock.calls.length ?? 0) > 0);
    await waitFor(() => {
      const ended = internalCallId ? manager.getCall(internalCallId) : undefined;
      return ended === undefined || ended.endReason !== undefined;
    });
  });

  it("getCallStatus reports in-progress for an active realtime call (no streaming `calls` state)", async () => {
    const { port, provider: msProvider } = await setup();
    // Realtime calls live only in `realtimeCalls`; without the realtime check getCallStatus would
    // report them terminal and the manager would reap an active outbound callback on restore.
    const realtime = createMockRealtimeProvider();
    msProvider.setRealtimeRuntime({
      provider: realtime.plugin,
      providerConfig: {} as never,
      inboundPolicy: "open",
    });
    const callId = "teams-realtime-1";
    const { ws } = await connect(port, callId);

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-rt",
        caller: { aadId: "aad-rt", displayName: "Rita", tenantId: "tenant-rt" },
        recordingStatus: "active",
      }),
    );
    await waitFor(() => realtime.created());

    const status = await msProvider.getCallStatus({ providerCallId: callId });
    expect(status.status).toBe("in-progress");
    expect(status.isTerminal).toBe(false);

    ws.close();
  });

  it("releases the realtime call when the bridge fails to connect (B1: no leaked in-progress state)", async () => {
    const { port, provider: msProvider } = await setup();
    const realtime = createMockRealtimeProvider({ failConnect: true });
    msProvider.setRealtimeRuntime({
      provider: realtime.plugin,
      providerConfig: {} as never,
      inboundPolicy: "open",
    });
    const callId = "teams-realtime-fail";
    const { ws } = await connect(port, callId);
    const closed = new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
    });

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-rt-fail",
        caller: { aadId: "aad-rt-fail" },
        recordingStatus: "active",
      }),
    );
    await waitFor(() => realtime.created());

    // connect() rejects -> the Teams session is hung up AND the realtimeCalls entry is
    // released (previously the host close suppressed onSessionEnd, so getCallStatus
    // reported the dead call in-progress forever).
    await closed;
    const status = await msProvider.getCallStatus({ providerCallId: callId });
    expect(status.isTerminal).toBe(true);
  });

  it("manager-driven hangup releases per-call vision frames (B3)", async () => {
    const { port, captured, provider: msProvider } = await setup();
    const callId = "teams-hangup-release";
    const { ws } = await connect(port, callId);

    ws.send(
      JSON.stringify({
        type: "session.start",
        callId,
        threadId: "thread-release",
        caller: { aadId: "aad-release" },
        recordingStatus: "active",
      }),
    );
    await waitFor(() => captured.current !== undefined);
    ws.send(
      JSON.stringify({
        type: "video.frame",
        source: "screenshare",
        ts: 1,
        width: 8,
        height: 8,
        mime: "image/jpeg",
        dataBase64: "AQID",
      }),
    );
    await waitFor(() => msProvider.getLatestVideoFrame(callId) !== undefined);

    // Manager-initiated hangup (idle timeout / endCall): previously only a caller-driven
    // session.end released the vision store, leaking ~1-2 MB per hung-up call.
    await msProvider.hangupCall({
      providerCallId: callId,
      reason: "completed",
    } as unknown as HangupCallInput);

    expect(msProvider.getLatestVideoFrame(callId)).toBeUndefined();
  });

  it("finalizes a placed outbound call that ends before session.start — declined/busy (B5)", async () => {
    const { port, manager } = await setup({
      outbound: {
        enabled: true,
        workerBaseUrl: "https://worker.example",
        tenantId: "tenant-1",
        // Long safety net: proves the end event itself (not the no-answer timer) finalizes.
        answerTimeoutMs: 60_000,
      },
    });
    const graphCallId = "graph-declined-1";
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ callId: graphCallId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(),
    });
    try {
      const placed = await manager.initiateCall("user:aad-declined", undefined, {
        message: "Your report is ready.",
        mode: "notify",
      });
      expect(placed.success).toBe(true);
      // Hold the live record (removed from activeCalls once finalized).
      const record = manager.getCallByProviderCallId(graphCallId);
      expect(record?.callId).toBeDefined();

      // The callee declines: the worker reports session.end WITHOUT ever sending session.start.
      // Previously this canceled the no-answer timer but finalized nothing, so the CallRecord
      // stayed active forever (counting against maxConcurrentCalls) and pendingOutbound leaked.
      const { ws } = await connect(port, graphCallId);
      ws.send(JSON.stringify({ type: "session.end", reason: "declined" }));

      await waitFor(() => record?.endReason !== undefined);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defers outbound streaming call.answered until the callee picks up — no deliver-to-ringing (B4)", async () => {
    const { port, captured, manager } = await setup({
      outbound: { enabled: true, workerBaseUrl: "https://worker.example", tenantId: "tenant-1" },
    });
    const graphCallId = "graph-ringing-1";
    fetchWithSsrFGuardMock.mockReset();
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(JSON.stringify({ callId: graphCallId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(),
    });
    try {
      const placed = await manager.initiateCall("user:aad-ring", undefined, {
        message: "Your report is ready.",
        mode: "notify",
      });
      expect(placed.success).toBe(true);
      const record = manager.getCallByProviderCallId(graphCallId);

      // The media WS attaches while the phone is still RINGING (no recordingStatus yet).
      const { ws, inbound } = await connect(port, graphCallId);
      ws.send(
        JSON.stringify({
          type: "session.start",
          callId: graphCallId,
          threadId: "thread-ring",
          caller: { aadId: "bot" },
          direction: "outbound",
        }),
      );
      await waitFor(() => (captured.current?.session.connect.mock.calls.length ?? 0) === 1);

      // Still ringing: the record must NOT be answered and the notify result must NOT be spoken
      // (previously call.answered fired at attach and TTS'd the result into the ringing phone).
      await new Promise<void>((r) => {
        setTimeout(r, 80);
      });
      expect(record?.answeredAt).toBeUndefined();
      expect(framesOf(inbound)).toHaveLength(0);

      // The callee picks up: recording goes active → answered fires and the result is spoken.
      ws.send(JSON.stringify({ type: "recording.status", status: "active" }));
      await waitFor(() => record?.answeredAt !== undefined);
      await waitFor(() => framesOf(inbound).length > 0, 3000);
      ws.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
