// Voice Call tests cover plivo plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "../types.js";
import { PlivoProvider } from "./plivo.js";

type PlivoPrivateCallState = {
  requestUuidToCallUuid: Map<string, string>;
  callIdToWebhookUrl: Map<string, string>;
  callUuidToWebhookUrl: Map<string, string>;
  pendingSpeakByCallId: Map<string, unknown>;
  pendingListenByCallId: Map<string, unknown>;
};

function getPlivoPrivateCallState(provider: PlivoProvider): PlivoPrivateCallState {
  return provider as unknown as PlivoPrivateCallState;
}

function seedPlivoPrivateCallState(params: {
  provider: PlivoProvider;
  callId: string;
  requestUuid: string;
  callUuid: string;
}): void {
  const state = getPlivoPrivateCallState(params.provider);
  state.requestUuidToCallUuid.set(params.requestUuid, params.callUuid);
  state.callIdToWebhookUrl.set(params.callId, "https://example.com/voice/webhook");
  state.callUuidToWebhookUrl.set(params.callUuid, "https://example.com/voice/webhook");
  state.pendingSpeakByCallId.set(params.callId, { text: "Hello" });
  state.pendingListenByCallId.set(params.callId, { language: "en-US" });
}

function expectPlivoPrivateCallStateReleased(params: {
  provider: PlivoProvider;
  callId: string;
  requestUuid: string;
  callUuid: string;
}): void {
  const state = getPlivoPrivateCallState(params.provider);
  expect(state.requestUuidToCallUuid.has(params.requestUuid)).toBe(false);
  expect(state.callIdToWebhookUrl.has(params.callId)).toBe(false);
  expect(state.callUuidToWebhookUrl.has(params.callUuid)).toBe(false);
  expect(state.pendingSpeakByCallId.has(params.callId)).toBe(false);
  expect(state.pendingListenByCallId.has(params.callId)).toBe(false);
}

function expectPlivoPrivateCallStatePresent(params: {
  provider: PlivoProvider;
  callId: string;
  requestUuid: string;
  callUuid: string;
}): void {
  const state = getPlivoPrivateCallState(params.provider);
  expect(state.requestUuidToCallUuid.get(params.requestUuid)).toBe(params.callUuid);
  expect(state.callIdToWebhookUrl.has(params.callId)).toBe(true);
  expect(state.callUuidToWebhookUrl.has(params.callUuid)).toBe(true);
  expect(state.pendingSpeakByCallId.has(params.callId)).toBe(true);
  expect(state.pendingListenByCallId.has(params.callId)).toBe(true);
}

function requireEvent<T>(event: T | undefined, message: string): T {
  if (!event) {
    throw new Error(message);
  }
  return event;
}

function requireResponseBody(body: string | undefined): string {
  if (!body) {
    throw new Error("Plivo provider did not return a response body");
  }
  return body;
}

function webhookContextFor(url: string, rawBody: string) {
  const parsed = new URL(url);
  const query: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) {
    query[key] = value;
  }
  return {
    headers: { host: parsed.host },
    rawBody,
    url,
    method: "POST" as const,
    query,
  };
}

function requireTransferUrl(apiRequest: { mock: { calls: unknown[][] } }): string {
  const body = (apiRequest.mock.calls.at(-1)?.[0] as { body?: { aleg_url?: string } } | undefined)
    ?.body;
  if (!body?.aleg_url) {
    throw new Error("Plivo provider did not transfer the call leg");
  }
  return body.aleg_url;
}

function requireSpeechEvent(event: NormalizedEvent) {
  if (event.type !== "call.speech") {
    throw new Error(`expected a Plivo speech event, received ${event.type}`);
  }
  return event;
}

function requireGetInputActionUrl(responseBody: string): string {
  const match = /<GetInput[^>]*action="([^"]+)"/.exec(responseBody);
  if (!match?.[1]) {
    throw new Error("Plivo provider did not render a GetInput action URL");
  }
  return match[1].replaceAll("&amp;", "&");
}

