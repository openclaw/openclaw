import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import * as webhookRequestGuards from "openclaw/plugin-sdk/webhook-request-guards";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { normalizeVoiceCallConfig } from "./config.js";
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

type ResponseParams = { onEarlyText?: (text: string) => Promise<boolean> };
type ResponseResult = { text: string | null; deliveredEarly: boolean };
type ConfigInput = Record<string, unknown>;
type StreamProvider = VoiceCallProvider &
  Pick<TwilioProvider, "hasRegisteredStream" | "clearTtsQueue">;
const mocks = vi.hoisted(() => {
  const stt: RealtimeTranscriptionProviderPlugin = {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createSession: () => ({
      connect: async () => {},
      sendAudio: () => {},
      close: () => {},
      isConnected: () => true,
    }),
  };
  return { generate: vi.fn<(params?: ResponseParams) => Promise<ResponseResult>>(), stt };
});
// mock-isolation: Use the fixture provider without live transcription discovery or sessions.
vi.mock("./realtime-transcription.runtime.js", () => ({
  getRealtimeTranscriptionProvider: () => mocks.stt,
  listRealtimeTranscriptionProviders: () => [mocks.stt],
}));
// mock-isolation: Exercise webhook delivery without running a real agent response.
vi.mock("./response-generator.js", () => ({ generateVoiceResponse: mocks.generate }));
beforeEach(() =>
  onTestFinished(() => {
    vi.restoreAllMocks();
  }),
);

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
const speechBody = "CallSid=CA123&SpeechResult=hello";
const twilioHeaders = { "x-twilio-signature": "sig" };
const streamConfig = { provider: "twilio", streaming: { enabled: true } };
const emptyTwiML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const callRecord = (overrides: Partial<CallRecord> = {}): CallRecord => ({
  callId: "call-1",
  agentId: "main",
  providerCallId: "provider-call-1",
  provider: "mock",
  direction: "outbound",
  state: "initiated",
  from: "+15550001234",
  to: "+15550005678",
  startedAt: Date.now(),
  transcript: [],
  processedEventIds: [],
  ...overrides,
});
function fixture(
  input: ConfigInput = {},
  testProvider = provider,
  calls: CallRecord[] = [],
  overrides: Partial<CallManager> = {},
  withAgent = false,
) {
  const endCall = vi.fn<CallManager["endCall"]>(async () => ({ success: true }));
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const manager = {
    getActiveCalls: () => calls,
    endCall,
    processEvent,
    createAutoResponseGuard: () => ({ isCurrent: () => true, release: () => {} }),
    invalidateAutoResponse: () => {},
    ...overrides,
  } as unknown as CallManager;
  const messages: string[] = [];
  const capture = (message: string) => void messages.push(message);
  const config = normalizeVoiceCallConfig(input);
  config.serve.port = 0;
  const server = new VoiceCallWebhookServer(
    createTestPluginServiceScheduler(),
    config,
    manager,
    testProvider,
    withAgent ? {} : undefined,
    withAgent ? ({} as never) : undefined,
    { info: capture, warn: capture, error: capture },
  );
  onTestFinished(() => server.stop());
  return {
    server,
    endCall,
    processEvent,
    messages,
    post: async (body = speechBody, headers: Record<string, string> = {}) =>
      post(await server.start(), body, headers),
  };
}
function realtime(
  server: VoiceCallWebhookServer,
  buildTwiMLPayload: RealtimeCallHandler["buildTwiMLPayload"],
  close = async () => {},
) {
  server.setRealtimeHandler({
    buildTwiMLPayload,
    close,
    getStreamPathPattern: () => "/voice/stream/realtime",
  } as unknown as RealtimeCallHandler);
}
function streamingProvider(overrides: Partial<StreamProvider> = {}): StreamProvider {
  return {
    ...provider,
    name: "twilio",
    verifyWebhook: () => ({ ok: true, verifiedRequestKey: "twilio:req:test" }),
    hasRegisteredStream: () => true,
    clearTtsQueue: () => {},
    ...overrides,
  };
}
function internals(server: VoiceCallWebhookServer) {
  return server as unknown as {
    runWebhookPipeline: (
      req: IncomingMessage,
      path: string,
    ) => Promise<{ statusCode: number; body: string }>;
    handleInboundResponse: (callId: string, message: string) => Promise<void>;
    resolveMediaStreamClientIp: (request: {
      headers: Record<string, string>;
      socket: { remoteAddress?: string };
    }) => string | undefined;
  };
}
function runPipeline(
  server: VoiceCallWebhookServer,
  url = "/voice/webhook",
  headers: Record<string, string> = twilioHeaders,
  remoteAddress?: string,
) {
  return internals(server).runWebhookPipeline(
    { method: "POST", url, headers, socket: { remoteAddress } } as unknown as IncomingMessage,
    "/voice/webhook",
  );
}
function fakeTime() {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
}
const media = (server: VoiceCallWebhookServer) =>
  (server.getMediaStreamHandler() as unknown as { config: MediaStreamConfig }).config;
