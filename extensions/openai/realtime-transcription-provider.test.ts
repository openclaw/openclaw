import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { createOpenAIRealtimeClientSecret } from "./realtime-provider-shared.js";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import {
  createTranscriptionSession,
  createTranscriptionSocketHarness,
  emitCommitted,
  emitCompleted,
  emitDelta,
  emitFailed,
  emitJson,
} from "./realtime-transcription-provider.test-support.js";

const { FakeWebSocket, providerAuthMocks, ssrfMocks } = await vi.hoisted(async () => {
  const { createTranscriptionMockWebSocket } =
    await import("./realtime-transcription-socket.test-support.js");

  return {
    FakeWebSocket: createTranscriptionMockWebSocket(),
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
type SentRealtimeEvent = { type: string };

function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload) => JSON.parse(payload) as SentRealtimeEvent);
}

const socketHarness = createTranscriptionSocketHarness(FakeWebSocket);
const { waitForFakeSocket, connectFakeSession } = socketHarness;

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[0] as Record<string, unknown>;
}

async function connectSession() {
  const errors: string[] = [];
  const partials: string[] = [];
  const transcripts: string[] = [];
  const onError = vi.fn((error: Error) => errors.push(error.message));
  const onPartial = vi.fn((partial: string) => partials.push(partial));
  const onTranscript = vi.fn((transcript: string) => transcripts.push(transcript));
  const session = createTranscriptionSession({ onError, onPartial, onTranscript });
  const socket = await connectFakeSession(session);
  return { session, socket, errors, partials, transcripts, onError, onPartial, onTranscript };
}

function expectOverflow(
  session: ReturnType<typeof createTranscriptionSession>,
  onError: Awaited<ReturnType<typeof connectSession>>["onError"],
  onTranscript: Awaited<ReturnType<typeof connectSession>>["onTranscript"],
  limit: string,
) {
  expect(onError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      message: `OpenAI realtime transcription exceeded the ${limit} limit`,
    }),
  );
  expect(onTranscript).not.toHaveBeenCalled();
  expect(session.isConnected()).toBe(false);
}

