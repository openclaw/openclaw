import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import * as webhookRequestGuards from "openclaw/plugin-sdk/webhook-request-guards";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { normalizeVoiceCallConfig, type VoiceCallConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import type { MediaStreamConfig } from "./media-stream.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { MockProvider } from "./providers/mock.js";
import { PlivoProvider } from "./providers/plivo.js";
import { TwilioProvider } from "./providers/twilio.js";
import type { CallRecord } from "./types.js";
import { createWebhookReplayCache, reserveWebhookReplay } from "./webhook-replay.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import type { RealtimeCallHandler } from "./webhook/realtime-handler.js";

const mocks = vi.hoisted(() => {
  const realtimeTranscriptionProvider: RealtimeTranscriptionProviderPlugin = {
    id: "openai",
    label: "OpenAI",
    aliases: ["openai-realtime"],
    isConfigured: () => true,
    resolveConfig: ({ rawConfig }) => rawConfig,
    createSession: () => ({
      connect: async () => {},
      sendAudio: () => {},
      close: () => {},
      isConnected: () => true,
    }),
  };

  return {
    generateVoiceResponse: vi.fn(
      async (_params?: {
        onEarlyText?: (text: string) => Promise<boolean>;
      }): Promise<{ text: string | null; deliveredEarly: boolean }> => ({
        text: null,
        deliveredEarly: false,
      }),
    ),
    getRealtimeTranscriptionProvider: vi.fn<(...args: unknown[]) => unknown>(
      () => realtimeTranscriptionProvider,
    ),
    listRealtimeTranscriptionProviders: vi.fn(() => [realtimeTranscriptionProvider]),
  };
});

vi.mock("./realtime-transcription.runtime.js", () => ({
  getRealtimeTranscriptionProvider: mocks.getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders: mocks.listRealtimeTranscriptionProviders,
}));

beforeEach(() => {
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
});

vi.mock("./response-generator.js", () => ({
  generateVoiceResponse: mocks.generateVoiceResponse,
}));

const provider: VoiceCallProvider = {
  name: "mock",
  verifyWebhook: () => ({ ok: true, verifiedRequestKey: "mock:req:base" }),
  parseWebhookEvent: () => ({ events: [] }),
  initiateCall: async () => ({ providerCallId: "provider-call", status: "initiated" }),
  hangupCall: async () => {},
  playTts: async () => {},
  startListening: async () => {},
  stopListening: async () => {},
  getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
};

function createRealtimeHandler(
  buildTwiMLPayload: RealtimeCallHandler["buildTwiMLPayload"],
): RealtimeCallHandler {
  return {
    buildTwiMLPayload,
    close: async () => {},
    getStreamPathPattern: () => "/voice/stream/realtime",
    handleWebSocketUpgrade: () => {},
    registerToolHandler: () => {},
    setPublicUrl: () => {},
  } as unknown as RealtimeCallHandler;
}

type TwilioProviderTestDouble = VoiceCallProvider &
  Pick<
    TwilioProvider,
    | "isValidStreamToken"
    | "registerCallStream"
    | "unregisterCallStream"
    | "hasRegisteredStream"
    | "clearTtsQueue"
  >;

type VoiceCallConfigInput = Record<string, unknown> & {
  serve?: Partial<VoiceCallConfig["serve"]>;
};

const createConfig = (overrides: VoiceCallConfigInput = {}): VoiceCallConfig => {
  const config = normalizeVoiceCallConfig({
    ...overrides,
    serve: { ...overrides.serve, port: overrides.serve?.port || 1 },
  });
  config.serve.port = overrides.serve?.port ?? 0;
  return config;
};

const createCall = (startedAt: number): CallRecord => ({
  callId: "call-1",
  agentId: "main",
  providerCallId: "provider-call-1",
  provider: "mock",
  direction: "outbound",
  state: "initiated",
  from: "+15550001234",
  to: "+15550005678",
  startedAt,
  transcript: [],
  processedEventIds: [],
});

const automaticReplyManagerStub = {
  updateCallMetadata: async (
    call: CallRecord,
    update: (metadata: CallRecord["metadata"]) => CallRecord["metadata"],
  ) => {
    call.metadata = update(call.metadata);
  },
  createAutoResponseGuard: () => ({ isCurrent: () => true, release: () => {} }),
  invalidateAutoResponse: () => {},
};

const createManager = (calls: CallRecord[], overrides: Partial<CallManager> = {}) => {
  const endCall = vi.fn(async () => ({ success: true }));
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const manager = {
    ...automaticReplyManagerStub,
    getActiveCalls: () => calls,
    endCall,
    processEvent,
    ...overrides,
  } as unknown as CallManager;

  return { manager, endCall, processEvent };
};

type WebhookServerArgs =
  ConstructorParameters<typeof VoiceCallWebhookServer> extends [unknown, ...infer Args]
    ? Args
    : never;

function createServer(...args: WebhookServerArgs) {
  const server = new VoiceCallWebhookServer(createTestPluginServiceScheduler(), ...args);
  onTestFinished(() => server.stop());
  return server;
}

function createFixture(
  config: VoiceCallConfigInput = {},
  testProvider = provider,
  logger?: WebhookServerArgs[6],
  state = createManager([]),
) {
  return {
    ...state,
    server: createServer(
      createConfig(config),
      state.manager,
      testProvider,
      undefined,
      undefined,
      undefined,
      logger,
    ),
  };
}

function createStreamingFixture(
  state: ReturnType<typeof createManager>,
  testProvider: VoiceCallProvider,
) {
  const { logger, messages } = createCapturingLogger();
  return {
    ...createFixture(
      { provider: "twilio", streaming: { enabled: true } },
      testProvider,
      logger,
      state,
    ),
    messages,
  };
}

function createSignedTwilioFixture(
  authToken: string,
  calls: CallRecord[] = [],
  config: VoiceCallConfigInput = {},
  streamPath?: string,
) {
  const twilio = { accountSid: "AC123", authToken };
  const twilioProvider = new TwilioProvider(twilio, streamPath ? { streamPath } : undefined);
  const state = createManager(calls);
  const server = createServer(
    createConfig({ ...config, provider: "twilio", twilio }),
    state.manager,
    twilioProvider,
  );
  return {
    ...state,
    server,
    twilioProvider,
    start: async (body: string) => {
      const baseUrl = await server.start();
      twilioProvider.setPublicUrl(baseUrl);
      return () => postSignedTwilioWebhook({ baseUrl, authToken, body });
    },
  };
}

function mediaCallbacks(server: VoiceCallWebhookServer) {
  return (server.getMediaStreamHandler() as unknown as { config: MediaStreamConfig }).config;
}

function webhookPipeline(server: VoiceCallWebhookServer) {
  return (
    server as unknown as {
      runWebhookPipeline: (
        req: IncomingMessage,
        path: string,
      ) => Promise<{ statusCode: number; body: string }>;
    }
  ).runWebhookPipeline.bind(server);
}

function createStreamResponse(token = "token") {
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml" },
    body: `<Response><Connect><Stream url="wss://example.test/${token}" /></Connect></Response>`,
  };
}