const streamResponse = (token = "token") => ({
  statusCode: 200,
  headers: { "Content-Type": "text/xml" },
  body: `<Response><Connect><Stream url="wss://example.test/${token}" /></Connect></Response>`,
});
const post = (url: string | URL, body: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
async function reply(response: Response | Promise<Response>, status = 200) {
  const result = await response;
  expect(result.status).toBe(status);
  return result.text();
}
async function xml(response: Response | Promise<Response>) {
  const result = await response;
  expect(result.headers.get("content-type")).toContain("text/xml");
  return reply(result);
}
function notCalled(...spies: unknown[]) {
  for (const spy of spies) {
    expect(spy).not.toHaveBeenCalled();
  }
}
function privateLogs(messages: string[], identifiers: string[], texts: string[]) {
  const output = messages.join(" ");
  expect(output).toContain("[voice-call]");
  expect(output).toContain("chars=");
  for (const id of identifiers) {
    expect(output).toContain(id);
  }
  for (const text of texts) {
    expect(output).not.toContain(text);
  }
}
function signedTwilio(
  token: string,
  calls: CallRecord[] = [],
  input: ConfigInput = {},
  streamPath?: string,
) {
  const twilio = { accountSid: "AC123", authToken: token };
  const carrier = new TwilioProvider(twilio, streamPath ? { streamPath } : undefined);
  const state = fixture({ ...input, provider: "twilio", twilio }, carrier, calls);
  return {
    ...state,
    carrier,
    start: async (body: string) => {
      const url = await state.server.start();
      carrier.setPublicUrl(url);
      let material = new URL(url).toString();
      for (const [key, value] of [...new URLSearchParams(body)].toSorted(([a], [b]) =>
        a.localeCompare(b),
      )) {
        material += key + value;
      }
      const signature = crypto.createHmac("sha1", token).update(material).digest("base64");
      return () => post(url, body, { "x-twilio-signature": signature });
    },
  };
}

it("rejects non-Twilio media before looking up the call", async () => {
  const call = callRecord();
  const getCallByProviderCallId = vi.fn(() => call);
  const { server } = fixture({ streaming: { enabled: true } }, provider, [call], {
    getCallByProviderCallId,
  });
  await server.start();
  expect(
    media(server).shouldAcceptStream!({ callId: call.providerCallId!, streamSid: "stream-1" }),
  ).toBe(false);
  notCalled(getCallByProviderCallId);
});

it.each<[boolean, string[], string, string]>([
  [false, ["127.0.0.1"], "127.0.0.1", "127.0.0.1"],
  [true, ["203.0.113.10"], "127.0.0.1", "127.0.0.1"],
  [true, ["127.0.0.1", "203.0.113.10"], "::ffff:127.0.0.1", "198.51.100.10"],
])(
  "resolves media client IP (forwarding=%s, proxies=%s, remote=%s)",
  (trustForwardingHeaders, trustedProxyIPs, remoteAddress, expected) => {
    const { server } = fixture(
      {
        webhookSecurity: {
          allowedHosts: ["voice.example.com"],
          trustForwardingHeaders,
          trustedProxyIPs,
        },
      },
      streamingProvider(),
    );
    expect(
      internals(server).resolveMediaStreamClientIp({
        headers: {
          "x-forwarded-for": "192.0.2.99, 198.51.100.10, 203.0.113.10",
          "x-real-ip": "198.51.100.11",
        },
        socket: { remoteAddress },
      }),
    ).toBe(expected);
  },
);

it("preserves answered calls and drains hangups alongside handler shutdown", async () => {
  fakeTime();
  const hangup = createDeferred<{ success: boolean }>();
  const closed = createDeferred<void>();
  const close = vi.fn(() => closed.promise);
  const stale = callRecord({ startedAt: Date.now() - 60_000 });
  const { server, endCall } = fixture({ staleCallReaperSeconds: 1 }, provider, [
    stale,
    callRecord({
      callId: "answered",
      state: "answered",
      answeredAt: Date.now() - 90_000,
      startedAt: Date.now() - 90_000,
    }),
  ]);
  endCall.mockImplementation(() => hangup.promise);
  realtime(server, vi.fn(), close);
  let stopped = false;
  try {
    await server.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(endCall).toHaveBeenCalledExactlyOnceWith(stale.callId);
    const stopping = server.stop();
    void stopping.then(() => {
      stopped = true;
    });
    closed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    hangup.resolve({ success: true });
    await stopping;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(endCall).toHaveBeenCalledOnce();
  } finally {
    closed.resolve();
    hangup.resolve({ success: true });
    await server.stop();
  }
  expect(stopped).toBe(true);
});
it("ignores old disconnects after reconnect and hangs up only the current stream", async () => {
  fakeTime();
  const call = callRecord({ providerCallId: "CA-stream-1", startedAt: Date.now() - 1_000 });
  const carrier = new TwilioProvider({ accountSid: "AC123", authToken: "stream-test" });
  const speakInitialMessage = vi.fn(async () => {});
  const { server, endCall, messages } = fixture(streamConfig, carrier, [call], {
    getCallByProviderCallId: (id) => (id === call.providerCallId ? call : undefined),
    speakInitialMessage,
  });
  endCall.mockResolvedValue({ success: false, error: "carrier unavailable" });
  await server.start();
  const callbacks = media(server);
  callbacks.onConnect?.("CA-stream-1", "MZ-old");
  callbacks.onDisconnect?.("CA-stream-1", "MZ-old");
  await vi.advanceTimersByTimeAsync(1_000);
  callbacks.onConnect?.("CA-stream-1", "MZ-new");
  callbacks.onDisconnect?.("CA-stream-1", "MZ-old");
  await vi.advanceTimersByTimeAsync(2_100);
  notCalled(endCall, speakInitialMessage);
  callbacks.onTranscriptionReady?.("CA-stream-1", "MZ-new");
  expect(speakInitialMessage).toHaveBeenCalledExactlyOnceWith("CA-stream-1");
  callbacks.onDisconnect?.("CA-stream-1", "MZ-new");
  callbacks.onDisconnect?.("CA-stream-1", "MZ-new");
  await vi.advanceTimersByTimeAsync(2_100);
  expect(endCall).toHaveBeenCalledExactlyOnceWith(call.callId);
  expect(messages.join(" ")).toContain("carrier unavailable");
  await server.stop();
});

it.each([
  ["lookalike path", "/voice/webhook-evil", "mock", true, 404, 0],
  ["missing signature", "/voice/webhook", "twilio", true, 401, 0],
  ["missing verified identity", "/voice/webhook", "mock", false, 401, 1],
] as const)(
  "rejects %s before parsing",
  async (_name, path, name, hasKey, status, verifications) => {
    const verifyWebhook = vi.fn(() => ({
      ok: true,
      ...(hasKey ? { verifiedRequestKey: "verified:key" } : {}),
    }));
    const parseWebhookEvent = vi.fn(() => ({ events: [] }));
    const read = vi.spyOn(webhookRequestGuards, "readRequestBodyWithLimit");
    const { server } = fixture({}, { ...provider, name, verifyWebhook, parseWebhookEvent });
    const url = new URL(await server.start());
    url.pathname = path;
    expect(await reply(post(url, speechBody), status)).toBe(
      status === 404 ? "Not Found" : "Unauthorized",
    );
    expect(verifyWebhook).toHaveBeenCalledTimes(verifications);
    expect(read).toHaveBeenCalledTimes(verifications);
    notCalled(parseWebhookEvent);
  },
);

it("ignores a malformed Host when matching the webhook and constructing its context", async () => {
  const verifyWebhook = vi.fn((ctx) => {
    expect(ctx.url).toBe("http://localhost/voice/webhook?type=status");
    expect(ctx.query).toEqual({ type: "status" });
    return { ok: true, verifiedRequestKey: "verified:host" };
  });
  const parseWebhookEvent = vi.fn(() => ({ events: [] }));
  const { server } = fixture({}, { ...provider, verifyWebhook, parseWebhookEvent });
  vi.spyOn(webhookRequestGuards, "readRequestBodyWithLimit").mockResolvedValue(speechBody);
  expect(
    await runPipeline(server, "/voice/webhook?type=status", { host: "[" }, "127.0.0.1"),
  ).toMatchObject({ statusCode: 200 });
  expect(verifyWebhook).toHaveBeenCalledOnce();
  expect(parseWebhookEvent).toHaveBeenCalledOnce();
});

it("never lets a stale owner release a newer same-key replay reservation", () => {
  const cache = createWebhookReplayCache();
  const reserve = () => reserveWebhookReplay(cache, "signed-generation-key");
  const first = reserve();
  expect(reserve().isReplay).toBe(true);
  first.releaseReplay?.();
  expect(reserve().isReplay).toBe(false);
  first.releaseReplay?.();
  expect(reserve().isReplay).toBe(true);
});

it("redelivers a signed callback after its unknown call is registered", async () => {
  const providerCallId = "CA-late-registration";
  const calls: CallRecord[] = [];
  const { start, processEvent } = signedTwilio("late-registration-token", calls);
  processEvent.mockImplementation(async (event) =>
    calls.some((call) => call.providerCallId === event.providerCallId)
      ? { kind: "processed" }
      : { kind: "ignored", replayable: true },
  );
  const send = await start(
    `CallSid=${providerCallId}&CallStatus=in-progress&Direction=outbound-api`,
  );
  await reply(send());
  calls.push(callRecord({ provider: "twilio", providerCallId }));
  await reply(send());
  expect(processEvent).toHaveBeenCalledTimes(2);
  expect(await xml(send())).toBe(emptyTwiML);
  expect(processEvent).toHaveBeenCalledTimes(2);
});

it("holds a signed response until event persistence finishes", async () => {
  const { start, processEvent } = signedTwilio("delayed-store-token");
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
    await reply(response);
  } finally {
    persistence.resolve({ kind: "processed" });
    await response;
  }
});