function createSecret(
  response: Response,
  overrides: Partial<Parameters<typeof createOpenAIRealtimeClientSecret>[0]> = {},
  label?: string,
) {
  ssrfMocks.fetchWithSsrFGuard.mockResolvedValue({ response, release: vi.fn() });
  return createOpenAIRealtimeClientSecret(
    {
      authToken: "sk-test",
      auditContext: "test",
      session: { model: "gpt-4o-realtime-preview" },
      ...overrides,
    },
    openAIRealtimeHost,
    label,
  );
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
    socketHarness.close();
    vi.unstubAllEnvs();
  });

  it("preserves explicit zero-valued VAD settings", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const openai = { silenceDurationMs: 0, vadThreshold: 0 };
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: { providers: { openai } },
    });

    expect(resolved).toMatchObject({ silenceDurationMs: 0, vadThreshold: 0 });
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
    emitJson(socket, { type: "transcription_session.updated" });
    await connecting;
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

    emitJson(socket, { type: "session.updated" });
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
    const { session, socket, onError } = await connectSession();
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

  it.each([false, true])(
    "commits 1600-byte audio once after VAD stops (acknowledged: %s)",
    async (acknowledged) => {
      const { session, socket } = await connectSession();
      session.sendAudio(Buffer.alloc(800, 1));
      session.sendAudio(Buffer.alloc(800, 2));
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
      ).toHaveLength(1);
      socket.close();
    },
  );

  it("keeps out-of-order transcription items isolated and emits finals in commit order", async () => {
    const { session, socket, partials, transcripts } = await connectSession();
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
    const { session, socket, errors, transcripts } = await connectSession();
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
    const { session, socket, transcripts, onError } = await connectSession();
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
  });

  it("fails once when unresolved item correlation exceeds its session bound", async () => {
    const { session, socket, onError, onTranscript } = await connectSession();
    for (let index = 0; index < 64; index += 1) {
      emitCommitted(socket, `item-${index}`, "missing-predecessor");
      emitCompleted(socket, `item-${index}`, `turn-${index}`);
    }
    emitFailed(socket, "overflow-item", "provider failure");

    expectOverflow(session, onError, onTranscript, "64 unresolved item");

    const replacementSocket = await connectFakeSession(session, 1);
    emitCommitted(replacementSocket, "replacement-item", null);
    emitCompleted(replacementSocket, "replacement-item", "replacement transcript");

    expect(onTranscript).toHaveBeenCalledExactlyOnceWith("replacement transcript");
    expect(onError).toHaveBeenCalledTimes(1);
    session.close();
    session.close();
  });

  it("fails once when aggregate in-progress transcript text exceeds 256 KiB", async () => {
    const { session, socket, onError, onPartial, onTranscript } = await connectSession();
    const exactLimit = "🙂".repeat((256 * 1024) / 4);

    emitDelta(socket, "item-1", exactLimit);
    emitDelta(socket, "item-1", "x");
    emitCompleted(socket, "item-1", "late transcript");

    expect(onPartial).toHaveBeenCalledExactlyOnceWith(exactLimit);
    expectOverflow(session, onError, onTranscript, "256 KiB retained transcript");
  });

  it("accounts for UTF-8 surrogate pairs split across delta frames", async () => {
    const { session, socket, onError, onPartial } = await connectSession();
    const prefix = "x".repeat(256 * 1024 - 4);

    emitDelta(socket, "item-1", prefix);
    emitDelta(socket, "item-1", "\ud83d");
    emitDelta(socket, "item-1", "\ude42");

    expect(onPartial).toHaveBeenLastCalledWith(`${prefix}🙂`);
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
  });

  it("ignores duplicate completion events without double-charging retained text", async () => {
    const { session, socket, transcripts, onError, onPartial } = await connectSession();
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
  });

  it("tombstones terminal outcomes received before their commit", async () => {
    const { session, socket, errors, partials, transcripts } = await connectSession();
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
  });

  it("keeps the first failed terminal outcome when completion arrives late", async () => {
    const { session, socket, errors, transcripts } = await connectSession();
    emitCommitted(socket, "item-2", "item-1");
    emitFailed(socket, "item-2", "second failed");
    emitCompleted(socket, "item-2", "late second");
    emitCommitted(socket, "item-1", null);
    emitCompleted(socket, "item-1", "first");

    expect(errors).toEqual(["second failed"]);
    expect(transcripts).toEqual(["first"]);
    expect(session.isConnected()).toBe(true);
  });

  it("fails before retaining oversized correlation identities", async () => {
    const { session, socket, onError, onTranscript } = await connectSession();
    session.sendAudio(Buffer.alloc(800, 1));
    emitFailed(socket, "i".repeat(1025), "provider failure");

    expectOverflow(session, onError, onTranscript, "1024-byte item identity");
    expect(parseSent(socket).map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
    ]);
  });

  it.each([
    { label: "without item identity", itemId: undefined, committed: false },
    { label: "before item commit", itemId: "uncommitted-item", committed: false },
    { label: "after item commit", itemId: "committed-item", committed: true },
  ])("rejects an oversized final transcript $label", async ({ itemId, committed }) => {
    const { session, socket, onError, onTranscript } = await connectSession();
    if (committed) {
      emitCommitted(socket, itemId, null);
    }

    const transcript = `${"🙂".repeat((256 * 1024) / 4)}x`;
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      ...(itemId ? { item_id: itemId } : {}),
      transcript,
    });
    emitJson(socket, {
      type: "conversation.item.input_audio_transcription.completed",
      ...(itemId ? { item_id: itemId } : {}),
      transcript: "late transcript",
    });

    expectOverflow(session, onError, onTranscript, "256 KiB retained transcript");
    expect(socket.closed).toBe(true);
  });

  it("accepts an exact-limit UTF-8 final after releasing its own partial", async () => {
    const { session, socket, onError, onPartial, onTranscript } = await connectSession();
    const transcript = "🙂".repeat((256 * 1024) / 4);
    emitDelta(socket, "uncommitted-item", transcript);
    emitCompleted(socket, "uncommitted-item", transcript);

    expect(onPartial).toHaveBeenCalledExactlyOnceWith(transcript);
    expect(onTranscript).toHaveBeenCalledExactlyOnceWith(transcript);
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);
  });

  it("counts retained sibling text when admitting a final transcript", async () => {
    const { session, socket, onError, onTranscript } = await connectSession();
    const partial = "🙂".repeat((128 * 1024) / 4);
    for (const itemId of ["retained-item", "completing-item"]) {
      emitDelta(socket, itemId, partial);
    }
    emitCompleted(socket, "completing-item", `${partial}x`);

    expectOverflow(session, onError, onTranscript, "256 KiB retained transcript");
  });

  it("preserves terminal history at capacity, fails on overflow, and reconnects", async () => {
    const { session, socket, transcripts, onError, onPartial } = await connectSession();
    emitCompleted(socket, "oldest", "first");
    for (let index = 0; index < 4095; index += 1) {
      emitCompleted(socket, `settled-${index}`, "");
    }
    emitCompleted(socket, "oldest", "duplicate");
    emitDelta(socket, "oldest", "late partial");
    expect(transcripts).toEqual(["first"]);
    expect(onPartial).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(true);

    emitCommitted(socket, "overflow-item", null);
    emitFailed(socket, "overflow-item", "provider failure");
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "OpenAI realtime transcription exceeded the terminal item history limit",
      }),
    );
    expect(transcripts).toEqual(["first"]);
    expect(session.isConnected()).toBe(false);

    const replacementSocket = await connectFakeSession(session, 1);
    emitCompleted(replacementSocket, "replacement-item", "replacement transcript");
    expect(transcripts).toEqual(["first", "replacement transcript"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("fails visibly when terminal item identities exceed 256 KiB", async () => {
    const { session, socket, onError, onTranscript } = await connectSession();
    for (let index = 0; index < 256; index += 1) {
      emitCompleted(socket, `${index.toString().padStart(4, "0")}${"i".repeat(1020)}`, "");
    }
    emitCompleted(socket, "overflow-item", "must not emit");

    expectOverflow(session, onError, onTranscript, "terminal item history");
  });

  describe("createOpenAIRealtimeClientSecret", () => {
    it("returns client secret from a well-formed response", async () => {
      const result = await createSecret(
        Response.json({
          client_secret: { value: "eph-secret-abc" },
          expires_at: Math.floor(Date.now() / 1000) + 60,
        }),
      );
      expect(result).toMatchObject({ value: "eph-secret-abc", expiresAt: expect.any(Number) });
      expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeoutMs: 30_000 }),
      );
    });

    it("bounds oversized success response and cancels the stream", async () => {
      let readCount = 0;
      const cancel = vi.fn();
      const chunk = new Uint8Array(1024 * 1024);
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (readCount >= 20) {
              controller.close();
            } else {
              readCount += 1;
              controller.enqueue(chunk);
            }
          },
          cancel,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
      await expect(createSecret(response)).rejects.toThrow(/openai\.realtime-session/);
      expect(cancel).toHaveBeenCalled();
      expect(readCount).toBeLessThan(20);
    });

    it("replaces rejected transcription API-key details with bounded guidance", async () => {
      await expect(
        createSecret(
          Response.json(
            { error: { message: "Incorrect API key provided: secret" } },
            { status: 401 },
          ),
          {
            session: { type: "transcription" },
            authRejectedMessage: "Update the transcription API key",
          },
          "OpenAI Realtime transcription",
        ),
      ).rejects.toThrow("Update the transcription API key");
    });
  });
});
