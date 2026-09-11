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
  const early = mocks.generate.mock.calls[index]?.[0].onEarlyText;
  if (!response || !early) {
    throw new Error("Expected pending response and early delivery callback");
  }
  return {
    early,
    finish: async (text: string) => {
      response.resolve({ text, deliveredEarly: false });
      // Finish the synchronous provider's promise continuations before asserting absence.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
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
  for (const manager of managers.splice(0)) {
    await finalizeTestManagerCalls(manager);
  }
  await state.cleanup();
});

describe("automatic phone reply ownership", () => {
  it.each(["native", "partial"] as const)(
    "drops an old reply after %s stream speech and speaks the next reply",
    async (signal) => {
      const call = await startCall(true);
      const { callbacks } = await call.openStream("stream-1");
      callbacks.onTranscript?.("first question");
      const first = await responseAt(0);
      if (signal === "native") {
        callbacks.onSpeechStart?.();
      } else {
        callbacks.onPartial?.("wait");
      }
      expect(await first.early("obsolete early reply")).toBe(false);
      callbacks.onTranscript?.("replacement question");
      const second = await responseAt(1);
      await first.finish("obsolete final reply");
      await second.finish("current reply");
      expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["current reply"]);
      expect(call.provider.clearTtsQueue).toHaveBeenCalled();
    },
  );

  it.each(["native", "partial", "final"] as const)(
    "revokes a reply waiting for persistence when %s stream speech arrives",
    async (signal) => {
      const call = await startCall(true);
      const { callbacks } = await call.openStream("stream-pending-write");
      callbacks.onTranscript?.("first question");
      const first = await responseAt(0);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const persist = callStore.persistCallRecord;
      const persistence = vi
        .spyOn(callStore, "persistCallRecord")
        .mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          await persist(...args);
        });
      try {
        const delivery = first.early("obsolete early reply");
        await entered.promise;
        expect(call.provider.playTtsCalls).toEqual([]);
        if (signal === "native") {
          callbacks.onSpeechStart?.();
        } else if (signal === "partial") {
          callbacks.onPartial?.("wait");
        } else {
          callbacks.onTranscript?.("replacement question");
        }
        release.resolve();
        expect(await delivery).toBe(false);
        expect(call.provider.playTtsCalls).toEqual([]);
        await first.finish("obsolete final reply");
        if (signal !== "final") {
          callbacks.onTranscript?.("replacement question");
        }
        const second = await responseAt(1);
        await second.finish("current reply");
        expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["current reply"]);
      } finally {
        release.resolve();
        persistence.mockRestore();
      }
    },
  );

  it.each(["native", "partial", "final"] as const)(
    "does not revive a pending transcript reply after newer %s stream speech",
    async (signal) => {
      const call = await startCall(true);
      const { callbacks } = await call.openStream("stream-pending-transcript");
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const persist = callStore.persistCallRecord;
      const persistence = vi
        .spyOn(callStore, "persistCallRecord")
        .mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          await persist(...args);
        });
      const processEvent = vi.spyOn(call.manager, "processEvent");
      try {
        callbacks.onTranscript?.("obsolete question");
        await entered.promise;
        const firstEvent = processEvent.mock.results.at(0);
        if (!firstEvent || firstEvent.type !== "return") {
          throw new Error("Expected admitted transcript persistence");
        }
        if (signal === "native") {
          callbacks.onSpeechStart?.();
        } else if (signal === "partial") {
          callbacks.onPartial?.("wait");
        } else {
          // Stream transcript IDs use milliseconds; keep these two fixture events distinct.
          const firstTimestamp = processEvent.mock.calls.at(0)?.[0].timestamp;
          if (firstTimestamp === undefined) {
            throw new Error("Expected first transcript timestamp");
          }
          await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(firstTimestamp));
          callbacks.onTranscript?.("replacement question");
        }
        release.resolve();
        await firstEvent.value;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (signal !== "final") {
          callbacks.onTranscript?.("replacement question");
        }
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
        release.resolve();
        persistence.mockRestore();
        processEvent.mockRestore();
      }
    },
  );

  it.each(["partial", "final"] as const)(
    "orders automatic playback behind queued carrier %s speech",
    async (signal) => {
      const call = await startCall();
      await call.speech("first question");
      const first = await responseAt(0);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const persist = callStore.persistCallRecord;
      const persistence = vi
        .spyOn(callStore, "persistCallRecord")
        .mockImplementationOnce(async (...args) => {
          entered.resolve();
          await release.promise;
          await persist(...args);
        });
      const processEvent = vi.spyOn(call.manager, "processEvent");
      try {
        const delivery = first.early("obsolete reply");
        await entered.promise;
        const speech = call.speech("replacement question", signal === "final");
        await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
        expect(call.provider.playTtsCalls).toEqual([]);
        release.resolve();
        await speech;
        expect(await delivery).toBe(false);
        expect(call.provider.playTtsCalls).toEqual([]);
        await first.finish("");
        if (signal === "partial") {
          await call.speech("replacement question");
        }
        const replacement = await responseAt(1);
        await replacement.finish("current reply");
        expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["current reply"]);
      } finally {
        release.resolve();
        persistence.mockRestore();
        processEvent.mockRestore();
      }
    },
  );

  it("invalidates on accepted carrier interim speech without blocking explicit speech", async () => {
    const call = await startCall();
    await call.speech("first question");
    const first = await responseAt(0);
    await call.speech("wait", false);
    expect(await first.early("obsolete early reply")).toBe(false);
    await first.finish("obsolete final reply");
    expect(await call.manager.speak(call.callId, "explicit announcement")).toEqual({
      success: true,
    });
    expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual([
      "explicit announcement",
    ]);
  });

  it("invalidates when newer speech completes an explicit waiting turn", async () => {
    const call = await startCall();
    await call.speech("first question");
    const first = await responseAt(0);
    const waiting = call.manager.continueCall(call.callId, "explicit prompt");
    await vi.waitFor(() => expect(call.provider.startListeningCalls).toHaveLength(1));
    await call.speech("answer to explicit prompt");
    expect(await waiting).toMatchObject({ success: true, transcript: "answer to explicit prompt" });
    await first.finish("obsolete final reply");
    expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["explicit prompt"]);
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

  it("does not invalidate on a rejected explicit-turn token", async () => {
    const call = await startCall(true);
    await call.speech("first question");
    const first = await responseAt(0);
    const waiting = call.manager.continueCall(call.callId, "explicit prompt");
    await vi.waitFor(() => expect(call.provider.startListeningCalls).toHaveLength(1));
    const turnToken = call.provider.startListeningCalls.at(0)?.turnToken;
    if (!turnToken) {
      throw new Error("Expected explicit turn token");
    }
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const persist = callStore.persistCallRecord;
    const persistence = vi
      .spyOn(callStore, "persistCallRecord")
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        await persist(...args);
      });
    const processEvent = vi.spyOn(call.manager, "processEvent");
    try {
      const delivery = first.early("current reply");
      await entered.promise;
      const rejectedSpeech = call.speech("obsolete input", true, "mismatched-event", "old-token");
      await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
      release.resolve();
      await rejectedSpeech;
      expect(await delivery).toBe(true);
      await first.finish("");
      expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual([
        "explicit prompt",
        "current reply",
      ]);
      expect(await first.early("late callback after completion")).toBe(false);
      await call.speech("accepted input", true, "accepted-event", turnToken);
      expect(await waiting).toMatchObject({ success: true, transcript: "accepted input" });
    } finally {
      release.resolve();
      persistence.mockRestore();
      processEvent.mockRestore();
    }
  });

  it("does not invalidate on a replayed transcript", async () => {
    const call = await startCall();
    await call.speech("first question", true, "same-event");
    const first = await responseAt(0);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const persist = callStore.persistCallRecord;
    const persistence = vi
      .spyOn(callStore, "persistCallRecord")
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        await persist(...args);
      });
    const processEvent = vi.spyOn(call.manager, "processEvent");
    try {
      const delivery = first.early("current reply");
      await entered.promise;
      const replay = call.speech("first question", true, "same-event");
      await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
      release.resolve();
      await replay;
      expect(await delivery).toBe(true);
      await first.finish("");
      expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["current reply"]);
      expect(mocks.generate).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      persistence.mockRestore();
      processEvent.mockRestore();
    }
  });

  it.each(["native", "partial", "final"] as const)(
    "ignores late %s speech from a predecessor stream",
    async (signal) => {
      const call = await startCall(true);
      const old = await call.openStream("stream-old");
      old.callbacks.onTranscript?.("old question");
      await responseAt(0);
      const replacement = await call.openStream("stream-new");
      replacement.callbacks.onTranscript?.("new question");
      const current = await responseAt(1);
      call.provider.clearTtsQueue.mockClear();
      if (signal === "native") {
        old.callbacks.onSpeechStart?.();
      } else if (signal === "partial") {
        old.callbacks.onPartial?.("late old partial");
      } else {
        old.callbacks.onTranscript?.("late old transcript");
      }
      expect(await current.early("current reply")).toBe(true);
      await current.finish("");
      expect(mocks.generate).toHaveBeenCalledTimes(2);
      expect(call.provider.clearTtsQueue).not.toHaveBeenCalled();
      expect(call.provider.playTtsCalls.map((entry) => entry.text)).toEqual(["current reply"]);
    },
  );

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