it("shares failed callbacks and successful retries without leaking stream tokens", async () => {
  const { server, start, processEvent, carrier } = signedTwilio(
    "concurrent-token",
    [],
    { inboundPolicy: "open", realtime: { enabled: true } },
    "/voice/stream/realtime",
  );
  const verification = vi.spyOn(carrier, "verifyWebhook");
  let response = createDeferred<ReturnType<RealtimeCallHandler["buildTwiMLPayload"]>>();
  const build = vi.fn(
    () => response.promise as unknown as ReturnType<RealtimeCallHandler["buildTwiMLPayload"]>,
  );
  realtime(server, build);
  const send = await start("CallSid=CA-concurrent&Direction=inbound&CallStatus=ringing");
  const pair = async (attempt: number) => {
    const owner = send();
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(attempt));
    const duplicate = send();
    let settled = false;
    void duplicate.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(verification).toHaveBeenCalledTimes(attempt * 2));
    expect(settled).toBe(false);
    return { owner, duplicate };
  };
  const failed = await pair(1);
  response.reject(new Error("synthetic realtime setup failure"));
  expect((await Promise.all([failed.owner, failed.duplicate])).map((r) => r.status)).toEqual([
    500, 500,
  ]);
  response = createDeferred<ReturnType<RealtimeCallHandler["buildTwiMLPayload"]>>();
  const retry = await pair(2);
  response.resolve(streamResponse("one-time-secret"));
  expect(await reply(retry.owner)).toContain("one-time-secret");
  expect(await xml(retry.duplicate)).toBe(emptyTwiML);
  expect(await xml(send())).toBe(emptyTwiML);
  expect(build).toHaveBeenCalledTimes(2);
  notCalled(processEvent);
  expect(carrier).toHaveProperty("callStreamMap.size", 0);
  expect(carrier).toHaveProperty("streamAuthTokens.size", 0);
});