function createListeningProvider(): {
  provider: PlivoProvider;
  apiRequest: ReturnType<typeof vi.fn>;
} {
  const provider = new PlivoProvider({
    authId: "MA000000000000000000",
    authToken: "test-token",
  });
  const apiRequest = vi.fn(async (_params: unknown) => ({}));
  (provider as unknown as { apiRequest: (params: unknown) => Promise<unknown> }).apiRequest =
    apiRequest;
  (provider as unknown as { callIdToWebhookUrl: Map<string, string> }).callIdToWebhookUrl.set(
    "internal-call-id",
    "https://example.com/voice/webhook",
  );
  return { provider, apiRequest };
}

async function driveListenRoundTrip(params: {
  provider: PlivoProvider;
  apiRequest: ReturnType<typeof vi.fn>;
  turnToken?: string;
  transcript: string;
}) {
  await params.provider.startListening({
    callId: "internal-call-id",
    providerCallId: "call-uuid",
    language: "en-US",
    ...(params.turnToken ? { turnToken: params.turnToken } : {}),
  });

  const transferUrl = requireTransferUrl(params.apiRequest);
  const listenResult = params.provider.parseWebhookEvent(
    webhookContextFor(transferUrl, "CallUUID=call-uuid"),
  );
  const actionUrl = requireGetInputActionUrl(
    requireResponseBody(listenResult.providerResponseBody),
  );
  const speechResult = params.provider.parseWebhookEvent(
    webhookContextFor(
      actionUrl,
      `CallUUID=call-uuid&Speech=${encodeURIComponent(params.transcript)}`,
    ),
  );
  const event = requireEvent(speechResult.events[0], "expected a Plivo speech event");
  return { transferUrl, actionUrl, event: requireSpeechEvent(event) };
}

