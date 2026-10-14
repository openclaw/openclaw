import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import {
  createTranscriptionSession,
  emitCommitted,
  emitCompleted,
  emitDelta,
  emitFailed,
  emitJson,
} from "./realtime-transcription-provider.test-support.js";

const { FakeWebSocket, providerAuthMocks, ssrfMocks } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];
    static onCreated: ((socket: MockWebSocket) => void) | undefined;

    readonly listeners = new Map<string, Listener[]>();
    readonly headers?: Record<string, string>;
    readonly url?: string;
    readyState = 0;
    sent: string[] = [];
    closed = false;

    constructor(url?: string, options?: { headers?: Record<string, string> }) {
      this.url = url;
      this.headers = options?.headers;
      MockWebSocket.instances.push(this);
      MockWebSocket.onCreated?.(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code?: number, reason?: string): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }

    terminate(): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
    }
  }

  return {
    FakeWebSocket: MockWebSocket,
    providerAuthMocks: {
      isProviderAuthProfileConfigured: vi.fn(),
      isProviderAuthProfileConfiguredAsync: vi.fn(),
      resolveProviderAuthProfileApiKey: vi.fn(),
    },
    ssrfMocks: {
      fetchWithSsrFGuard: vi.fn(),
    },
  };
});

// Intercept the shared transport constructor, not Bun's bare ws adapter.
vi.mock("../../packages/gateway-client/src/websocket.js", () => ({
  WebSocket: FakeWebSocket,
}));

// mock-isolation: Transcription transport tests supply synthetic credentials without opening host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: providerAuthMocks.isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync: providerAuthMocks.isProviderAuthProfileConfiguredAsync,
  resolveProviderAuthProfileApiKey: providerAuthMocks.resolveProviderAuthProfileApiKey,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  session?: unknown;
};

function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload) => JSON.parse(payload) as SentRealtimeEvent);
}

const sessions = new Set<{ close(): void }>();

async function waitForFakeSocket(
  session: { close(): void },
  index = 0,
): Promise<FakeWebSocketInstance> {
  sessions.add(session);
  await vi.dynamicImportSettled();
  const existing = FakeWebSocket.instances[index];
  if (existing) {
    return existing;
  }
  const created = createDeferred<FakeWebSocketInstance>();
  FakeWebSocket.onCreated = (socket) => {
    if (FakeWebSocket.instances[index] === socket) {
      created.resolve(socket);
    }
  };
  try {
    return await vi.waitFor(() => created.promise);
  } finally {
    FakeWebSocket.onCreated = undefined;
  }
}

async function connectFakeSession(
  session: { connect(): Promise<void>; close(): void },
  socketIndex = 0,
): Promise<FakeWebSocketInstance> {
  const connecting = session.connect();
  const socket = await waitForFakeSocket(session, socketIndex);
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  emitJson(socket, { type: "session.updated" });
  await connecting;
  return socket;
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[0] as Record<string, unknown>;
}