it("reconstructs uncached replay responses without repeating side effects", async () => {
  const carrier = new MockProvider();
  const parse = vi.spyOn(carrier, "parseWebhookEvent");
  const first = fixture({}, carrier);
  const body = JSON.stringify({
    event: {
      type: "call.error",
      callId: "call-replay",
      error: "carrier failure",
      retryable: false,
    },
  });
  await reply(first.post(body));
  expect(first.processEvent).toHaveBeenCalledOnce();
  await first.server.stop();
  parse.mockClear();
  const replacement = fixture({}, carrier, [], { processEvent: first.processEvent });
  first.processEvent.mockClear();
  expect(await reply(replacement.post(body))).toBe("OK");
  expect(parse).toHaveBeenCalledOnce();
  notCalled(first.processEvent);
});

it("retries Plivo persistence failures and replays XML without event side effects", async () => {
  const authToken = "plivo-replay-token",
    nonce = "plivo-replay-nonce";
  const publicUrl = "https://example.test/voice/webhook";
  const plivo = { authId: "MA000000000000000000", authToken };
  const carrier = new PlivoProvider(plivo, { publicUrl });
  const parse = vi.spyOn(carrier, "parseWebhookEvent");
  const { server, processEvent } = fixture({ provider: "plivo", plivo }, carrier);
  const url = new URL(
    "?provider=plivo&flow=answer&callId=internal-call-id&tag=z&tag=a",
    await server.start(),
  );
  const body =
    "CallUUID=plivo-replay-answer-callback&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp&Tag=z&Tag=a";
  const signature = (tag: string) =>
    crypto
      .createHmac("sha256", authToken)
      .update(
        `${publicUrl}?callId=internal-call-id&flow=answer&provider=plivo&tag=a&tag=z.CallStatusin-progressCallUUIDplivo-replay-answer-callbackDirectionoutboundEventStartAppFrom+15550000000Tag${tag}TagzTo+15550000001.${nonce}`,
      )
      .digest("base64");
  const send = (rawBody = body, signed = signature("a")) =>
    post(url, rawBody, {
      "x-plivo-signature-v3": signed,
      "x-plivo-signature-v3-nonce": nonce,
    });
  expect(await reply(send(body, "invalid"), 401)).toBe("Unauthorized");
  notCalled(parse, processEvent);
  processEvent.mockRejectedValueOnce(new Error("synthetic persistence failure"));
  await reply(send(), 500);
  parse.mockClear();
  processEvent.mockClear();
  const expected = await xml(send());
  expect(expected).toContain("<Wait");
  expect(processEvent).toHaveBeenCalledOnce();
  const firstKey = processEvent.mock.calls[0]?.[0].dedupeKey;
  expect(firstKey).toMatch(/^plivo:v3:/);
  parse.mockClear();
  processEvent.mockClear();
  url.search = "?tag=a&callId=internal-call-id&tag=z&flow=answer&provider=plivo";
  expect(await xml(send(body.split("&").toReversed().join("&")))).toBe(expected);
  notCalled(parse, processEvent);
  expect(await xml(send(body.replace("Tag=a", "Tag=b"), signature("b")))).toBe(expected);
  expect(processEvent).toHaveBeenCalledOnce();
  expect(processEvent.mock.calls[0]?.[0].dedupeKey).not.toBe(firstKey);
});