describe("PlivoProvider", () => {
  it("parses answer callback into call.answered and returns keep-alive XML", () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });

    const result = provider.parseWebhookEvent({
      headers: { host: "example.com" },
      rawBody:
        "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
      url: "https://example.com/voice/webhook?provider=plivo&flow=answer&callId=internal-call-id",
      method: "POST",
      query: { provider: "plivo", flow: "answer", callId: "internal-call-id" },
    });

    expect(result.events).toHaveLength(1);
    const event = requireEvent(result.events[0], "expected Plivo answer event");
    expect(event.type).toBe("call.answered");
    expect(event.callId).toBe("internal-call-id");
    expect(event.providerCallId).toBe("call-uuid");
    const responseBody = requireResponseBody(result.providerResponseBody);
    expect(responseBody).toContain("<Wait");
    expect(responseBody).toContain('length="300"');
  });

  it("uses verified request key when provided", () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });

    const result = provider.parseWebhookEvent(
      {
        headers: { host: "example.com", "x-plivo-signature-v3-nonce": "nonce-1" },
        rawBody:
          "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
        url: "https://example.com/voice/webhook?provider=plivo&flow=answer&callId=internal-call-id",
        method: "POST",
        query: { provider: "plivo", flow: "answer", callId: "internal-call-id" },
      },
      { verifiedRequestKey: "plivo:v3:verified" },
    );

    expect(result.events).toHaveLength(1);
    expect(requireEvent(result.events[0], "expected verified Plivo event").dedupeKey).toBe(
      "plivo:v3:verified",
    );
  });

  it("pins stored callback bases to publicUrl instead of request Host", () => {
    const provider = new PlivoProvider(
      {
        authId: "MA000000000000000000",
        authToken: "test-token",
      },
      {
        publicUrl: "https://voice.openclaw.ai/voice/webhook?provider=plivo",
      },
    );

    provider.parseWebhookEvent({
      headers: { host: "attacker.example" },
      rawBody:
        "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
      url: "https://attacker.example/voice/webhook?provider=plivo&flow=answer&callId=internal-call-id",
      method: "POST",
      query: { provider: "plivo", flow: "answer", callId: "internal-call-id" },
    });

    const callbackMap = (provider as unknown as { callUuidToWebhookUrl: Map<string, string> })
      .callUuidToWebhookUrl;

    expect(callbackMap.get("call-uuid")).toBe("https://voice.openclaw.ai/voice/webhook");
  });

  it("pins call-control transfer URLs to the configured publicUrl path", async () => {
    const provider = new PlivoProvider(
      {
        authId: "MA000000000000000000",
        authToken: "test-token",
      },
      {
        publicUrl: "https://voice.openclaw.ai/voice/webhook?provider=plivo",
      },
    );
    const apiRequest = vi.fn(async (_params: unknown) => ({}));
    (
      provider as unknown as {
        apiRequest: (params: unknown) => Promise<unknown>;
      }
    ).apiRequest = apiRequest;

    provider.parseWebhookEvent({
      headers: { host: "attacker.example" },
      rawBody:
        "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
      url: "https://attacker.example/admin?provider=plivo&flow=answer&callId=internal-call-id",
      method: "POST",
      query: { provider: "plivo", flow: "answer", callId: "internal-call-id" },
    });

    await provider.playTts({
      callId: "internal-call-id",
      providerCallId: "call-uuid",
      text: "How can I help?",
    });

    expect(apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/Call/call-uuid/",
        body: expect.objectContaining({
          aleg_url:
            "https://voice.openclaw.ai/voice/webhook?provider=plivo&flow=xml-speak&callId=internal-call-id",
        }),
      }),
    );
  });

  it("renders an auto-response as the prompt for the next speech input", async () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });
    const apiRequest = vi.fn(async (_params: unknown) => ({}));
    (
      provider as unknown as {
        apiRequest: (params: unknown) => Promise<unknown>;
      }
    ).apiRequest = apiRequest;
    (
      provider as unknown as {
        callIdToWebhookUrl: Map<string, string>;
      }
    ).callIdToWebhookUrl.set("internal-call-id", "https://example.com/voice/webhook");

    await provider.playTts({
      callId: "internal-call-id",
      providerCallId: "call-uuid",
      text: "How can I help?",
      locale: "en-US",
      listenAfterPlayback: true,
    });

    expect(apiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/Call/call-uuid/",
        body: expect.objectContaining({
          aleg_url: expect.stringContaining("flow=xml-speak"),
        }),
      }),
    );

    const result = provider.parseWebhookEvent({
      headers: { host: "example.com" },
      rawBody: "CallUUID=call-uuid",
      url: "https://example.com/voice/webhook?provider=plivo&flow=xml-speak&callId=internal-call-id",
      method: "POST",
      query: { provider: "plivo", flow: "xml-speak", callId: "internal-call-id" },
    });
    const responseBody = requireResponseBody(result.providerResponseBody);
    expect(responseBody).toContain('<GetInput inputType="speech"');
    expect(responseBody).toContain('speechEndTimeout="2"');
    expect(responseBody).toContain("flow=getinput");
    expect(responseBody).toContain('<Speak language="en-US">How can I help?</Speak>');
    expect(responseBody.indexOf("<GetInput")).toBeLessThan(responseBody.indexOf("<Speak"));
  });

  it("releases all provider call state on terminal callbacks and late replays", () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });
    const callId = "internal-terminal";
    const requestUuid = "request-terminal";
    const callUuid = "call-terminal";
    seedPlivoPrivateCallState({ provider, callId, requestUuid, callUuid });
    const terminal = {
      headers: { host: "example.com" },
      rawBody: `CallUUID=${callUuid}&RequestUUID=${requestUuid}&CallStatus=completed&Direction=outbound`,
      url: `https://example.com/voice/webhook?provider=plivo&flow=hangup&callId=${callId}`,
      method: "POST" as const,
      query: { provider: "plivo", flow: "hangup", callId },
    };

    const first = provider.parseWebhookEvent(terminal).events[0];
    expect(first).toMatchObject({
      type: "call.ended",
      callId,
      providerCallId: callUuid,
      reason: "completed",
    });
    expectPlivoPrivateCallStateReleased({ provider, callId, requestUuid, callUuid });

    const lateReplay = provider.parseWebhookEvent(terminal).events[0];
    expect(lateReplay).toMatchObject({
      type: "call.ended",
      callId,
      providerCallId: callUuid,
      reason: "completed",
    });
    expectPlivoPrivateCallStateReleased({ provider, callId, requestUuid, callUuid });
  });

  it("releases call-id state for terminal callbacks without a query override", () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });
    const requestUuid = "request-queryless";
    const callUuid = "call-queryless";
    seedPlivoPrivateCallState({
      provider,
      callId: callUuid,
      requestUuid,
      callUuid,
    });

    const event = provider.parseWebhookEvent({
      headers: { host: "example.com" },
      rawBody: `CallUUID=${callUuid}&RequestUUID=${requestUuid}&CallStatus=completed&Direction=outbound`,
      url: "https://example.com/voice/webhook",
      method: "POST",
      query: {},
    }).events[0];

    expect(event).toMatchObject({
      type: "call.ended",
      callId: callUuid,
      providerCallId: callUuid,
      reason: "completed",
    });
    expectPlivoPrivateCallStateReleased({
      provider,
      callId: callUuid,
      requestUuid,
      callUuid,
    });
  });

  it("releases all provider call state after repeated explicit hangups", async () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });
    const callId = "internal-hangup";
    const requestUuid = "request-hangup";
    const callUuid = "call-hangup";
    seedPlivoPrivateCallState({ provider, callId, requestUuid, callUuid });
    const apiRequest = vi.fn(async (_params: unknown) => ({}));
    (
      provider as unknown as {
        apiRequest: (params: unknown) => Promise<unknown>;
      }
    ).apiRequest = apiRequest;
    const input = {
      callId,
      providerCallId: requestUuid,
      reason: "hangup-bot" as const,
    };

    await provider.hangupCall(input);
    expectPlivoPrivateCallStateReleased({ provider, callId, requestUuid, callUuid });
    await provider.hangupCall(input);
    expectPlivoPrivateCallStateReleased({ provider, callId, requestUuid, callUuid });
    expect(apiRequest).toHaveBeenCalledTimes(3);
  });

  it("retains call state when explicit hangup fails so it can retry", async () => {
    const provider = new PlivoProvider({
      authId: "MA000000000000000000",
      authToken: "test-token",
    });
    const callId = "internal-hangup-retry";
    const requestUuid = "request-hangup-retry";
    const callUuid = "call-hangup-retry";
    seedPlivoPrivateCallState({ provider, callId, requestUuid, callUuid });
    const apiRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary Plivo failure"))
      .mockResolvedValue({});
    (
      provider as unknown as {
        apiRequest: (params: unknown) => Promise<unknown>;
      }
    ).apiRequest = apiRequest;
    const input = {
      callId,
      providerCallId: requestUuid,
      reason: "hangup-bot" as const,
    };

    await expect(provider.hangupCall(input)).rejects.toThrow("temporary Plivo failure");
    expectPlivoPrivateCallStatePresent({ provider, callId, requestUuid, callUuid });

    await provider.hangupCall(input);
    expectPlivoPrivateCallStateReleased({ provider, callId, requestUuid, callUuid });
    expect(apiRequest).toHaveBeenNthCalledWith(1, {
      method: "DELETE",
      endpoint: `/Call/${callUuid}/`,
      allowNotFound: true,
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, {
      method: "DELETE",
      endpoint: `/Call/${callUuid}/`,
      allowNotFound: true,
    });
  });

  it("round-trips a turn token from startListening onto the speech callback", async () => {
    const { provider, apiRequest } = createListeningProvider();

    const roundTrip = await driveListenRoundTrip({
      provider,
      apiRequest,
      turnToken: "turn-token-1",
      transcript: "eight six seven five three oh nine",
    });

    expect(new URL(roundTrip.transferUrl).searchParams.get("turnToken")).toBe("turn-token-1");
    expect(new URL(roundTrip.actionUrl).searchParams.get("turnToken")).toBe("turn-token-1");
    expect(roundTrip.event.turnToken).toBe("turn-token-1");
  });

  it("omits the turn token when the manager does not issue one", async () => {
    const { provider, apiRequest } = createListeningProvider();

    const roundTrip = await driveListenRoundTrip({
      provider,
      apiRequest,
      transcript: "no token here",
    });

    expect(new URL(roundTrip.transferUrl).searchParams.has("turnToken")).toBe(false);
    expect(new URL(roundTrip.actionUrl).searchParams.has("turnToken")).toBe(false);
    expect(roundTrip.event.turnToken).toBeUndefined();
  });

  it("keeps identical speech bodies from different turns distinct for replay dedupe", async () => {
    const { provider, apiRequest } = createListeningProvider();

    const first = await driveListenRoundTrip({
      provider,
      apiRequest,
      turnToken: "turn-token-1",
      transcript: "yes",
    });
    const second = await driveListenRoundTrip({
      provider,
      apiRequest,
      turnToken: "turn-token-2",
      transcript: "yes",
    });

    expect(first.event.transcript).toBe(second.event.transcript);
    expect(first.event.dedupeKey).toBeDefined();
    expect(second.event.dedupeKey).toBeDefined();
    expect(first.event.dedupeKey).not.toBe(second.event.dedupeKey);
  });

  it("carries the live turn token onto an auto-response GetInput", async () => {
    const { provider, apiRequest } = createListeningProvider();

    await provider.startListening({
      callId: "internal-call-id",
      providerCallId: "call-uuid",
      language: "en-US",
      turnToken: "turn-token-1",
    });

    await provider.playTts({
      callId: "internal-call-id",
      providerCallId: "call-uuid",
      text: "How can I help?",
      locale: "en-US",
      listenAfterPlayback: true,
    });

    const speakUrl = requireTransferUrl(apiRequest);
    expect(new URL(speakUrl).searchParams.get("flow")).toBe("xml-speak");
    const speakResult = provider.parseWebhookEvent(
      webhookContextFor(speakUrl, "CallUUID=call-uuid"),
    );
    const actionUrl = requireGetInputActionUrl(
      requireResponseBody(speakResult.providerResponseBody),
    );
    expect(new URL(actionUrl).searchParams.get("turnToken")).toBe("turn-token-1");

    const speechResult = provider.parseWebhookEvent(
      webhookContextFor(actionUrl, "CallUUID=call-uuid&Speech=yes please"),
    );
    const event = requireSpeechEvent(
      requireEvent(speechResult.events[0], "expected a Plivo speech event"),
    );
    expect(event.turnToken).toBe("turn-token-1");
  });

  it("leaves the auto-response GetInput unstamped when no turn is listening", async () => {
    const { provider, apiRequest } = createListeningProvider();

    await provider.playTts({
      callId: "internal-call-id",
      providerCallId: "call-uuid",
      text: "How can I help?",
      locale: "en-US",
      listenAfterPlayback: true,
    });

    const speakResult = provider.parseWebhookEvent(
      webhookContextFor(requireTransferUrl(apiRequest), "CallUUID=call-uuid"),
    );
    const actionUrl = requireGetInputActionUrl(
      requireResponseBody(speakResult.providerResponseBody),
    );
    expect(new URL(actionUrl).searchParams.has("turnToken")).toBe(false);
  });

  it("declares that it echoes the turn token back to the manager", () => {
    const { provider } = createListeningProvider();
    expect(provider.echoesTurnToken).toBe(true);
  });
});
