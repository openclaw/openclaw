import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { RealtimeTranscriptionSessionCreateRequest } from "openclaw/plugin-sdk/realtime-transcription";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { normalizeVoiceCallConfig } from "./config.js";
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
type ResponseResult = { text: string | null; deliveredEarly: boolean; error?: string };
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
  registerCallStream = this.streamOwner.registerCallStream.bind(this.streamOwner);
  hasRegisteredStream = this.streamOwner.hasRegisteredStream.bind(this.streamOwner);
  unregisterCallStream = this.streamOwner.unregisterCallStream.bind(this.streamOwner);
}

const state = createEventManagerHarness();
const managers: CallManager[] = [];
const servers: VoiceCallWebhookServer[] = [];
const pendingResponses: ReturnType<typeof createDeferred<ResponseResult>>[] = [];
const responseCompletions: ReturnType<typeof createDeferred<void>>[] = [];

async function startCall(streaming = false) {
  const config = normalizeVoiceCallConfig({
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
  const server = new VoiceCallWebhookServer(
    createTestPluginServiceScheduler(),
    config,
    manager,
    provider,
    {},
    {} as never,
  );
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
  const expectPlayback = (...texts: string[]) =>
    expect(provider.playTtsCalls.map((entry) => entry.text)).toEqual(texts);
  return { manager, provider, callId: started.callId, speech, openStream, expectPlayback };
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
    fail: async (error: string | Error) => {
      if (typeof error === "string") {
        response.resolve({ text: null, deliveredEarly: false, error });
      } else {
        response.reject(error);
      }
      await completion.promise;
    },
  };
}

async function withPausedPersistence(
  manager: CallManager,
  run: (
    persistence: { entered: Promise<void>; release: () => void },
    processEvent: MockInstance<CallManager["processEvent"]>,
  ) => Promise<void>,
) {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const persist = callStore.persistCallRecord;
  const spy = vi.spyOn(callStore, "persistCallRecord").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    await persist(...args);
  });
  const processEvent = vi.spyOn(manager, "processEvent");
  try {
    await run({ entered: entered.promise, release: () => release.resolve() }, processEvent);
  } finally {
    release.resolve();
    spy.mockRestore();
    processEvent.mockRestore();
  }
}