it.each(["outbound-api", "inbound"] as const)(
  "routes %s setup before realtime stream creation",
  async (direction) => {
    const outbound = direction === "outbound-api";
    const parseWebhookEvent = vi.fn(() => ({ events: [] }));
    const consumeInitialTwiML = vi.fn<NonNullable<VoiceCallProvider["consumeInitialTwiML"]>>();
    if (outbound) {
      consumeInitialTwiML.mockReturnValueOnce(
        '<Response><Play digits="ww123456#" /><Redirect method="POST">https://example.test</Redirect></Response>',
      );
    }
    const build = vi.fn(() => streamResponse());
    const { server, processEvent } = fixture(
      {
        provider: "twilio",
        realtime: { enabled: true },
        inboundPolicy: outbound ? "disabled" : "allowlist",
        allowFrom: ["+15550001111"],
      },
      streamingProvider({
        verifyWebhook: (ctx) => ({ ok: true, verifiedRequestKey: ctx.rawBody }),
        parseWebhookEvent,
        consumeInitialTwiML,
      }),
    );
    realtime(server, build);
    const url = await server.start();
    const send = (from: string, target = url) =>
      post(
        target,
        `CallSid=CA123&Direction=${direction}&CallStatus=${outbound ? "in-progress" : "ringing"}&From=${encodeURIComponent(from)}`,
        twilioHeaders,
      );
    expect(await reply(send("+15550002222", `${url}?callId=call-1`))).toContain(
      outbound ? '<Play digits="ww123456#"' : "<Reject",
    );
    notCalled(build, parseWebhookEvent, processEvent);
    expect(await reply(send("+15550001111"))).toContain("<Connect><Stream");
    expect(build).toHaveBeenCalledOnce();
    notCalled(parseWebhookEvent, processEvent);
  },
);