function blockedBodyReads(blockAll = false) {
  let entered = 0;
  const ready = createDeferred<void>();
  const unblock = createDeferred<void>();
  const spy = vi
    .spyOn(webhookRequestGuards, "readRequestBodyWithLimit")
    .mockImplementation(async () => {
      if (++entered === 8) {
        ready.resolve();
      }
      if (blockAll || entered <= 8) {
        await unblock.promise;
      }
      return "CallSid=CA123&SpeechResult=hello";
    });
  return { ready: ready.promise, unblock: () => unblock.resolve(), spy };
}

function expectNotCalled(...spies: unknown[]) {
  for (const mock of spies) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function createCapturingLogger() {
  const messages: string[] = [];
  const capture = (message: string) => messages.push(message);
  return {
    messages,
    logger: { info: capture, warn: capture, error: capture },
  };
}

function expectPrivateLogMetadata(params: {
  messages: readonly string[];
  identifiers: readonly string[];
  privateText: readonly string[];
}) {
  const output = params.messages.join(" ");
  expect(output).toContain("[voice-call]");
  expect(output).toContain("chars=");
  for (const identifier of params.identifiers) {
    expect(output).toContain(identifier);
  }
  for (const privateText of params.privateText) {
    expect(output).not.toContain(privateText);
  }
}

function expectWebhookUrl(url: string, expectedPath: string) {
  const parsed = new URL(url);
  expect(parsed.pathname).toBe(expectedPath);
  expect(parsed.port).not.toBe("");
  expect(parsed.port).not.toBe("0");
}

function expectNoTwilioStreamState(providerLocal: TwilioProvider) {
  const state = providerLocal as unknown as {
    callStreamMap: Map<string, string>;
    streamAuthTokens: Map<string, string>;
  };
  expect(state.callStreamMap.size).toBe(0);
  expect(state.streamAuthTokens.size).toBe(0);
}

async function expectTwilioReplayTwiML(response: Response) {
  expect(await expectXmlBody(response)).toBe(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
  );
}

async function expectXmlBody(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/xml");
  return response.text();
}

async function postSignedTwilioWebhook(params: {
  baseUrl: string;
  authToken: string;
  body: string;
}): Promise<Response> {
  const url = new URL(params.baseUrl);
  let signedMaterial = url.toString();
  for (const [key, value] of [...new URLSearchParams(params.body)].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    signedMaterial += key + value;
  }
  const signature = crypto
    .createHmac("sha1", params.authToken)
    .update(signedMaterial)
    .digest("base64");
  return await postWebhookForm(url, params.body, {
    "x-twilio-signature": signature,
  });
}

function createTwilioVerificationProvider(
  overrides: Partial<TwilioProviderTestDouble> = {},
): VoiceCallProvider {
  return {
    ...provider,
    name: "twilio",
    verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:test" }),
    ...overrides,
  };
}

function createTwilioStreamingProvider(
  overrides: Partial<TwilioProviderTestDouble> = {},
): TwilioProviderTestDouble {
  return {
    ...createTwilioVerificationProvider(),
    isValidStreamToken: () => true,
    registerCallStream: () => {},
    unregisterCallStream: () => {},
    hasRegisteredStream: () => true,
    clearTtsQueue: () => {},
    ...overrides,
  };
}

describe("VoiceCallWebhookServer media stream authorization", () => {
  it("rejects non-Twilio providers before consulting their call id", async () => {
    const call = createCall(Date.now());
    const getCallByProviderCallId = vi.fn(() => call);
    const { manager } = createManager([call], {
      getCallByProviderCallId,
      processEvent: vi.fn(),
      speakInitialMessage: vi.fn(async () => {}),
    });
    const server = createServer(
      createConfig({ provider: "mock", streaming: { enabled: true } }),
      manager,
      provider,
    );
    await server.start();
    const shouldAcceptStream = mediaCallbacks(server).shouldAcceptStream;
    if (!shouldAcceptStream) {
      throw new Error("expected media stream acceptance validator");
    }

    expect(shouldAcceptStream({ callId: call.providerCallId ?? "", streamSid: "stream-1" })).toBe(
      false,
    );
    expect(getCallByProviderCallId).not.toHaveBeenCalled();
  });
});

describe("VoiceCallWebhookServer media stream client IP resolution", () => {
  it.each<[string, boolean, string[], string, string]>([
    ["allowed hosts without forwarding trust", false, ["127.0.0.1"], "127.0.0.1", "127.0.0.1"],
    ["untrusted remote", true, ["203.0.113.10"], "127.0.0.1", "127.0.0.1"],
    [
      "mapped remote and trusted proxy chain",
      true,
      ["127.0.0.1", "203.0.113.10"],
      "::ffff:127.0.0.1",
      "198.51.100.10",
    ],
  ])("resolves client IP with %s", (_name, trust, proxies, remote, expected) => {
    const { server } = createFixture(
      {
        webhookSecurity: {
          allowedHosts: ["voice.example.com"],
          trustForwardingHeaders: trust,
          trustedProxyIPs: proxies,
        },
      },
      createTwilioStreamingProvider(),
    );
    const resolve = (
      server as unknown as {
        resolveMediaStreamClientIp: (request: {
          headers: Record<string, string>;
          socket: { remoteAddress?: string };
        }) => string | undefined;
      }
    ).resolveMediaStreamClientIp.bind(server);
    expect(
      resolve({
        headers: {
          "x-forwarded-for": "192.0.2.99, 198.51.100.10, 203.0.113.10",
          "x-real-ip": "198.51.100.11",
        },
        socket: { remoteAddress: remote },
      }),
    ).toBe(expected);
  });
});

async function postWebhookForm(
  baseUrl: string | URL,
  body: string,
  headers: Record<string, string> = {},
) {
  return await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
}

describe("VoiceCallWebhookServer stale call reaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaps stale unanswered calls while preserving answered calls", async () => {
    const stale = createCall(Date.now() - 120_000);
    const answered = {
      ...stale,
      callId: "answered",
      state: "answered" as const,
      answeredAt: Date.now() - 90_000,
    };
    const { manager, endCall } = createManager([stale, answered]);
    const server = createServer(createConfig({ staleCallReaperSeconds: 60 }), manager, provider);
    await server.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(endCall).toHaveBeenCalledExactlyOnceWith(stale.callId);
  });

  it("joins admitted reaper hangups while handler shutdown can finish", async () => {
    const hangup = createDeferred<{ success: boolean }>();
    const handlerClosed = createDeferred<void>();
    const handlerClose = vi.fn(() => handlerClosed.promise);
    const { manager, endCall } = createManager([createCall(Date.now() - 60_000)]);
    endCall.mockImplementation(() => hangup.promise);
    const server = createServer(createConfig({ staleCallReaperSeconds: 1 }), manager, provider);
    const handler = createRealtimeHandler(vi.fn());
    handler.close = handlerClose;
    server.setRealtimeHandler(handler);
    let stopped = false;
    try {
      await server.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(endCall).toHaveBeenCalledOnce();
      const stopping = server.stop();
      void stopping.then(() => {
        stopped = true;
      });
      expect(server.stop()).toBe(stopping);
      expect(handlerClose).toHaveBeenCalledOnce();
      handlerClosed.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      hangup.resolve({ success: true });
      await stopping;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(endCall).toHaveBeenCalledOnce();
    } finally {
      handlerClosed.resolve();
      hangup.resolve({ success: true });
      await server.stop();
    }
    expect(stopped).toBe(true);
  });
});