type TestCall = Awaited<ReturnType<typeof startCall>>;
async function deliverAcrossIgnoredEvent(
  call: TestCall,
  first: Awaited<ReturnType<typeof responseAt>>,
  interrupt: () => Promise<void>,
) {
  await withPausedPersistence(call.manager, async (persistence, processEvent) => {
    const delivery = first.early("current reply");
    await persistence.entered;
    const event = interrupt();
    await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
    persistence.release();
    await event;
    expect(await delivery).toBe(true);
  });
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
  it.each(["reported", "thrown"])(
    "speaks once for a %s generation failure and accepts the next turn",
    async (kind) => {
      const call = await startCall();
      await call.speech("first question");
      const first = await responseAt(0);
      const detail = "provider failed: synthetic-private-detail";
      await first.fail(kind === "reported" ? detail : new Error(detail));
      call.expectPlayback("Sorry, I hit a problem working out a response. Please try again.");
      expect(call.provider.playTtsCalls[0]?.listenAfterPlayback).toBe(true);
      await call.speech("next question");
      await (await responseAt(1)).finish("Here is your answer.");
      call.expectPlayback(
        "Sorry, I hit a problem working out a response. Please try again.",
        "Here is your answer.",
      );
    },
  );

  it.each(["delivered", "superseded"])("keeps a failed %s turn silent", async (kind) => {
    const call = await startCall();
    await call.speech("first question");
    const first = await responseAt(0);
    if (kind === "delivered") {
      expect(await first.early("Already answered.")).toBe(true);
    } else {
      await call.speech("replacement question");
    }
    await first.fail(new Error("generation timed out"));
    call.expectPlayback(...(kind === "delivered" ? ["Already answered."] : []));
    if (kind === "superseded") {
      await (await responseAt(1)).finish("Replacement answer.");
      call.expectPlayback("Replacement answer.");
    }
  });

  it("does not retry a failed fallback playback and keeps the call usable", async () => {
    const call = await startCall();
    const playback = vi
      .spyOn(call.provider, "playTts")
      .mockRejectedValueOnce(new Error("TTS unavailable"));
    await call.speech("first question");
    await (await responseAt(0)).fail("generation failed");
    expect(playback).toHaveBeenCalledOnce();
    expect(call.manager.getCall(call.callId)?.state).toBe("listening");
    await call.speech("next question");
    await (await responseAt(1)).finish("Recovered.");
    call.expectPlayback("Recovered.");
  });

  it.each([true, false])(
    "orders pending playback behind partial speech (stream=%s)",
    async (streaming) => {
      const call = await startCall(streaming);
      const callbacks = streaming
        ? (await call.openStream("stream-pending-write")).callbacks
        : undefined;
      const question = async (text: string) =>
        callbacks ? callbacks.onTranscript?.(text) : call.speech(text);
      await question("first question");
      const first = await responseAt(0);
      await withPausedPersistence(call.manager, async (persistence, processEvent) => {
        const delivery = first.early("obsolete early reply");
        await persistence.entered;
        call.expectPlayback();
        const speech = callbacks ? undefined : call.speech("replacement question", false);
        if (callbacks) {
          callbacks.onPartial?.("wait");
          expect(call.provider.clearTtsQueue).toHaveBeenCalled();
        } else {
          await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
          call.expectPlayback();
        }
        persistence.release();
        await speech;
        expect(await delivery).toBe(false);
        call.expectPlayback();
        await first.finish(streaming ? "obsolete final reply" : "");
        await question("replacement question");
        const second = await responseAt(1);
        await second.finish("current reply");
        call.expectPlayback("current reply");
      });
    },
  );

  it("does not revive a pending transcript reply after newer stream speech starts", async () => {
    const call = await startCall(true);
    const { callbacks } = await call.openStream("stream-pending-transcript");
    await withPausedPersistence(call.manager, async (persistence, processEvent) => {
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
        expect(mocks.generate).toHaveBeenCalledWith(
          expect.objectContaining({ userMessage: "replacement question" }),
        ),
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
      call.expectPlayback("current reply");
    });
  });

  it("keeps explicit speech available after a speech-start with no final transcript", async () => {
    const call = await startCall(true);
    const { callbacks } = await call.openStream("stream-1");
    callbacks.onSpeechStart?.();
    callbacks.onError?.(new Error("transcription failed"));
    expect(await call.manager.speak(call.callId, "Please try again")).toEqual({ success: true });
    call.expectPlayback("Please try again");
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
    call.expectPlayback();
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
    await deliverAcrossIgnoredEvent(call, first, () =>
      call.speech("obsolete input", true, "mismatched-event", "old-token"),
    );
    call.expectPlayback("explicit prompt", "current reply");
    await call.speech("accepted input", true, "accepted-event", turnToken);
    expect(await waiting).toMatchObject({ success: true, transcript: "accepted input" });
    await first.finish("obsolete final reply");
    call.expectPlayback("explicit prompt", "current reply");
  });

  it("does not invalidate on a replayed transcript", async () => {
    const call = await startCall();
    await call.speech("first question", true, "same-event");
    const first = await responseAt(0);
    await deliverAcrossIgnoredEvent(call, first, () =>
      call.speech("first question", true, "same-event"),
    );
    await first.finish("");
    expect(await first.early("late callback after completion")).toBe(false);
    call.expectPlayback("current reply");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
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
    call.expectPlayback("current reply");
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
    call.expectPlayback("replacement reply");
    const disconnected = waitForClose(replacement.ws);
    replacement.callbacks.onTranscript?.("last question");
    const third = await responseAt(2);
    replacement.ws.close();
    await disconnected;
    await vi.waitFor(() => expect(call.provider.hasRegisteredStream("request-uuid")).toBe(false));
    await third.finish("disconnected reply");
    call.expectPlayback("replacement reply");
  });
});