it.each([false, true])(
  "limits pre-auth requests (missing remote address: %s)",
  async (missingRemote) => {
    const { server } = fixture({ provider: "twilio" }, streamingProvider());
    const ready = createDeferred<void>(),
      unblock = createDeferred<void>();
    let entered = 0;
    const read = vi
      .spyOn(webhookRequestGuards, "readRequestBodyWithLimit")
      .mockImplementation(async () => {
        if (++entered === 8) {
          ready.resolve();
        }
        if (missingRemote || entered <= 8) {
          await unblock.promise;
        }
        return speechBody;
      });
    const url = missingRemote ? undefined : await server.start();
    const send = async (body: string) => {
      if (url) {
        const response = await post(url, body, twilioHeaders);
        return { statusCode: response.status, body: await response.text() };
      }
      return runPipeline(server);
    };
    try {
      const pending = Array.from({ length: 8 }, () => send("CallSid=CA123"));
      await ready.promise;
      expect(await send("CallSid=CA999")).toEqual({ statusCode: 429, body: "Too Many Requests" });
      expect(read).toHaveBeenCalledTimes(8);
      unblock.resolve();
      expect((await Promise.all(pending)).map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    } finally {
      unblock.resolve();
      read.mockRestore();
      await server.stop();
    }
  },
);

it.each([false, true])(
  "keeps frozen agent and response privacy (early delivery: %s)",
  async (early) => {
    const call = callRecord({
      agentId: "support",
      to: "+15550001111",
      direction: early ? "inbound" : "outbound",
      sessionKey: "agent:top:voice:15550001111",
    });
    const speak = vi.fn(async () => ({ success: true }));
    const { server, messages } = fixture(
      { agentId: "top", numbers: { "+15550001111": { agentId: "inbound-route" } } },
      provider,
      [call],
      { getCall: (id) => (id === call.callId ? call : undefined), speak },
      true,
    );
    const text = "confidential reply";
    mocks.generate.mockReset().mockImplementationOnce(async (params) => {
      if (early) {
        await params?.onEarlyText?.(text);
      }
      return { text, deliveredEarly: early };
    });
    await internals(server).handleInboundResponse(call.callId, "private user speech");
    expect(mocks.generate.mock.calls[0]?.[0]).toMatchObject({ agentId: "support" });
    if (!early) {
      expect(mocks.generate.mock.calls[0]?.[0]).toMatchObject({ voiceConfig: { agentId: "top" } });
    }
    expect(mocks.generate.mock.calls[0]?.[0]).toHaveProperty(
      "senderIsOwner",
      early ? false : undefined,
    );
    expect(speak).toHaveBeenCalledExactlyOnceWith(call.callId, text, {
      listenAfterPlayback: true,
      isCurrent: expect.any(Function),
    });
    privateLogs(messages, [call.callId], ["private user speech", text]);
  },
);

it("coalesces starts, reuses its listening URL, and restarts after stop", async () => {
  const { server } = fixture();
  const checkUrl = (url: string) => {
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/voice/webhook");
    expect(["", "0"]).not.toContain(parsed.port);
  };
  await server.stop();
  const [first, concurrent] = await Promise.all([server.start(), server.start()]);
  checkUrl(first);
  expect(concurrent).toBe(first);
  expect(await server.start()).toBe(first);
  await server.stop();
  checkUrl(await server.start());
});

it("logs transcript counts without disclosing inactive-stream speech", async () => {
  const { server, messages } = fixture(streamConfig, streamingProvider(), [], {
    getCallByProviderCallId: () => undefined,
  });
  await server.start();
  const transcript = `${"a".repeat(199)}\uD83D\uDE80tail`,
    partial = "sensitive partial speech";
  media(server).onTranscript?.("CA-utf16", transcript, "MZ-log");
  media(server).onPartialTranscript?.("CA-partial", partial, "MZ-log");
  privateLogs(messages, ["CA-utf16", "CA-partial"], [transcript, partial]);
});

it("suppresses outbound greeting barge-in until the initial message finishes", async () => {
  const call = callRecord({
    state: "speaking",
    metadata: { mode: "conversation", initialMessage: "Greeting" },
  });
  const clearTtsQueue = vi.fn<StreamProvider["clearTtsQueue"]>();
  const { server, processEvent } = fixture(
    streamConfig,
    streamingProvider({ clearTtsQueue }),
    [call],
    {
      getCallByProviderCallId: (id) => (id === call.providerCallId ? call : undefined),
    },
  );
  processEvent.mockImplementation(async (event) => {
    if (event.type !== "call.speech") {
      return { kind: "processed" };
    }
    call.state = "listening";
    return { kind: "final-speech", call, transcript: event.transcript, waiterResolved: false };
  });
  await server.start();
  const respond = vi.fn(async () => {});
  internals(server).handleInboundResponse = respond;
  const callbacks = media(server);
  callbacks.onSpeechStart?.("provider-call-1", "stream");
  callbacks.onTranscript?.("provider-call-1", "hello", "stream");
  callbacks.onSpeechStart?.("provider-call-1", "stream");
  callbacks.onTranscript?.("provider-call-1", "hello again", "stream");
  notCalled(clearTtsQueue, respond, processEvent);
  delete call.metadata!.initialMessage;
  call.state = "listening";
  callbacks.onSpeechStart?.("provider-call-1", "stream");
  callbacks.onTranscript?.("provider-call-1", "hello after greeting", "stream");
  expect(clearTtsQueue).toHaveBeenCalledTimes(2);
  expect(processEvent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      type: "call.speech",
      callId: call.callId,
      providerCallId: call.providerCallId,
      transcript: "hello after greeting",
      isFinal: true,
    }),
  );
  await vi.waitFor(() =>
    expect(respond).toHaveBeenCalledExactlyOnceWith(call.callId, "hello after greeting"),
  );
});