describe("VoiceCallWebhookServer path matching", () => {
  it("rejects lookalike webhook paths that only match by prefix", async () => {
    const verifyWebhook = vi.fn(() => ({ ok: true, verifiedRequestKey: "verified:req:prefix" }));
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const strictProvider: VoiceCallProvider = {
      ...provider,
      verifyWebhook,
      parseWebhookEvent,
    };
    const { server } = createFixture({}, strictProvider);

    const baseUrl = await server.start();
    const requestUrl = new URL(baseUrl);
    requestUrl.pathname = "/voice/webhook-evil";

    const response = await postWebhookForm(requestUrl, "CallSid=CA123&SpeechResult=hello");

    expect(response.status).toBe(404);
    expectNotCalled(verifyWebhook, parseWebhookEvent);
  });

  it("matches webhook paths without trusting malformed Host headers", async () => {
    const verifyWebhook = vi.fn((ctx) => {
      expect(ctx.url).toBe("http://localhost/voice/webhook?type=status");
      expect(ctx.query).toEqual({ type: "status" });
      return { ok: true, verifiedRequestKey: "verified:req:host" };
    });
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const strictProvider: VoiceCallProvider = {
      ...provider,
      verifyWebhook,
      parseWebhookEvent,
    };
    const { server } = createFixture({}, strictProvider);
    const readBodySpy = vi.spyOn(webhookRequestGuards, "readRequestBodyWithLimit");
    readBodySpy.mockResolvedValue("CallSid=CA123&SpeechResult=hello");
    const runWebhookPipeline = webhookPipeline(server);

    const result = await runWebhookPipeline(
      {
        method: "POST",
        url: "/voice/webhook?type=status",
        headers: { host: "[" },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage,
      "/voice/webhook",
    );

    expect(result.statusCode).toBe(200);
    expect(verifyWebhook).toHaveBeenCalledTimes(1);
    expect(parseWebhookEvent).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceCallWebhookServer replay handling", () => {
  it("never lets a stale owner release a newer same-key replay reservation", () => {
    const cache = createWebhookReplayCache();
    const firstOwner = reserveWebhookReplay(cache, "signed-generation-key");
    expect(reserveWebhookReplay(cache, "signed-generation-key")).toMatchObject({ isReplay: true });

    firstOwner.releaseReplay?.();
    expect(reserveWebhookReplay(cache, "signed-generation-key")).toMatchObject({ isReplay: false });
    firstOwner.releaseReplay?.();
    expect(reserveWebhookReplay(cache, "signed-generation-key")).toMatchObject({ isReplay: true });
  });

  it("redelivers an identical signed Twilio callback after its unknown call is registered", async () => {
    const providerCallId = "CA-signed-late-registration";
    const registeredCalls: CallRecord[] = [];
    const { start, processEvent } = createSignedTwilioFixture(
      "signed-late-registration-token",
      registeredCalls,
    );
    processEvent.mockImplementation(async (event) =>
      registeredCalls.some((call) => call.providerCallId === event.providerCallId)
        ? { kind: "processed" }
        : { kind: "ignored", replayable: true },
    );
    const send = await start(
      `CallSid=${providerCallId}&CallStatus=in-progress&Direction=outbound-api`,
    );
    expect((await send()).status).toBe(200);
    registeredCalls.push({ ...createCall(Date.now()), provider: "twilio", providerCallId });
    expect((await send()).status).toBe(200);
    expect(processEvent).toHaveBeenCalledTimes(2);
    await expectTwilioReplayTwiML(await send());
    expect(processEvent).toHaveBeenCalledTimes(2);
  });

  it("holds a signed webhook response until event persistence finishes", async () => {
    const { start, processEvent } = createSignedTwilioFixture("signed-delayed-store-token");
    const persistence = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    processEvent.mockReturnValueOnce(persistence.promise);
    const send = await start(
      "CallSid=CA-delayed-store&CallStatus=in-progress&Direction=outbound-api",
    );
    let answered = false;
    const response = send().then((result) => {
      answered = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(processEvent).toHaveBeenCalledOnce());
      expect(answered).toBe(false);
      persistence.resolve({ kind: "processed" });
      expect((await response).status).toBe(200);
    } finally {
      persistence.resolve({ kind: "processed" });
      await response;
    }
  });

  it("shares failed signed callbacks and successful retries without leaking stream tokens", async () => {
    const { server, start, processEvent, twilioProvider } = createSignedTwilioFixture(
      "signed-concurrent-token",
      [],
      { inboundPolicy: "open", realtime: { enabled: true } },
      "/voice/stream/realtime",
    );
    const verification = vi.spyOn(twilioProvider, "verifyWebhook");
    let response = createDeferred<ReturnType<RealtimeCallHandler["buildTwiMLPayload"]>>();
    const buildTwiMLPayload = vi.fn(
      () => response.promise as unknown as ReturnType<RealtimeCallHandler["buildTwiMLPayload"]>,
    );
    server.setRealtimeHandler(createRealtimeHandler(buildTwiMLPayload));
    const send = await start("CallSid=CA-concurrent&Direction=inbound&CallStatus=ringing");
    const sendPair = async (attempt: number) => {
      const owner = send();
      await vi.waitFor(() => expect(buildTwiMLPayload).toHaveBeenCalledTimes(attempt));
      const duplicate = send();
      let duplicateSettled = false;
      void duplicate.then(() => {
        duplicateSettled = true;
      });
      await vi.waitFor(() => expect(verification).toHaveBeenCalledTimes(attempt * 2));
      expect(duplicateSettled).toBe(false);
      return { owner, duplicate };
    };
    const failed = await sendPair(1);
    response.reject(new Error("synthetic realtime setup failure"));
    expect(
      (await Promise.all([failed.owner, failed.duplicate])).map((reply) => reply.status),
    ).toEqual([500, 500]);
    response = createDeferred<ReturnType<RealtimeCallHandler["buildTwiMLPayload"]>>();
    const retry = await sendPair(2);
    response.resolve(createStreamResponse("one-time-secret"));
    expect(await (await retry.owner).text()).toContain("one-time-secret");
    await expectTwilioReplayTwiML(await retry.duplicate);
    await expectTwilioReplayTwiML(await send());
    expect(buildTwiMLPayload).toHaveBeenCalledTimes(2);
    expect(processEvent).not.toHaveBeenCalled();
    expectNoTwilioStreamState(twilioProvider);
  });

  it("reconstructs an uncached replay response without repeating event side effects", async () => {
    const mockProvider = new MockProvider();
    const parseWebhookEvent = vi.spyOn(mockProvider, "parseWebhookEvent");
    const { manager, processEvent } = createManager([]);
    const body = JSON.stringify({
      event: {
        type: "call.error",
        callId: "call-replay",
        error: "carrier failure",
        retryable: false,
      },
    });
    const first = createServer(createConfig(), manager, mockProvider);
    expect((await postWebhookForm(await first.start(), body)).status).toBe(200);
    expect(processEvent).toHaveBeenCalledOnce();
    await first.stop();
    processEvent.mockClear();
    parseWebhookEvent.mockClear();
    const replacement = createServer(createConfig(), manager, mockProvider);
    const replay = await postWebhookForm(await replacement.start(), body);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe("OK");
    expect(parseWebhookEvent).toHaveBeenCalledOnce();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("returns Plivo XML for replayed answer callbacks while skipping event side effects", async () => {
    const authToken = "signed-plivo-replay-token";
    const nonce = "signed-plivo-replay-nonce";
    const publicUrl = "https://example.test/voice/webhook";
    const plivo = { authId: "MA000000000000000000", authToken };
    const plivoProvider = new PlivoProvider(plivo, { publicUrl });
    const parseWebhookEvent = vi.spyOn(plivoProvider, "parseWebhookEvent");
    const { logger, messages } = createCapturingLogger();
    const { server, processEvent } = createFixture(
      {
        provider: "plivo",
        skipSignatureVerification: false,
        serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" },
        staleCallReaperSeconds: 0,
        plivo,
      },
      plivoProvider,
      logger,
    );

    const baseUrl = await server.start();
    const requestUrl = new URL(
      "?provider=plivo&flow=answer&callId=internal-call-id&tag=z&tag=a",
      baseUrl,
    );
    const body =
      "CallUUID=plivo-replay-answer-callback&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp&Tag=z&Tag=a";
    const canonicalBaseFor = (tag: string) =>
      `${publicUrl}?callId=internal-call-id&flow=answer&provider=plivo&tag=a&tag=z.CallStatusin-progressCallUUIDplivo-replay-answer-callbackDirectionoutboundEventStartAppFrom+15550000000Tag${tag}TagzTo+15550000001`;
    const signatureFor = (tag: string) =>
      crypto
        .createHmac("sha256", authToken)
        .update(`${canonicalBaseFor(tag)}.${nonce}`)
        .digest("base64");
    const expectedKeyFor = (tag: string) =>
      `plivo:v3:${crypto
        .createHash("sha256")
        .update(`${canonicalBaseFor(tag)}\n${nonce}`)
        .digest("hex")}`;
    const postCallback = (rawBody: string, signature: string) =>
      postWebhookForm(requestUrl, rawBody, {
        "x-plivo-signature-v3": signature,
        "x-plivo-signature-v3-nonce": nonce,
      });
    const expectProcessedKey = (tag: string) => {
      expect(parseWebhookEvent).toHaveBeenCalledTimes(1);
      expect(processEvent).toHaveBeenCalledTimes(1);
      const key = processEvent.mock.calls[0]?.[0].dedupeKey;
      expect(key).toBe(expectedKeyFor(tag));
      expect(parseWebhookEvent.mock.calls[0]?.[1]).toEqual({
        verifiedRequestKey: expectedKeyFor(tag),
      });
      return key;
    };

    const rejected = await postCallback(body, "invalid");
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).toBe("Unauthorized");
    expectNotCalled(parseWebhookEvent, processEvent);

    processEvent.mockRejectedValueOnce(new Error("synthetic SQLite persistence failure"));
    expect((await postCallback(body, signatureFor("a"))).status).toBe(500);
    expect(messages).toContain(
      "[voice-call] Webhook error: Error: synthetic SQLite persistence failure",
    );
    processEvent.mockClear();
    parseWebhookEvent.mockClear();
    const first = await postCallback(body, signatureFor("a"));
    const expectedBody = await expectXmlBody(first);
    expect(expectedBody).toContain("<Wait");
    const firstKey = expectProcessedKey("a");

    parseWebhookEvent.mockClear();
    processEvent.mockClear();

    requestUrl.search = "?tag=a&callId=internal-call-id&tag=z&flow=answer&provider=plivo";
    const replay = await postCallback(body.split("&").toReversed().join("&"), signatureFor("a"));

    const replayBody = await expectXmlBody(replay);
    expect(replayBody).toContain("<Wait");
    expect(replayBody).toBe(expectedBody);
    expectNotCalled(parseWebhookEvent, processEvent);

    const changed = await postCallback(body.replace("Tag=a", "Tag=b"), signatureFor("b"));
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe(expectedBody);
    expect(expectProcessedKey("b")).not.toBe(firstKey);
  });

  it("consumes initial outbound TwiML before redirecting into realtime", async () => {
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const consumeInitialTwiML = vi
      .fn<NonNullable<VoiceCallProvider["consumeInitialTwiML"]>>()
      .mockReturnValueOnce(
        '<Response><Play digits="ww123456#" /><Redirect method="POST">https://example.test</Redirect></Response>',
      );
    const buildTwiMLPayload = vi.fn(() => createStreamResponse("voice/stream/realtime/token"));
    const twilioProvider: VoiceCallProvider = {
      ...provider,
      name: "twilio",
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:rt-stored" }),
      parseWebhookEvent,
      consumeInitialTwiML,
    };
    const { server, processEvent } = createFixture(
      {
        provider: "twilio",
        inboundPolicy: "disabled",
        realtime: { enabled: true },
      },
      twilioProvider,
    );
    server.setRealtimeHandler(createRealtimeHandler(buildTwiMLPayload));

    const baseUrl = await server.start();
    const requestUrl = new URL(baseUrl);
    requestUrl.searchParams.set("callId", "call-1");
    const response = await postWebhookForm(
      requestUrl,
      "CallSid=CA123&Direction=outbound-api&CallStatus=in-progress&From=%2B15550001111&To=%2B15550002222",
      { "x-twilio-signature": "sig" },
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<Play digits="ww123456#"');
    expect(consumeInitialTwiML).toHaveBeenCalledTimes(1);
    expectNotCalled(buildTwiMLPayload, parseWebhookEvent, processEvent);
    const redirect = await postWebhookForm(
      baseUrl,
      "CallSid=CA123&Direction=outbound-api&CallStatus=in-progress",
      { "x-twilio-signature": "sig" },
    );
    expect(redirect.status).toBe(200);
    expect(await redirect.text()).toContain("<Connect><Stream");
    expect(consumeInitialTwiML).toHaveBeenCalledTimes(2);
    expect(buildTwiMLPayload).toHaveBeenCalledOnce();
    expectNotCalled(parseWebhookEvent, processEvent);
  });

  it("creates realtime stream tokens only for allowlisted callers", async () => {
    const buildTwiMLPayload = vi.fn(() => createStreamResponse());
    const twilioProvider = createTwilioVerificationProvider({
      verifyWebhook: (ctx) => ({ ok: true, verifiedRequestKey: ctx.rawBody }),
    });
    const { server } = createFixture(
      {
        provider: "twilio",
        inboundPolicy: "allowlist",
        allowFrom: ["+15550001111"],
        realtime: { enabled: true },
      },
      twilioProvider,
    );
    server.setRealtimeHandler(createRealtimeHandler(buildTwiMLPayload));
    const url = await server.start();
    const send = (from: string) =>
      postWebhookForm(
        url,
        `CallSid=CA123&Direction=inbound&CallStatus=ringing&From=${encodeURIComponent(from)}`,
        { "x-twilio-signature": "sig" },
      );
    const rejected = await send("+15550002222");
    expect(rejected.status).toBe(200);
    expect(await rejected.text()).toContain("<Reject");
    expect(buildTwiMLPayload).not.toHaveBeenCalled();
    const accepted = await send("+15550001111");
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain("<Connect><Stream");
    expect(buildTwiMLPayload).toHaveBeenCalledOnce();
  });

  it("rejects requests when verification succeeds without a request key", async () => {
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const badProvider: VoiceCallProvider = {
      ...provider,
      verifyWebhook: () => ({ ok: true }),
      parseWebhookEvent,
    };
    const { server } = createFixture({}, badProvider);

    const baseUrl = await server.start();
    const response = await postWebhookForm(baseUrl, "CallSid=CA123&SpeechResult=hello");

    expect(response.status).toBe(401);
    expect(parseWebhookEvent).not.toHaveBeenCalled();
  });
});

describe("VoiceCallWebhookServer pre-auth webhook guards", () => {
  it("rejects missing signature headers before reading the request body", async () => {
    const verifyWebhook = vi.fn(() => ({ ok: true, verifiedRequestKey: "twilio:req:test" }));
    const twilioProvider = createTwilioVerificationProvider({ verifyWebhook });
    const { server } = createFixture({ provider: "twilio" }, twilioProvider);
    const readBodySpy = vi.spyOn(webhookRequestGuards, "readRequestBodyWithLimit");

    const baseUrl = await server.start();
    const response = await postWebhookForm(baseUrl, "CallSid=CA123&SpeechResult=hello");

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expectNotCalled(readBodySpy, verifyWebhook);
  });

  it.each([false, true])(
    "limits pre-auth requests (missing remote address: %s)",
    async (missingRemote) => {
      const { server } = createFixture({ provider: "twilio" }, createTwilioVerificationProvider());
      const runWebhookPipeline = webhookPipeline(server);
      const reads = blockedBodyReads(missingRemote);
      const baseUrl = missingRemote ? undefined : await server.start();
      const send = async (body: string) => {
        if (baseUrl) {
          const response = await postWebhookForm(baseUrl, body, { "x-twilio-signature": "sig" });
          return { statusCode: response.status, body: await response.text() };
        }
        return runWebhookPipeline(
          {
            method: "POST",
            url: "/voice/webhook",
            headers: { "x-twilio-signature": "sig" },
            socket: { remoteAddress: undefined },
          } as unknown as IncomingMessage,
          "/voice/webhook",
        );
      };
      try {
        const inFlightRequests = Array.from({ length: 8 }, () => send("CallSid=CA123"));
        await reads.ready;
        expect(await send("CallSid=CA999")).toEqual({ statusCode: 429, body: "Too Many Requests" });
        expect(reads.spy).toHaveBeenCalledTimes(8);
        reads.unblock();
        const settled = await Promise.all(inFlightRequests);
        expect(settled.map((response) => response.statusCode)).toEqual(Array(8).fill(200));
      } finally {
        reads.unblock();
        reads.spy.mockRestore();
        await server.stop();
      }
    },
  );
});

describe("VoiceCallWebhookServer classic response routing", () => {
  function responseFixture(
    call: CallRecord,
    config = createConfig({ agentId: "main" }),
    logger?: WebhookServerArgs[6],
  ) {
    const speak = vi.fn(async () => ({ success: true }));
    const manager = {
      ...automaticReplyManagerStub,
      getCall: (callId: string) => (callId === call.callId ? call : undefined),
      speak,
    } as unknown as CallManager;
    const server = createServer(config, manager, provider, {}, undefined, {} as never, logger);
    const handler = server as unknown as {
      handleInboundResponse: (callId: string, message: string) => Promise<void>;
    };
    return {
      speak,
      respond: (message: string) => handler.handleInboundResponse(call.callId, message),
    };
  }

  it("keeps outbound calls on their frozen agent when the dialed number has an inbound route", async () => {
    const call = createCall(Date.now());
    call.agentId = "support";
    call.to = "+15550001111";
    call.sessionKey = "agent:top:voice:15550001111";
    const config = createConfig({
      agentId: "top",
      numbers: {
        "+15550001111": { agentId: "inbound-route" },
      },
    });
    const { speak, respond } = responseFixture(call, config);
    mocks.generateVoiceResponse
      .mockReset()
      .mockResolvedValue({ text: "Hello back", deliveredEarly: false });

    await respond("hello");

    expect(mocks.generateVoiceResponse.mock.calls[0]?.[0]).toMatchObject({
      voiceConfig: { agentId: "top" },
      agentId: "support",
    });
    expect(mocks.generateVoiceResponse.mock.calls[0]?.[0]).toHaveProperty(
      "senderIsOwner",
      undefined,
    );
    expect(speak).toHaveBeenCalledWith(call.callId, "Hello back", {
      listenAfterPlayback: true,
      isCurrent: expect.any(Function),
    });
  });

  it("marks inbound calls as non-owners and does not replay an early response", async () => {
    const call = createCall(Date.now());
    call.direction = "inbound";
    const { speak, respond } = responseFixture(call);
    mocks.generateVoiceResponse.mockReset().mockImplementationOnce(async (params) => {
      await params?.onEarlyText?.("Spoken before compaction. Final detail.");
      return {
        text: "Spoken before compaction. Final detail.",
        deliveredEarly: true,
      };
    });

    await respond("hello");

    expect(speak.mock.calls).toEqual([
      [
        call.callId,
        "Spoken before compaction. Final detail.",
        { listenAfterPlayback: true, isCurrent: expect.any(Function) },
      ],
    ]);
    expect(mocks.generateVoiceResponse.mock.calls[0]?.[0]).toHaveProperty("senderIsOwner", false);
  });

  it("logs only char counts for inbound user text, early AI text, and final AI text", async () => {
    const call = createCall(Date.now());

    const { logger, messages } = createCapturingLogger();

    const { respond } = responseFixture(call, undefined, logger);

    const userMessage = "sensitive user speech content";
    const earlyText = "confidential early AI response";
    const finalText = "private final AI response";
    mocks.generateVoiceResponse.mockReset().mockImplementationOnce(async (params) => {
      await params?.onEarlyText?.(earlyText);
      return { text: finalText, deliveredEarly: false };
    });

    await respond(userMessage);

    expectPrivateLogMetadata({
      messages,
      identifiers: [call.callId],
      privateText: [userMessage, earlyText, finalText],
    });
  });
});

describe("VoiceCallWebhookServer start idempotency", () => {
  it("coalesces starts, reuses its listening URL, and restarts after stop", async () => {
    const { server } = createFixture();
    await server.stop();
    const [first, concurrent] = await Promise.all([server.start(), server.start()]);
    expectWebhookUrl(first, "/voice/webhook");
    expect(concurrent).toBe(first);
    expect(await server.start()).toBe(first);
    await server.stop();
    expectWebhookUrl(await server.start(), "/voice/webhook");
  });
});

describe("VoiceCallWebhookServer stream disconnect grace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores stale stream disconnects after reconnect and only hangs up on current stream disconnect", async () => {
    const call = createCall(Date.now() - 1_000);
    call.providerCallId = "CA-stream-1";

    const endCall = vi.fn(async () => ({ success: false, error: "carrier unavailable" }));
    const speakInitialMessage = vi.fn(async () => {});
    const getCallByProviderCallId = vi.fn((providerCallId: string) =>
      providerCallId === "CA-stream-1" ? call : undefined,
    );

    const state = createManager([call], {
      getCallByProviderCallId,
      endCall,
      speakInitialMessage,
      processEvent: vi.fn(),
    });

    let currentStreamSid: string | null = "MZ-old";
    const twilioProvider = createTwilioStreamingProvider({
      registerCallStream: (_callSid: string, streamSid: string) => {
        currentStreamSid = streamSid;
      },
      unregisterCallStream: (_callSid: string, streamSid?: string) => {
        if (!currentStreamSid) {
          return;
        }
        if (streamSid && currentStreamSid !== streamSid) {
          return;
        }
        currentStreamSid = null;
      },
      hasRegisteredStream: () => currentStreamSid !== null,
    });

    const { server, messages } = createStreamingFixture(state, twilioProvider);
    await server.start();

    const media = mediaCallbacks(server);

    media.onConnect?.("CA-stream-1", "MZ-old");
    media.onDisconnect?.("CA-stream-1", "MZ-old");
    await vi.advanceTimersByTimeAsync(1_000);
    media.onConnect?.("CA-stream-1", "MZ-new");
    media.onDisconnect?.("CA-stream-1", "MZ-old");
    await vi.advanceTimersByTimeAsync(2_100);
    expectNotCalled(endCall, speakInitialMessage);

    media.onTranscriptionReady?.("CA-stream-1", "MZ-new");
    expect(speakInitialMessage).toHaveBeenCalledExactlyOnceWith("CA-stream-1");

    media.onDisconnect?.("CA-stream-1", "MZ-new");
    media.onDisconnect?.("CA-stream-1", "MZ-new");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId);
    expect(messages).toContain(
      `[voice-call] Call finalization requested reason=stream-disconnect-grace-expired callId=${call.callId} providerCallId=CA-stream-1`,
    );
    expect(messages).toContain(
      `[voice-call] Failed to auto-end call ${call.callId}: carrier unavailable`,
    );

    await server.stop();
  });
});

describe("VoiceCallWebhookServer barge-in suppression during initial message", () => {
  it("logs transcript counts without logging transcript content", async () => {
    const state = createManager([], {
      getCallByProviderCallId: vi.fn(() => undefined),
      speakInitialMessage: vi.fn(async () => {}),
    });
    const { server, messages } = createStreamingFixture(
      state,
      createTwilioStreamingProvider({ clearTtsQueue: vi.fn() }),
    );
    await server.start();

    const transcript = `${"a".repeat(199)}\uD83D\uDE80tail`;
    const partialText = "user is saying something sensitive";
    const callbacks = mediaCallbacks(server);
    callbacks.onTranscript?.("CA-utf16", transcript, "MZ-log");
    callbacks.onPartialTranscript?.("CA-partial", partialText, "MZ-log");

    expectPrivateLogMetadata({
      messages,
      identifiers: ["CA-utf16", "CA-partial"],
      privateText: [transcript, partialText],
    });
  });

  it("applies greeting barge-in policy to outbound calls", async () => {
    const call = createCall(Date.now() - 1_000);
    call.state = "speaking";
    call.metadata = { mode: "conversation", initialMessage: "Hello from the greeting." };
    const clearTtsQueue = vi.fn<TwilioProviderTestDouble["clearTtsQueue"]>();
    const processEvent = vi.fn<CallManager["processEvent"]>(async (event) => {
      if (event.type !== "call.speech") {
        return { kind: "processed" };
      }
      call.state = "listening";
      return { kind: "final-speech", call, transcript: event.transcript, waiterResolved: false };
    });
    const state = createManager([call], {
      getCallByProviderCallId: (id: string) => (id === call.providerCallId ? call : undefined),
      getCall: (id: string) => (id === call.callId ? call : undefined),
      speakInitialMessage: vi.fn(async () => {}),
      processEvent,
    });
    const { server } = createStreamingFixture(
      state,
      createTwilioStreamingProvider({ clearTtsQueue }),
    );
    await server.start();
    const handleInboundResponse = vi.fn(async () => {});
    (
      server as unknown as {
        handleInboundResponse: (callId: string, transcript: string) => Promise<void>;
      }
    ).handleInboundResponse = handleInboundResponse;
    const media = mediaCallbacks(server);
    const transcript = "hello after greeting";
    media.onSpeechStart?.("provider-call-1", "stream");
    media.onTranscript?.("provider-call-1", "hello", "stream");
    media.onSpeechStart?.("provider-call-1", "stream");
    media.onTranscript?.("provider-call-1", "hello again", "stream");
    expectNotCalled(clearTtsQueue, handleInboundResponse, processEvent);
    delete call.metadata.initialMessage;
    call.state = "listening";
    media.onSpeechStart?.("provider-call-1", "stream");
    media.onTranscript?.("provider-call-1", transcript, "stream");
    expect(clearTtsQueue).toHaveBeenCalledTimes(2);
    expect(processEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "call.speech",
        callId: call.callId,
        providerCallId: call.providerCallId,
        transcript,
        isFinal: true,
      }),
    );
    await vi.waitFor(() =>
      expect(handleInboundResponse).toHaveBeenCalledExactlyOnceWith(call.callId, transcript),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
