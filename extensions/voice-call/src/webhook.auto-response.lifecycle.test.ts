import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeTranscriptionSessionCreateRequest } from "openclaw/plugin-sdk/realtime-transcription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createEventManagerHarness,
  FakeProvider,
  finalizeTestManagerCalls,
} from "./manager.test-harness.js";
import * as callStore from "./manager/store.js";
import { TwilioProvider } from "./providers/twilio.js";
import type { NormalizedEvent, WebhookContext } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import { connectWs, waitForClose } from "./websocket-test-support.js";

type ResponseParams = { userMessage: string; onEarlyText?: (text: string) => Promise<boolean> };
type ResponseResult = { text: string; deliveredEarly: boolean };
const mocks = vi.hoisted(() => ({
  generate: vi.fn<(params: ResponseParams) => Promise<ResponseResult>>(),
  createTranscription: vi.fn<(request: RealtimeTranscriptionSessionCreateRequest) => void>(),
}));
vi.mock("./response-generator.js", () => ({ generateVoiceResponse: mocks.generate }));
vi.mock("./realtime-transcription.runtime.js", () => {
  const provider = {
    id: "test-transcription",
    label: "Test transcription",
    isConfigured: () => true,
    createSession: (request: RealtimeTranscriptionSessionCreateRequest) => {
      mocks.createTranscription(request);
      return {
        connect: async () => {},
        sendAudio: () => {},
        close: () => {},
        isConnected: () => true,
      };
    },
  };
  return {
    getRealtimeTranscriptionProvider: () => provider,
    listRealtimeTranscriptionProviders: () => [provider],
  };
});

class SpeechProvider extends FakeProvider {
  private readonly streamOwner = new TwilioProvider({
    accountSid: "test-account",
    authToken: "test-auth",
  });
  readonly clearTtsQueue = vi.fn();
  override verifyWebhook(ctx: WebhookContext) {
    return { ok: true, verifiedRequestKey: ctx.rawBody };
  }
  override parseWebhookEvent(ctx: WebhookContext) {
    return { events: [JSON.parse(ctx.rawBody) as NormalizedEvent], statusCode: 200 };
  }
  isValidStreamToken() {
    return true;
  }
  registerCallStream(callId: string, streamId: string) {
    this.streamOwner.registerCallStream(callId, streamId);
  }
  hasRegisteredStream(callId: string, streamId?: string) {
    return this.streamOwner.hasRegisteredStream(callId, streamId);
  }
  unregisterCallStream(callId: string, streamId: string) {
    this.streamOwner.unregisterCallStream(callId, streamId);
  }
}

const state = createEventManagerHarness();
const managers: CallManager[] = [];
const servers: VoiceCallWebhookServer[] = [];
const pendingResponses: ReturnType<typeof createDeferred<ResponseResult>>[] = [];
const responseCompletions: ReturnType<typeof createDeferred<void>>[] = [];

async function startCall(streaming = false) {
  const config = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: streaming ? "twilio" : "telnyx",
    fromNumber: "+15550000000",
    skipSignatureVerification: true,
    streaming: { enabled: streaming, provider: "test-transcription" },
  });
  config.serve.port = 0;
  const provider = new SpeechProvider(streaming ? "twilio" : "telnyx");
  const ctx = state.createContext({ config });
  const manager = new CallManager(config, ctx.storePath);
  managers.push(manager);
  const createGuard = manager.createAutoResponseGuard.bind(manager);
  vi.spyOn(manager, "createAutoResponseGuard").mockImplementation((call) => {
    const guard = createGuard(call);
    const completion = createDeferred<void>();
    responseCompletions.push(completion);
    return {
      ...guard,
      release() {
        guard.release();
        completion.resolve();
      },
    };
  });
  await manager.initialize(provider, "https://example.test/voice/webhook");
  const started = await manager.initiateCall("+15550000001", undefined, { mode: "conversation" });
  expect(started.success).toBe(true);
  const server = new VoiceCallWebhookServer(config, manager, provider, {}, undefined, {} as never);
  servers.push(server);
  const url = await server.start();
  let eventId = 0;
  const speech = async (transcript: string, isFinal = true, id?: string, turnToken?: string) => {
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({
        id: id ?? `speech-${++eventId}`,
        type: "call.speech",
        callId: "request-uuid",
        providerCallId: "request-uuid",
        timestamp: Date.now(),
        transcript,
        isFinal,
        ...(turnToken ? { turnToken } : {}),
      }),
    });
    expect(response.status).toBe(200);
    await response.text();
  };
  const openStream = async (streamId: string) => {
    const ws = await connectWs(
      `${url.replace("http:", "ws:").replace(config.serve.path, "")}${config.streaming.streamPath}`,
    );
    ws.send(
      JSON.stringify({ event: "start", streamSid: streamId, start: { callSid: "request-uuid" } }),
    );
    await vi.waitFor(() =>
      expect(provider.hasRegisteredStream("request-uuid", streamId)).toBe(true),
    );
    const callbacks = mocks.createTranscription.mock.calls.at(-1)?.[0];
    if (!callbacks) {
      throw new Error("Expected connected transcription session");
    }
    return { ws, callbacks };
  };
  return { manager, provider, callId: started.callId, speech, openStream };
}

