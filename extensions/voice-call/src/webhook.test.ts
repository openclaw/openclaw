import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import * as webhookRequestGuards from "openclaw/plugin-sdk/webhook-request-guards";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { VoiceCallConfigSchema, resolveVoiceCallConfig, type VoiceCallConfig } from "./config.js";
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

type VoiceCallConfigInput = Parameters<typeof resolveVoiceCallConfig>[0];

const createConfig = (overrides: VoiceCallConfigInput = {}): VoiceCallConfig => {
  const config = VoiceCallConfigSchema.parse({
    ...overrides,
    serve: { ...overrides.serve, port: overrides.serve?.port || 1 },
  });
  config.serve.port = overrides.serve?.port ?? 0;
  return config;
};

const createCall = (startedAt: number): CallRecord => ({
  callId: "call-1",
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

const createManager = (calls: CallRecord[]) => {
  const endCall = vi.fn(async () => ({ success: true }));
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const manager = {
    ...automaticReplyManagerStub,
    getActiveCalls: () => calls,
    endCall,
    processEvent,
  } as unknown as CallManager;

  return { manager, endCall, processEvent };
};

function createServer(...args: ConstructorParameters<typeof VoiceCallWebhookServer>) {
  const server = new VoiceCallWebhookServer(...args);
  onTestFinished(() => server.stop());
  return server;
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
    activeStreamCalls: Set<string>;
  };
  expect(state.callStreamMap.size).toBe(0);
  expect(state.streamAuthTokens.size).toBe(0);
  expect(state.activeStreamCalls.size).toBe(0);
}

function expectPlivoCallStateReleased(
  providerLocal: PlivoProvider,
  params: { callId: string; requestUuid: string; callUuid: string },
) {
  const state = providerLocal as unknown as {
    requestUuidToCallUuid: Map<string, string>;
    callIdToWebhookUrl: Map<string, string>;
    callUuidToWebhookUrl: Map<string, string>;
    pendingSpeakByCallId: Map<string, unknown>;
    pendingListenByCallId: Map<string, unknown>;
  };
  expect(state.requestUuidToCallUuid.has(params.requestUuid)).toBe(false);
  expect(state.callIdToWebhookUrl.has(params.callId)).toBe(false);
  expect(state.callUuidToWebhookUrl.has(params.callUuid)).toBe(false);
  expect(state.pendingSpeakByCallId.has(params.callId)).toBe(false);
  expect(state.pendingListenByCallId.has(params.callId)).toBe(false);
}

async function expectTwilioReplayTwiML(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/xml");
  expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
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
  return await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: params.body,
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
    const providerName = "mock" as const;
    const call = createCall(Date.now());
    const getCallByProviderCallId = vi.fn(() => call);
    const manager = {
      ...automaticReplyManagerStub,
      getActiveCalls: () => [call],
      getCallByProviderCallId,
      endCall: vi.fn(async () => ({ success: true })),
      processEvent: vi.fn(),
      speakInitialMessage: vi.fn(async () => {}),
    } as unknown as CallManager;
    const config = createConfig({
      provider: providerName,
      streaming: {
        enabled: true,
      },
    });
    const server = createServer(config, manager, {
      ...provider,
      name: providerName,
    });

    await server.start();
    const handler = server.getMediaStreamHandler() as unknown as {
      config: {
        shouldAcceptStream?: (input: { callId: string; streamSid: string }) => boolean;
      };
    };
    const shouldAcceptStream = handler?.config.shouldAcceptStream;
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
  it.each([
    {
      name: "allowed hosts without forwarding trust",
      trust: false,
      proxies: ["127.0.0.1"],
      remote: "127.0.0.1",
      expected: "127.0.0.1",
    },
    {
      name: "untrusted remote",
      trust: true,
      proxies: ["203.0.113.10"],
      remote: "127.0.0.1",
      expected: "127.0.0.1",
    },
    {
      name: "no trusted proxies",
      trust: true,
      proxies: [],
      remote: "127.0.0.1",
      expected: "127.0.0.1",
    },
    {
      name: "mapped remote and trusted proxy chain",
      trust: true,
      proxies: ["127.0.0.1", "203.0.113.10"],
      remote: "::ffff:127.0.0.1",
      expected: "198.51.100.10",
    },
  ])("resolves client IP with $name", ({ trust, proxies, remote, expected }) => {
    const { manager } = createManager([]);
    const server = createServer(
      createConfig({
        webhookSecurity: {
          allowedHosts: ["voice.example.com"],
          trustForwardingHeaders: trust,
          trustedProxyIPs: proxies,
        },
      }),
      manager,
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
  baseUrl: string,
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
    const { manager } = createManager([]);
    const config = createConfig();
    const server = createServer(config, manager, strictProvider);

    const baseUrl = await server.start();
    const requestUrl = new URL(baseUrl);
    requestUrl.pathname = "/voice/webhook-evil";

    const response = await fetch(requestUrl.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA123&SpeechResult=hello",
    });

    expect(response.status).toBe(404);
    expect(verifyWebhook).not.toHaveBeenCalled();
    expect(parseWebhookEvent).not.toHaveBeenCalled();
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
    const { manager } = createManager([]);
    const config = createConfig();
    const server = createServer(config, manager, strictProvider);
    const readBodySpy = vi.spyOn(webhookRequestGuards, "readRequestBodyWithLimit");
    readBodySpy.mockResolvedValue("CallSid=CA123&SpeechResult=hello");
    const runWebhookPipeline = (
      server as unknown as {
        runWebhookPipeline: (
          req: IncomingMessage,
          webhookPath: string,
        ) => Promise<{ statusCode: number; body: string }>;
      }
    ).runWebhookPipeline.bind(server);

    try {
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
    } finally {
      readBodySpy.mockRestore();
    }
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
    const authToken = "signed-late-registration-token";
    const providerCallId = "CA-signed-late-registration";
    const twilioProvider = new TwilioProvider({ accountSid: "AC123", authToken });
    const registeredCalls: CallRecord[] = [];
    const { manager, processEvent } = createManager(registeredCalls);
    processEvent.mockImplementation(async (event) =>
      registeredCalls.some((call) => call.providerCallId === event.providerCallId)
        ? { kind: "processed" }
        : { kind: "ignored", replayable: true },
    );
    const server = createServer(
      createConfig({ provider: "twilio", twilio: { accountSid: "AC123", authToken } }),
      manager,
      twilioProvider,
    );

    const baseUrl = await server.start();
    twilioProvider.setPublicUrl(baseUrl);
    const signedRequest = {
      baseUrl,
      authToken,
      body: `CallSid=${providerCallId}&CallStatus=in-progress&Direction=outbound-api`,
    };

    expect((await postSignedTwilioWebhook(signedRequest)).status).toBe(200);
    registeredCalls.push({ ...createCall(Date.now()), provider: "twilio", providerCallId });
    expect((await postSignedTwilioWebhook(signedRequest)).status).toBe(200);
    expect(processEvent).toHaveBeenCalledTimes(2);
    await expectTwilioReplayTwiML(await postSignedTwilioWebhook(signedRequest));
    expect(processEvent).toHaveBeenCalledTimes(2);
  });

  it("holds a signed webhook response until event persistence finishes", async () => {
    const authToken = "signed-delayed-store-token";
    const twilioProvider = new TwilioProvider({ accountSid: "AC123", authToken });
    const { manager, processEvent } = createManager([]);
    const persistence = createDeferred<Awaited<ReturnType<CallManager["processEvent"]>>>();
    processEvent.mockReturnValueOnce(persistence.promise);
    const server = createServer(
      createConfig({ provider: "twilio", twilio: { accountSid: "AC123", authToken } }),
      manager,
      twilioProvider,
    );
    const baseUrl = await server.start();
    twilioProvider.setPublicUrl(baseUrl);
    let answered = false;
    const response = postSignedTwilioWebhook({
      baseUrl,
      authToken,
      body: "CallSid=CA-delayed-store&CallStatus=in-progress&Direction=outbound-api",
    }).then((result) => {
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
    const authToken = "signed-concurrent-token";
    const twilioProvider = new TwilioProvider(
      { accountSid: "AC123", authToken },
      { streamPath: "/voice/stream/realtime" },
    );
    const verification = vi.spyOn(twilioProvider, "verifyWebhook");
    const { manager, processEvent } = createManager([]);
    const server = createServer(
      createConfig({
        provider: "twilio",
        inboundPolicy: "open",
        twilio: { accountSid: "AC123", authToken },
        realtime: { enabled: true },
      }),
      manager,
      twilioProvider,
    );
    let response = createDeferred<ReturnType<RealtimeCallHandler["buildTwiMLPayload"]>>();
    const buildTwiMLPayload = vi.fn(
      () => response.promise as unknown as ReturnType<RealtimeCallHandler["buildTwiMLPayload"]>,
    );
    server.setRealtimeHandler(createRealtimeHandler(buildTwiMLPayload));
    const baseUrl = await server.start();
    twilioProvider.setPublicUrl(baseUrl);
    const signedRequest = {
      baseUrl,
      authToken,
      body: "CallSid=CA-concurrent&Direction=inbound&CallStatus=ringing",
    };
    const sendPair = async (attempt: number) => {
      const owner = postSignedTwilioWebhook(signedRequest);
      await vi.waitFor(() => expect(buildTwiMLPayload).toHaveBeenCalledTimes(attempt));
      const duplicate = postSignedTwilioWebhook(signedRequest);
      let duplicateSettled = false;
      void duplicate.then(() => {
        duplicateSettled = true;
      });
      await vi.waitFor(() => expect(verification).toHaveBeenCalledTimes(attempt * 2));
      expect(duplicateSettled).toBe(false);
      return { owner, duplicate };
    };
    try {
      const failed = await sendPair(1);
      response.reject(new Error("synthetic realtime setup failure"));
      expect(
        (await Promise.all([failed.owner, failed.duplicate])).map((reply) => reply.status),
      ).toEqual([500, 500]);
      response = createDeferred<ReturnType<RealtimeCallHandler["buildTwiMLPayload"]>>();
      const retry = await sendPair(2);
      response.resolve({
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: '<Response><Connect><Stream url="wss://example.test/one-time-secret" /></Connect></Response>',
      });
      expect(await (await retry.owner).text()).toContain("one-time-secret");
      await expectTwilioReplayTwiML(await retry.duplicate);
      await expectTwilioReplayTwiML(await postSignedTwilioWebhook(signedRequest));
      expect(buildTwiMLPayload).toHaveBeenCalledTimes(2);
      expect(processEvent).not.toHaveBeenCalled();
      expectNoTwilioStreamState(twilioProvider);
    } finally {
      verification.mockRestore();
      await server.stop();
    }
  });

  it("releases Plivo provider state through a terminal webhook before replay ack", async () => {
    const callId = "call-webhook-terminal-plivo";
    const requestUuid = "request-webhook-terminal-plivo";
    const callUuid = "call-uuid-webhook-terminal-plivo";
    const plivoProvider = new PlivoProvider(
      {
        authId: "MA000000000000000000",
        authToken: "test-token",
      },
      { skipVerification: true },
    );
    const state = plivoProvider as unknown as {
      requestUuidToCallUuid: Map<string, string>;
      callIdToWebhookUrl: Map<string, string>;
      callUuidToWebhookUrl: Map<string, string>;
      pendingSpeakByCallId: Map<string, unknown>;
      pendingListenByCallId: Map<string, unknown>;
    };
    state.requestUuidToCallUuid.set(requestUuid, callUuid);
    state.callIdToWebhookUrl.set(callId, "https://example.test/voice/webhook");
    state.callUuidToWebhookUrl.set(callUuid, "https://example.test/voice/webhook");
    state.pendingSpeakByCallId.set(callId, { text: "Hello" });
    state.pendingListenByCallId.set(callId, { language: "en-US" });

    const parseWebhookEvent = vi.spyOn(plivoProvider, "parseWebhookEvent");
    const { manager, processEvent } = createManager([]);
    const config = createConfig({
      provider: "plivo",
      skipSignatureVerification: true,
      plivo: {
        authId: "MA000000000000000000",
        authToken: "test-token",
      },
    });
    const server = createServer(config, manager, plivoProvider);

    try {
      const baseUrl = await server.start();
      const requestUrl = new URL(baseUrl);
      requestUrl.searchParams.set("provider", "plivo");
      requestUrl.searchParams.set("flow", "hangup");
      requestUrl.searchParams.set("callId", callId);
      const body = `CallUUID=${callUuid}&RequestUUID=${requestUuid}&CallStatus=completed&Direction=outbound`;

      const first = await fetch(requestUrl.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(first.status).toBe(200);
      expect(await first.text()).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      );
      expectPlivoCallStateReleased(plivoProvider, { callId, requestUuid, callUuid });
      expect(parseWebhookEvent).toHaveBeenCalledTimes(1);
      expect(processEvent).toHaveBeenCalledTimes(1);

      const replay = await fetch(requestUrl.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(replay.status).toBe(200);
      expect(await replay.text()).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      );
      expectPlivoCallStateReleased(plivoProvider, { callId, requestUuid, callUuid });
      expect(parseWebhookEvent).toHaveBeenCalledTimes(1);
      expect(processEvent).toHaveBeenCalledTimes(1);
    } finally {
      parseWebhookEvent.mockRestore();
      await server.stop();
    }
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

  it("does not cache replay responses when the TTL would exceed the Date range", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    let parseCount = 0;
    const parseWebhookEvent = vi.fn(() => ({
      events: [],
      statusCode: 200,
      providerResponseBody: `OK-${++parseCount}`,
    }));
    const replayProvider: VoiceCallProvider = {
      ...provider,
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "mock:req:overflow-cache" }),
      parseWebhookEvent,
    };
    const { manager } = createManager([]);
    const config = createConfig();
    const server = createServer(config, manager, replayProvider);

    try {
      const baseUrl = await server.start();
      const first = await postWebhookForm(baseUrl, "CallSid=CA123&SpeechResult=hello");
      expect(first.status).toBe(200);
      expect(await first.text()).toBe("OK-1");

      dateNow.mockReturnValue(Date.parse("2026-05-29T12:00:00.000Z"));
      const second = await postWebhookForm(baseUrl, "CallSid=CA123&SpeechResult=hello");
      expect(second.status).toBe(200);
      expect(await second.text()).toBe("OK-2");
      expect(parseWebhookEvent).toHaveBeenCalledTimes(2);
    } finally {
      dateNow.mockRestore();
      await server.stop();
    }
  });

  it("returns Plivo XML for replayed answer callbacks while skipping event side effects", async () => {
    const authToken = "signed-plivo-replay-token";
    const nonce = "signed-plivo-replay-nonce";
    const publicUrl = "https://example.test/voice/webhook";
    const plivoProvider = new PlivoProvider(
      {
        authId: "MA000000000000000000",
        authToken,
      },
      { publicUrl },
    );
    const parseWebhookEvent = vi.spyOn(plivoProvider, "parseWebhookEvent");
    const { manager, processEvent } = createManager([]);
    const config = createConfig({
      provider: "plivo",
      skipSignatureVerification: false,
      serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" },
      staleCallReaperSeconds: 0,
      plivo: {
        authId: "MA000000000000000000",
        authToken,
      },
    });
    const server = createServer(config, manager, plivoProvider);

    try {
      const baseUrl = await server.start();
      const requestUrl = new URL(baseUrl);
      requestUrl.searchParams.set("provider", "plivo");
      requestUrl.searchParams.set("flow", "answer");
      requestUrl.searchParams.set("callId", "internal-call-id");
      requestUrl.searchParams.append("tag", "z");
      requestUrl.searchParams.append("tag", "a");
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
        fetch(requestUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-plivo-signature-v3": signature,
            "x-plivo-signature-v3-nonce": nonce,
          },
          body: rawBody,
        });

      const rejected = await postCallback(body, "invalid");
      expect(rejected.status).toBe(401);
      expect(await rejected.text()).toBe("Unauthorized");
      expect(parseWebhookEvent).not.toHaveBeenCalled();
      expect(processEvent).not.toHaveBeenCalled();

      processEvent.mockRejectedValueOnce(new Error("synthetic SQLite persistence failure"));
      expect((await postCallback(body, signatureFor("a"))).status).toBe(500);
      processEvent.mockClear();
      parseWebhookEvent.mockClear();
      const first = await postCallback(body, signatureFor("a"));
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toContain("text/xml");
      const expectedBody = await first.text();
      expect(expectedBody).toContain("<Wait");
      expect(parseWebhookEvent).toHaveBeenCalledTimes(1);
      expect(processEvent).toHaveBeenCalledTimes(1);
      const firstKey = processEvent.mock.calls[0]?.[0].dedupeKey;
      expect(firstKey).toBe(expectedKeyFor("a"));
      expect(parseWebhookEvent.mock.calls[0]?.[1]).toEqual({
        verifiedRequestKey: expectedKeyFor("a"),
      });

      parseWebhookEvent.mockClear();
      processEvent.mockClear();

      requestUrl.search = "?tag=a&callId=internal-call-id&tag=z&flow=answer&provider=plivo";
      const replay = await postCallback(body.split("&").toReversed().join("&"), signatureFor("a"));

      expect(replay.status).toBe(200);
      expect(replay.headers.get("content-type")).toContain("text/xml");
      const replayBody = await replay.text();
      expect(replayBody).toContain("<Wait");
      expect(replayBody).toBe(expectedBody);
      expect(parseWebhookEvent).not.toHaveBeenCalled();
      expect(processEvent).not.toHaveBeenCalled();

      const changed = await postCallback(body.replace("Tag=a", "Tag=b"), signatureFor("b"));
      expect(changed.status).toBe(200);
      expect(await changed.text()).toBe(expectedBody);
      expect(parseWebhookEvent).toHaveBeenCalledTimes(1);
      expect(processEvent).toHaveBeenCalledTimes(1);
      const changedKey = processEvent.mock.calls[0]?.[0].dedupeKey;
      expect(changedKey).toBe(expectedKeyFor("b"));
      expect(parseWebhookEvent.mock.calls[0]?.[1]).toEqual({
        verifiedRequestKey: expectedKeyFor("b"),
      });
      expect(changedKey).not.toBe(firstKey);
    } finally {
      parseWebhookEvent.mockRestore();
      await server.stop();
    }
  });

  it("consumes initial outbound TwiML before redirecting into realtime", async () => {
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const consumeInitialTwiML = vi
      .fn<NonNullable<VoiceCallProvider["consumeInitialTwiML"]>>()
      .mockReturnValueOnce(
        '<Response><Play digits="ww123456#" /><Redirect method="POST">https://example.test</Redirect></Response>',
      );
    const buildTwiMLPayload = vi.fn(() => ({
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: '<Response><Connect><Stream url="wss://example.test/voice/stream/realtime/token" /></Connect></Response>',
    }));
    const twilioProvider: VoiceCallProvider = {
      ...provider,
      name: "twilio",
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:rt-stored" }),
      parseWebhookEvent,
      consumeInitialTwiML,
    };
    const { manager, processEvent } = createManager([]);
    const config = createConfig({
      provider: "twilio",
      inboundPolicy: "disabled",
      realtime: {
        enabled: true,
      },
    });
    const server = createServer(config, manager, twilioProvider);
    server.setRealtimeHandler(createRealtimeHandler(buildTwiMLPayload));

    const baseUrl = await server.start();
    const requestUrl = new URL(baseUrl);
    requestUrl.searchParams.set("callId", "call-1");
    const response = await fetch(requestUrl.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "sig",
      },
      body: "CallSid=CA123&Direction=outbound-api&CallStatus=in-progress&From=%2B15550001111&To=%2B15550002222",
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('<Play digits="ww123456#"');
    expect(consumeInitialTwiML).toHaveBeenCalledTimes(1);
    expect(buildTwiMLPayload).not.toHaveBeenCalled();
    expect(parseWebhookEvent).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
    const redirect = await postWebhookForm(
      baseUrl,
      "CallSid=CA123&Direction=outbound-api&CallStatus=in-progress",
      { "x-twilio-signature": "sig" },
    );
    expect(redirect.status).toBe(200);
    expect(await redirect.text()).toContain("<Connect><Stream");
    expect(consumeInitialTwiML).toHaveBeenCalledTimes(2);
    expect(buildTwiMLPayload).toHaveBeenCalledOnce();
    expect(parseWebhookEvent).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it("creates realtime stream tokens only for allowlisted callers", async () => {
    const buildTwiMLPayload = vi.fn(() => ({
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: '<Response><Connect><Stream url="wss://example.test/token" /></Connect></Response>',
    }));
    const twilioProvider = createTwilioVerificationProvider({
      verifyWebhook: (ctx) => ({ ok: true, verifiedRequestKey: ctx.rawBody }),
    });
    const { manager } = createManager([]);
    const server = createServer(
      createConfig({
        provider: "twilio",
        inboundPolicy: "allowlist",
        allowFrom: ["+15550001111"],
        realtime: { enabled: true },
      }),
      manager,
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
    const { manager } = createManager([]);
    const config = createConfig();
    const server = createServer(config, manager, badProvider);

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
    const { manager } = createManager([]);
    const config = createConfig({ provider: "twilio" });
    const server = createServer(config, manager, twilioProvider);
    const readBodySpy = vi.spyOn(webhookRequestGuards, "readRequestBodyWithLimit");

    try {
      const baseUrl = await server.start();
      const response = await postWebhookForm(baseUrl, "CallSid=CA123&SpeechResult=hello");

      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
      expect(readBodySpy).not.toHaveBeenCalled();
      expect(verifyWebhook).not.toHaveBeenCalled();
    } finally {
      readBodySpy.mockRestore();
      await server.stop();
    }
  });

  it("limits concurrent pre-auth requests per source IP", async () => {
    const twilioProvider: VoiceCallProvider = {
      ...provider,
      name: "twilio",
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:test" }),
    };
    const { manager } = createManager([]);
    const config = createConfig({ provider: "twilio" });
    const server = createServer(config, manager, twilioProvider);

    let enteredReads = 0;
    const enteredEightReads = createDeferred<void>();
    const unblockReads = createDeferred<void>();
    const readBodySpy = vi.spyOn(webhookRequestGuards, "readRequestBodyWithLimit");
    readBodySpy.mockImplementation(async () => {
      enteredReads += 1;
      if (enteredReads === 8) {
        enteredEightReads.resolve();
      }
      if (enteredReads <= 8) {
        await unblockReads.promise;
      }
      return "CallSid=CA123&SpeechResult=hello";
    });

    try {
      const baseUrl = await server.start();
      const headers = { "x-twilio-signature": "sig" };
      const inFlightRequests = Array.from({ length: 8 }, () =>
        postWebhookForm(baseUrl, "CallSid=CA123", headers),
      );
      await enteredEightReads.promise;

      const rejected = await postWebhookForm(baseUrl, "CallSid=CA999", headers);
      expect(rejected.status).toBe(429);
      expect(await rejected.text()).toBe("Too Many Requests");
      expect(readBodySpy).toHaveBeenCalledTimes(8);

      unblockReads.resolve();

      const settled = await Promise.all(inFlightRequests);
      expect(settled.map((response) => response.status)).toEqual(Array(8).fill(200));
    } finally {
      unblockReads.resolve();
      readBodySpy.mockRestore();
      await server.stop();
    }
  });

  it("limits missing remote addresses with a shared fallback bucket", async () => {
    const twilioProvider: VoiceCallProvider = {
      ...provider,
      name: "twilio",
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:test" }),
    };
    const { manager } = createManager([]);
    const config = createConfig({ provider: "twilio" });
    const server = createServer(config, manager, twilioProvider);
    const runWebhookPipeline = (
      server as unknown as {
        runWebhookPipeline: (
          req: IncomingMessage,
          webhookPath: string,
        ) => Promise<{ statusCode: number; body: string }>;
      }
    ).runWebhookPipeline.bind(server);

    let enteredReads = 0;
    const enteredEightReads = createDeferred<void>();
    const unblockReads = createDeferred<void>();
    const readBodySpy = vi.spyOn(webhookRequestGuards, "readRequestBodyWithLimit");
    readBodySpy.mockImplementation(async () => {
      enteredReads += 1;
      if (enteredReads === 8) {
        enteredEightReads.resolve();
      }
      await unblockReads.promise;
      return "CallSid=CA123&SpeechResult=hello";
    });

    const makeRequestWithoutRemoteAddress = () =>
      ({
        method: "POST",
        url: "/voice/webhook",
        headers: { "x-twilio-signature": "sig" },
        socket: { remoteAddress: undefined },
      }) as unknown as IncomingMessage;

    try {
      const inFlightRequests = Array.from({ length: 8 }, () =>
        runWebhookPipeline(makeRequestWithoutRemoteAddress(), "/voice/webhook"),
      );
      await enteredEightReads.promise;

      const rejected = await runWebhookPipeline(
        makeRequestWithoutRemoteAddress(),
        "/voice/webhook",
      );
      expect(rejected.statusCode).toBe(429);
      expect(rejected.body).toBe("Too Many Requests");
      expect(readBodySpy).toHaveBeenCalledTimes(8);

      unblockReads.resolve();

      const settled = await Promise.all(inFlightRequests);
      expect(settled.map((response) => response.statusCode)).toEqual(Array(8).fill(200));
    } finally {
      unblockReads.resolve();
      readBodySpy.mockRestore();
    }
  });
});

describe("VoiceCallWebhookServer classic response routing", () => {
  function responseFixture(
    call: CallRecord,
    config = createConfig({ agentId: "main" }),
    logger?: ConstructorParameters<typeof VoiceCallWebhookServer>[6],
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
    call.direction = "outbound";
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

    const params = expectDefined<unknown[]>(
      mocks.generateVoiceResponse.mock.calls.at(0),
      "classic voice response",
    )[0] as
      | { agentId?: string; senderIsOwner?: boolean; voiceConfig?: VoiceCallConfig }
      | undefined;
    expect(params?.voiceConfig?.agentId).toBe("top");
    expect(params?.agentId).toBe("support");
    expect(params).toHaveProperty("senderIsOwner", undefined);
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
    const { manager } = createManager([]);
    const server = createServer(createConfig(), manager, provider);
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

    const manager = {
      ...automaticReplyManagerStub,
      getActiveCalls: () => [call],
      getCallByProviderCallId,
      endCall,
      speakInitialMessage,
      processEvent: vi.fn(),
    } as unknown as CallManager;

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

    const config = createConfig({
      provider: "twilio",
      streaming: {
        enabled: true,
      },
    });
    const { logger, messages } = createCapturingLogger();
    const server = createServer(
      config,
      manager,
      twilioProvider,
      undefined,
      undefined,
      undefined,
      logger,
    );
    await server.start();

    const mediaHandler = server.getMediaStreamHandler() as unknown as {
      config: {
        onDisconnect?: (providerCallId: string, streamSid: string) => void;
        onConnect?: (providerCallId: string, streamSid: string) => void;
        onTranscriptionReady?: (providerCallId: string, streamSid: string) => void;
      };
    };
    if (!mediaHandler) {
      throw new Error("expected webhook server to expose a media stream handler");
    }

    mediaHandler.config.onConnect?.("CA-stream-1", "MZ-old");
    mediaHandler.config.onDisconnect?.("CA-stream-1", "MZ-old");
    await vi.advanceTimersByTimeAsync(1_000);
    mediaHandler.config.onConnect?.("CA-stream-1", "MZ-new");
    mediaHandler.config.onDisconnect?.("CA-stream-1", "MZ-old");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(endCall).not.toHaveBeenCalled();
    expect(speakInitialMessage).not.toHaveBeenCalled();

    mediaHandler.config.onTranscriptionReady?.("CA-stream-1", "MZ-new");
    expect(speakInitialMessage).toHaveBeenCalledTimes(1);
    expect(speakInitialMessage).toHaveBeenCalledWith("CA-stream-1");

    mediaHandler.config.onDisconnect?.("CA-stream-1", "MZ-new");
    mediaHandler.config.onDisconnect?.("CA-stream-1", "MZ-new");
    await vi.advanceTimersByTimeAsync(2_100);
    expect(endCall).toHaveBeenCalledTimes(1);
    expect(endCall).toHaveBeenCalledWith(call.callId);
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
  const createTwilioProvider = (
    clearTtsQueue: ReturnType<typeof vi.fn<TwilioProviderTestDouble["clearTtsQueue"]>>,
  ) =>
    createTwilioStreamingProvider({
      clearTtsQueue,
    });

  const getMediaCallbacks = (server: VoiceCallWebhookServer) =>
    server.getMediaStreamHandler() as unknown as {
      config: MediaStreamConfig;
    };

  it("logs transcript counts without logging transcript content", async () => {
    const manager = {
      ...automaticReplyManagerStub,
      getActiveCalls: () => [],
      getCallByProviderCallId: vi.fn(() => undefined),
      endCall: vi.fn(async () => ({ success: true })),
      speakInitialMessage: vi.fn(async () => {}),
      processEvent: vi.fn(),
    } as unknown as CallManager;
    const config = createConfig({
      provider: "twilio",
      streaming: {
        enabled: true,
      },
    });

    const { logger, messages } = createCapturingLogger();

    const server = createServer(
      config,
      manager,
      createTwilioProvider(vi.fn()),
      undefined,
      undefined,
      undefined,
      logger,
    );
    await server.start();

    const transcript = `${"a".repeat(199)}\uD83D\uDE80tail`;
    const partialText = "user is saying something sensitive";
    const callbacks = getMediaCallbacks(server).config;
    callbacks.onTranscript?.("CA-utf16", transcript, "MZ-log");
    callbacks.onPartialTranscript?.("CA-partial", partialText, "MZ-log");

    expectPrivateLogMetadata({
      messages,
      identifiers: ["CA-utf16", "CA-partial"],
      privateText: [transcript, partialText],
    });
  });

  it.each(["outbound", "inbound"] as const)(
    "applies greeting barge-in policy to %s calls",
    async (direction) => {
      const call = createCall(Date.now() - 1_000);
      call.direction = direction;
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
      const manager = {
        ...automaticReplyManagerStub,
        getActiveCalls: () => [call],
        endCall: vi.fn(async () => ({ success: true })),
        getCallByProviderCallId: (id: string) => (id === call.providerCallId ? call : undefined),
        getCall: (id: string) => (id === call.callId ? call : undefined),
        speakInitialMessage: vi.fn(async () => {}),
        processEvent,
      } as unknown as CallManager;
      const server = createServer(
        createConfig({ provider: "twilio", streaming: { enabled: true } }),
        manager,
        createTwilioProvider(clearTtsQueue),
      );
      await server.start();
      const handleInboundResponse = vi.fn(async () => {});
      (
        server as unknown as {
          handleInboundResponse: (callId: string, transcript: string) => Promise<void>;
        }
      ).handleInboundResponse = handleInboundResponse;
      const media = getMediaCallbacks(server).config;
      const transcript = "hello after greeting";
      if (direction === "outbound") {
        media.onSpeechStart?.("provider-call-1", "stream");
        media.onTranscript?.("provider-call-1", "hello", "stream");
        media.onSpeechStart?.("provider-call-1", "stream");
        media.onTranscript?.("provider-call-1", "hello again", "stream");
        expect(clearTtsQueue).not.toHaveBeenCalled();
        expect(handleInboundResponse).not.toHaveBeenCalled();
        expect(processEvent).not.toHaveBeenCalled();
        delete call.metadata.initialMessage;
        call.state = "listening";
      }
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
    },
  );
});
describe("VoiceCallWebhookServer webhook event auto-response", () => {
  it("auto-responds to an inbound webhook transcript without conversation mode", async () => {
    const providerCallId = "v3:webhook-inbound";
    const call: CallRecord = {
      ...createCall(Date.now()),
      providerCallId,
      provider: "telnyx",
      direction: "inbound",
      state: "listening",
    };
    const transcript = "Hello from the inbound caller";
    const { manager, processEvent } = createManager([call]);
    processEvent.mockResolvedValue({
      kind: "final-speech",
      call,
      transcript,
      waiterResolved: false,
    });
    const telnyxProvider: VoiceCallProvider = {
      ...provider,
      name: "telnyx",
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "telnyx:req:inbound" }),
      parseWebhookEvent: () => ({
        events: [
          {
            id: "event-inbound",
            type: "call.speech",
            callId: providerCallId,
            providerCallId,
            timestamp: Date.now(),
            transcript,
            isFinal: true,
          },
        ],
        statusCode: 200,
      }),
    };
    const server = createServer(
      createConfig({ skipSignatureVerification: true }),
      manager,
      telnyxProvider,
    );
    const handleInboundResponse = vi.fn(async () => {});
    (
      server as unknown as {
        handleInboundResponse: (callId: string, transcript: string) => Promise<void>;
      }
    ).handleInboundResponse = handleInboundResponse;

    const response = await postWebhookForm(await server.start(), "stub=1");

    expect(response.status).toBe(200);
    expect(processEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "call.speech",
        transcript,
        isFinal: true,
      }),
    );
    expect(handleInboundResponse).toHaveBeenCalledExactlyOnceWith(call.callId, transcript);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