describe("buildOpenAIRealtimeTranscriptionProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    providerAuthMocks.isProviderAuthProfileConfigured.mockReset();
    providerAuthMocks.isProviderAuthProfileConfiguredAsync.mockReset();
    providerAuthMocks.resolveProviderAuthProfileApiKey.mockReset();
    ssrfMocks.fetchWithSsrFGuard.mockReset();
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterEach(() => {
    // Close session ownership before its fake peers so cleanup cannot start a reconnect.
    for (const session of sessions) {
      session.close();
    }
    for (const socket of FakeWebSocket.instances) {
      socket.close();
    }
    sessions.clear();
    vi.unstubAllEnvs();
  });

  it("preserves explicit zero-valued VAD settings", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            silenceDurationMs: 0,
            vadThreshold: 0,
          },
        },
      },
    });

    expect(resolved?.silenceDurationMs).toBe(0);
    expect(resolved?.vadThreshold).toBe(0);
  });

  it("treats an OpenAI API-key profile as configured through its asynchronous owner", async () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const cfg = { auth: { order: { openai: ["openai:default"] } } };
    providerAuthMocks.isProviderAuthProfileConfiguredAsync.mockResolvedValue(true);

    expect(await provider.isConfiguredAsync?.({ cfg: cfg as never, providerConfig: {} })).toBe(
      true,
    );
    expect(providerAuthMocks.isProviderAuthProfileConfigured).not.toHaveBeenCalled();
    expect(providerAuthMocks.isProviderAuthProfileConfiguredAsync).toHaveBeenCalledWith({
      provider: "openai",
      cfg,
      profileTypes: ["api_key"],
    });
  });

  it("does not use Codex OAuth for realtime transcription", async () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const cfg = { auth: { order: { openai: ["openai:default"] } } };
    const session = provider.createSession({ cfg: cfg as never, providerConfig: {} });

    await expect(session.connect()).rejects.toThrow(
      "OpenAI Realtime transcription requires an OpenAI Platform API key",
    );
    expect(providerAuthMocks.resolveProviderAuthProfileApiKey).toHaveBeenCalledWith({
      provider: "openai",
      cfg,
      profileTypes: ["api_key"],
    });
    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("prefers an API-key profile over OPENAI_API_KEY", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env"); // pragma: allowlist secret
    providerAuthMocks.resolveProviderAuthProfileApiKey.mockResolvedValue("sk-profile"); // pragma: allowlist secret
    ssrfMocks.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response(JSON.stringify({ value: "ek-test" }), { status: 200 }),
      release: vi.fn(),
    });
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: {},
    });

    const connecting = session.connect();
    const socket = await waitForFakeSocket(session);

    expect(socket.headers?.Authorization).toBe("Bearer ek-test");
    const request = mockCallArg(ssrfMocks.fetchWithSsrFGuard);
    const init = request.init as { headers?: Record<string, string> };
    expect(init.headers?.Authorization).toBe("Bearer sk-profile");

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "transcription_session.updated" })));
    await connecting;
    session.close();
  });

  it("waits for readiness, commits pending audio once on close, and delivers its final", async () => {
    const onTranscript = vi.fn();
    const pendingAudio = Buffer.alloc(800, 1);
    const session = buildOpenAIRealtimeTranscriptionProvider().createSession({
      providerConfig: {
        apiKey: "sk-test", // pragma: allowlist secret
        language: "en",
        model: "gpt-4o-transcribe",
        prompt: "expect OpenClaw product names",
        silenceDurationMs: 900,
        vadThreshold: 0.45,
      },
      onTranscript,
    });

    const connecting = session.connect();
    const socket = await waitForFakeSocket(session);

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    session.sendAudio(pendingAudio);

    expect(session.isConnected()).toBe(false);
    const expectedSessionUpdate = {
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: {
              model: "gpt-4o-transcribe",
              language: "en",
              prompt: "expect OpenClaw product names",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.45,
              prefix_padding_ms: 300,
              silence_duration_ms: 900,
            },
          },
        },
      },
    };
    expect(parseSent(socket)).toEqual([expectedSessionUpdate]);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    expect(session.isConnected()).toBe(true);
    expect(parseSent(socket)).toEqual([
      expectedSessionUpdate,
      {
        type: "input_audio_buffer.append",
        audio: pendingAudio.toString("base64"),
      },
    ]);
    session.close();
    session.close();
    expect(
      parseSent(socket).filter(({ type }) => type === "input_audio_buffer.commit"),
    ).toHaveLength(1);
    emitJson(socket, { type: "input_audio_buffer.committed", item_id: "final-item" });
    emitCompleted(socket, "final-item", "final caller sentence");
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("final caller sentence");
    socket.close();
  });

  it("never commits audio from a previous websocket generation", async () => {
    const session = createTranscriptionSession({});
    const previousSocket = await connectFakeSession(session);
    session.sendAudio(Buffer.alloc(800, 1));
    const replacementSocket = await connectFakeSession(session, 1);

    session.close();

    expect(parseSent(previousSocket).at(-1)?.type).toBe("input_audio_buffer.append");
    expect(parseSent(replacementSocket).at(-1)?.type).toBe("session.update");
    replacementSocket.close();
  });

  it("reports websocket backpressure during final commit exactly once", async () => {
    const onError = vi.fn();
    const session = createTranscriptionSession({
      onError,
    });
    const socket = await connectFakeSession(session);
    session.sendAudio(Buffer.alloc(800, 1));
    Object.defineProperty(socket, "bufferedAmount", { value: 1024 * 1024 });

    session.close();
    session.close();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("final audio commit") }),
    );
    expect(parseSent(socket).at(-1)?.type).toBe("input_audio_buffer.append");
  });

  it.each([
    [1599, 0, false],
    [1600, 1, false],
    [1600, 1, true],
  ] as const)(
    "commits eligible %i-byte audio once (%i commits, VAD stopped: true, acknowledged: %s)",
    async (audioBytes, expectedCommits, acknowledged) => {
      const session = createTranscriptionSession({});
      const socket = await connectFakeSession(session);
      session.sendAudio(Buffer.alloc(800, 1));
      session.sendAudio(Buffer.alloc(audioBytes - 800, 2));
      emitJson(socket, {
        type: "input_audio_buffer.speech_stopped",
        item_id: "first-turn",
        audio_end_ms: 100,
      });
      if (acknowledged) {
        emitJson(socket, { type: "input_audio_buffer.committed", item_id: "first-turn" });
        emitJson(socket, { type: "input_audio_buffer.committed", item_id: "first-turn" });
      }

      session.close();

      expect(
        parseSent(socket).filter(({ type }) => type === "input_audio_buffer.commit"),
      ).toHaveLength(expectedCommits);
      socket.close();
    },
  );

  it("keeps out-of-order transcription items isolated and emits finals in commit order", async () => {
    const partials: string[] = [];
    const transcripts: string[] = [];
    const session = createTranscriptionSession({
      onPartial: (partial) => partials.push(partial),
      onTranscript: (transcript) => transcripts.push(transcript),
    });

    const socket = await connectFakeSession(session);
    session.sendAudio(Buffer.alloc(800, 1));
    emitJson(socket, {
      type: "input_audio_buffer.speech_stopped",
      item_id: "item-2",
      audio_end_ms: 100,
    });
    emitCommitted(socket, "item-2", "item-1");
    emitCommitted(socket, "item-1", null);
    emitDelta(socket, "item-1", "first partial");
    emitDelta(socket, "item-2", "second partial");
    emitCompleted(socket, "item-2", "second final");

    expect(partials).toEqual(["first partial", "second partial"]);
    expect(transcripts).toEqual([]);

    emitCompleted(socket, "item-1", "first final");

    expect(transcripts).toEqual(["first final", "second final"]);
    session.close();
    expect(parseSent(socket).at(-1)?.type).toBe("input_audio_buffer.append");
  });

  it("reports failed transcription items without blocking later committed turns", async () => {
    const errors: string[] = [];
    const transcripts: string[] = [];
    const session = createTranscriptionSession({
      onError: (error) => errors.push(error.message),
      onTranscript: (transcript) => transcripts.push(transcript),
    });

    const socket = await connectFakeSession(session);

    for (const itemId of ["item-1", "item-2"]) {
      emitJson(socket, { type: "input_audio_buffer.committed", item_id: itemId });
    }
    emitCompleted(socket, "item-2", "second final");
    emitFailed(socket, "item-1", "first turn failed");

    expect(errors).toEqual(["first turn failed"]);
    expect(transcripts).toEqual(["second final"]);
    session.sendAudio(Buffer.alloc(800, 1));
    session.close();
    expect(parseSent(socket).at(-1)?.type).toBe("input_audio_buffer.commit");
  });

  it("releases settled turns from the unresolved item budget", async () => {
    const transcripts: string[] = [];
    const onError = vi.fn();
    const session = createTranscriptionSession({
      onError,
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const socket = await connectFakeSession(session);

    for (let index = 0; index < 128; index += 1) {
      const itemId = `item-${index}`;
      emitCommitted(socket, itemId, index === 0 ? null : `item-${index - 1}`);
      emitCompleted(socket, itemId, `turn-${index}`);
    }
    emitCommitted(socket, "item-129", "item-128");
    emitCompleted(socket, "item-129", "turn-129");
    emitCommitted(socket, "item-128", "item-127");
    emitCompleted(socket, "item-128", "turn-128");

    expect(transcripts).toHaveLength(130);
    expect(transcripts.slice(-2)).toEqual(["turn-128", "turn-129"]);
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("fails once when unresolved item correlation exceeds its session bound", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const session = createTranscriptionSession({
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);

    for (let index = 0; index < 64; index += 1) {
      emitCommitted(socket, `item-${index}`, "missing-predecessor");
      emitCompleted(socket, `item-${index}`, `turn-${index}`);
    }
    emitFailed(socket, "overflow-item", "provider failure");

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 64 unresolved item limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);

    const replacementSocket = await connectFakeSession(session, 1);
    emitCommitted(replacementSocket, "replacement-item", null);
    emitCompleted(replacementSocket, "replacement-item", "replacement transcript");

    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("replacement transcript");
    expect(onError).toHaveBeenCalledTimes(1);
    session.close();
    session.close();
  });

  it("fails once when aggregate in-progress transcript text exceeds 256 KiB", async () => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const session = createTranscriptionSession({
      onError,
      onPartial,
      onTranscript,
    });
    const socket = await connectFakeSession(session);
    const exactLimit = "🙂".repeat((256 * 1024) / 4);

    emitDelta(socket, "item-1", exactLimit);
    emitDelta(socket, "item-1", "x");
    emitCompleted(socket, "item-1", "late transcript");

    expect(onPartial).toHaveBeenCalledExactlyOnceWith(exactLimit);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 256 KiB retained transcript limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    session.close();
  });

  it("accounts for UTF-8 surrogate pairs split across delta frames", async () => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const session = createTranscriptionSession({
      onError,
      onPartial,
    });
    const socket = await connectFakeSession(session);
    const prefix = "x".repeat(256 * 1024 - 4);

    emitDelta(socket, "item-1", prefix);
    emitDelta(socket, "item-1", "\ud83d");
    emitDelta(socket, "item-1", "\ude42");

    expect(onPartial).toHaveBeenLastCalledWith(`${prefix}🙂`);
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("ignores duplicate completion events without double-charging retained text", async () => {
    const onError = vi.fn();
    const onPartial = vi.fn();
    const transcripts: string[] = [];
    const session = createTranscriptionSession({
      onError,
      onPartial,
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const socket = await connectFakeSession(session);
    const secondTranscript = "x".repeat(192 * 1024);

    emitCommitted(socket, "item-2", "item-1");
    emitCompleted(socket, "item-2", secondTranscript);
    emitDelta(socket, "item-2", "late partial");
    emitFailed(socket, "item-2", "late failure");
    emitCompleted(socket, "item-2", secondTranscript);
    emitCommitted(socket, "item-1", null);
    emitCompleted(socket, "item-1", "first");
    emitCompleted(socket, "item-2", "late duplicate");

    expect(transcripts).toEqual(["first", secondTranscript]);
    expect(onPartial).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);

    const replacementSocket = await connectFakeSession(session, 1);
    emitCommitted(replacementSocket, "item-2", null);
    emitCompleted(replacementSocket, "item-2", "new session");

    expect(transcripts).toEqual(["first", secondTranscript, "new session"]);
    session.close();
  });

  it("tombstones terminal outcomes received before their commit", async () => {
    const errors: string[] = [];
    const partials: string[] = [];
    const transcripts: string[] = [];
    const session = createTranscriptionSession({
      onError: (error) => errors.push(error.message),
      onPartial: (partial) => partials.push(partial),
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const socket = await connectFakeSession(session);

    emitCompleted(socket, "item-completed", "first");
    emitCompleted(socket, "item-completed", "duplicate");
    emitDelta(socket, "item-completed", "late partial");
    emitFailed(socket, "item-completed", "late failure");
    emitCommitted(socket, "item-completed", null);

    emitFailed(socket, "item-failed", "first failure");
    emitCompleted(socket, "item-failed", "late completion");
    emitDelta(socket, "item-failed", "late partial");
    emitFailed(socket, "item-failed", "duplicate failure");
    emitCommitted(socket, "item-failed", null);

    expect(transcripts).toEqual(["first"]);
    expect(errors).toEqual(["first failure"]);
    expect(partials).toEqual([]);
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("keeps the first failed terminal outcome when completion arrives late", async () => {
    const errors: string[] = [];
    const transcripts: string[] = [];
    const session = createTranscriptionSession({
      onError: (error) => errors.push(error.message),
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    const socket = await connectFakeSession(session);

    emitCommitted(socket, "item-2", "item-1");
    emitFailed(socket, "item-2", "second failed");
    emitCompleted(socket, "item-2", "late second");
    emitCommitted(socket, "item-1", null);
    emitCompleted(socket, "item-1", "first");

    expect(errors).toEqual(["second failed"]);
    expect(transcripts).toEqual(["first"]);
    expect(session.isConnected()).toBe(true);
    session.close();
  });

  it("fails before retaining oversized correlation identities", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const session = createTranscriptionSession({
      onError,
      onTranscript,
    });
    const socket = await connectFakeSession(session);

    session.sendAudio(Buffer.alloc(800, 1));
    emitFailed(socket, "i".repeat(1025), "provider failure");

    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the 1024-byte item identity limit",
      }),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    expect(parseSent(socket).map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
    ]);
    session.close();
  });
});