async function responseAt(index: number) {
  await vi.waitFor(() => expect(pendingResponses.length).toBeGreaterThan(index));
  const response = pendingResponses[index];
  const completion = responseCompletions[index];
  const early = mocks.generate.mock.calls[index]?.[0].onEarlyText;
  expect(responseCompletions).toHaveLength(pendingResponses.length);
  if (!response || !early || !completion) {
    throw new Error("Expected pending response and early delivery callback");
  }
  return {
    early,
    finish: async (text: string) => {
      response.resolve({ text, deliveredEarly: false });
      await completion.promise;
    },
  };
}

function pausePersistence() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const persist = callStore.persistCallRecord;
  const spy = vi.spyOn(callStore, "persistCallRecord").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    await persist(...args);
  });
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore() {
      release.resolve();
      spy.mockRestore();
    },
  };
}

beforeEach(() => {
  state.setup();
  mocks.createTranscription.mockClear();
  mocks.generate.mockReset().mockImplementation(async () => {
    const response = createDeferred<ResponseResult>();
    pendingResponses.push(response);
    return response.promise;
  });
});
afterEach(async () => {
  for (const response of pendingResponses.splice(0)) {
    response.resolve({ text: "", deliveredEarly: false });
  }
  for (const server of servers.splice(0)) {
    await server.stop();
  }
  await Promise.all(responseCompletions.splice(0).map((completion) => completion.promise));
  for (const manager of managers.splice(0)) {
    await finalizeTestManagerCalls(manager);
  }
  await state.cleanup();
});

describe("automatic phone reply ownership", () => {
  it("revokes a reply waiting for persistence when partial stream speech arrives", async () => {
    const call = await startCall(true);
    const { callbacks } = await call.openStream("stream-pending-write");
    callbacks.onTranscript?.("first question");
    const first = await responseAt(0);
    const persistence = pausePersistence();
    try {
      const delivery = first.early("obsolete early reply");
      await persistence.entered;
      expect(call.provider.playTtsCalls).toEqual([]);
      callbacks.onPartial?.("wait");
      expect(call.provider.clearTtsQueue).toHaveBeenCalled();
      persistence.release();
      expect(await delivery).toBe(false);
      expect(call.provider.playTtsCalls).toEqual([]);
      await first.finish("obsolete final reply");
      callbacks.onTranscript?.("replacement question");
      const second = await responseAt(1);
      await second.finish("current reply");
      expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["current reply"]);
    } finally {
      persistence.restore();
    }
  });

  it("does not revive a pending transcript reply after newer stream speech starts", async () => {
    const call = await startCall(true);
    const { callbacks } = await call.openStream("stream-pending-transcript");
    const persistence = pausePersistence();
    const processEvent = vi.spyOn(call.manager, "processEvent");
    try {
      callbacks.onTranscript?.("obsolete question");
      await persistence.entered;
      const firstEvent = processEvent.mock.results.at(0);
      if (!firstEvent || firstEvent.type !== "return") {
        throw new Error("Expected admitted transcript persistence");
      }
      callbacks.onSpeechStart?.();
      persistence.release();
      await firstEvent.value;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      callbacks.onTranscript?.("replacement question");
      await vi.waitFor(() =>
        expect(
          mocks.generate.mock.calls.some(
            ([params]) => params.userMessage === "replacement question",
          ),
        ).toBe(true),
      );
      expect(mocks.generate.mock.calls.map(([params]) => params.userMessage)).toEqual([
        "replacement question",
      ]);
      expect(call.manager.getCall(call.callId)?.transcript.map((entry) => entry.text)).toEqual([
        "obsolete question",
        "replacement question",
      ]);
      const current = await responseAt(0);
      await current.finish("current reply");
      expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["current reply"]);
    } finally {
      persistence.restore();
      processEvent.mockRestore();
    }
  });

  it("orders automatic playback behind queued partial carrier speech", async () => {
    const call = await startCall();
    await call.speech("first question");
    const first = await responseAt(0);
    const persistence = pausePersistence();
    const processEvent = vi.spyOn(call.manager, "processEvent");
    try {
      const delivery = first.early("obsolete reply");
      await persistence.entered;
      const speech = call.speech("replacement question", false);
      await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
      expect(call.provider.playTtsCalls).toEqual([]);
      persistence.release();
      await speech;
      expect(await delivery).toBe(false);
      expect(call.provider.playTtsCalls).toEqual([]);
      await first.finish("");
      await call.speech("replacement question");
      const replacement = await responseAt(1);
      await replacement.finish("current reply");
      expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["current reply"]);
    } finally {
      persistence.restore();
      processEvent.mockRestore();
    }
  });

  it("keeps explicit speech available after a speech-start with no final transcript", async () => {
    const call = await startCall(true);
    const { callbacks } = await call.openStream("stream-1");
    callbacks.onSpeechStart?.();
    callbacks.onError?.(new Error("transcription failed"));
    expect(await call.manager.speak(call.callId, "Please try again")).toEqual({ success: true });
    expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["Please try again"]);
  });

  it("binds delivery to the exact live call rather than a restored copy of its ID", async () => {
    const call = await startCall();
    await call.speech("first question");
    const first = await responseAt(0);
    const original = call.manager.getCall(call.callId);
    await call.manager.initialize(call.provider, "https://example.test/voice/webhook");
    expect(call.manager.getCall(call.callId)).not.toBe(original);
    expect(await first.early("obsolete early reply")).toBe(false);
    await first.finish("obsolete final reply");
    expect(call.provider.playTtsCalls).toEqual([]);
  });

  it("keeps a reply for rejected turn tokens and revokes it when the waiting turn completes", async () => {
    const call = await startCall(true);
    await call.speech("first question");
    const first = await responseAt(0);
    const waiting = call.manager.continueCall(call.callId, "explicit prompt");
    await vi.waitFor(() => expect(call.provider.startListeningCalls).toHaveLength(1));
    const turnToken = call.provider.startListeningCalls.at(0)?.turnToken;
    if (!turnToken) {
      throw new Error("Expected explicit turn token");
    }
    const persistence = pausePersistence();
    const processEvent = vi.spyOn(call.manager, "processEvent");
    try {
      const delivery = first.early("current reply");
      await persistence.entered;
      const rejectedSpeech = call.speech("obsolete input", true, "mismatched-event", "old-token");
      await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
      persistence.release();
      await rejectedSpeech;
      expect(await delivery).toBe(true);
      expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual([
        "explicit prompt",
        "current reply",
      ]);
      await call.speech("accepted input", true, "accepted-event", turnToken);
      expect(await waiting).toMatchObject({ success: true, transcript: "accepted input" });
      await first.finish("obsolete final reply");
      expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual([
        "explicit prompt",
        "current reply",
      ]);
    } finally {
      persistence.restore();
      processEvent.mockRestore();
    }
  });

  it("does not invalidate on a replayed transcript", async () => {
    const call = await startCall();
    await call.speech("first question", true, "same-event");
    const first = await responseAt(0);
    const persistence = pausePersistence();
    const processEvent = vi.spyOn(call.manager, "processEvent");
    try {
      const delivery = first.early("current reply");
      await persistence.entered;
      const replay = call.speech("first question", true, "same-event");
      await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
      persistence.release();
      await replay;
      expect(await delivery).toBe(true);
      await first.finish("");
      expect(await first.early("late callback after completion")).toBe(false);
      expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["current reply"]);
      expect(mocks.generate).toHaveBeenCalledTimes(1);
    } finally {
      persistence.restore();
      processEvent.mockRestore();
    }
  });

  it("ignores a late final transcript from a predecessor stream", async () => {
    const call = await startCall(true);
    const old = await call.openStream("stream-old");
    old.callbacks.onTranscript?.("old question");
    await responseAt(0);
    const replacement = await call.openStream("stream-new");
    replacement.callbacks.onTranscript?.("new question");
    const current = await responseAt(1);
    call.provider.clearTtsQueue.mockClear();
    old.callbacks.onTranscript?.("late old transcript");
    expect(await current.early("current reply")).toBe(true);
    await current.finish("");
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(call.provider.clearTtsQueue).not.toHaveBeenCalled();
    expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["current reply"]);
  });

  it("fences a disconnected stream's generation without disrupting its replacement", async () => {
    const call = await startCall(true);
    const old = await call.openStream("stream-old");
    old.callbacks.onTranscript?.("old question");
    const first = await responseAt(0);
    const replacement = await call.openStream("stream-new");
    replacement.callbacks.onTranscript?.("new question");
    const second = await responseAt(1);
    const closed = waitForClose(old.ws);
    old.ws.close();
    await closed;
    await first.finish("obsolete reply");
    await second.finish("replacement reply");
    expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["replacement reply"]);
    const disconnected = waitForClose(replacement.ws);
    replacement.callbacks.onTranscript?.("last question");
    const third = await responseAt(2);
    replacement.ws.close();
    await disconnected;
    await vi.waitFor(() => expect(call.provider.hasRegisteredStream("request-uuid")).toBe(false));
    await third.finish("disconnected reply");
    expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["replacement reply"]);
  });
});
