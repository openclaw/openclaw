import crypto from "node:crypto";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { fetchWithSsrFGuard } from "../../api.js";
import type { WebhookContext } from "../types.js";
import { TelnyxProvider } from "./telnyx.js";

const PROVIDER_CONFIG = { apiKey: "KEY123", connectionId: "CONN456", publicKey: undefined };

const apiMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<typeof fetchWithSsrFGuard>(),
}));

vi.mock("../../api.js", () => ({
  fetchWithSsrFGuard: apiMocks.fetchWithSsrFGuard,
}));

afterEach(() => {
  apiMocks.fetchWithSsrFGuard.mockReset();
});

function createCtx(params?: Partial<WebhookContext>): WebhookContext {
  return {
    headers: {},
    rawBody: "{}",
    url: "http://localhost/voice/webhook",
    method: "POST",
    query: {},
    remoteAddress: "127.0.0.1",
    ...params,
  };
}

function createProvider(publicKey?: string, skipVerification = false) {
  return new TelnyxProvider({ ...PROVIDER_CONFIG, publicKey }, { skipVerification });
}

function parseEvent(
  event_type: string,
  payload: Record<string, unknown>,
  verifiedRequestKey?: string,
) {
  return new TelnyxProvider(PROVIDER_CONFIG).parseWebhookEvent(
    createCtx({ rawBody: JSON.stringify({ data: { id: "evt-fixture", event_type, payload } }) }),
    { verifiedRequestKey },
  );
}

function mockResponse(data: Record<string, unknown> = {}) {
  const release = vi.fn(async () => {});
  apiMocks.fetchWithSsrFGuard.mockResolvedValue({
    response: new Response(JSON.stringify({ data }), { status: 200 }),
    finalUrl: "https://api.telnyx.com/v2/calls",
    release,
  });
  return release;
}

function requireFetchRequest() {
  return expectDefined(apiMocks.fetchWithSsrFGuard.mock.calls[0], "Telnyx API request")[0];
}

function createSignedTelnyxCtx(params: {
  privateKey: crypto.KeyObject;
  rawBody: string;
}): WebhookContext {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signedPayload = `${timestamp}|${params.rawBody}`;
  const signature = crypto
    .sign(null, Buffer.from(signedPayload), params.privateKey)
    .toString("base64");

  return createCtx({
    rawBody: params.rawBody,
    headers: {
      "telnyx-signature-ed25519": signature,
      "telnyx-timestamp": timestamp,
    },
  });
}

describe("TelnyxProvider.verifyWebhook", () => {
  it("fails closed when public key is missing and skipVerification is false", () => {
    expect(createProvider().verifyWebhook(createCtx()).ok).toBe(false);
  });

  it("allows requests when skipVerification is true (development only)", () => {
    expect(createProvider(undefined, true).verifyWebhook(createCtx()).ok).toBe(true);
  });

  it("fails when signature headers are missing (with public key configured)", () => {
    expect(createProvider("public-key").verifyWebhook(createCtx({ headers: {} })).ok).toBe(false);
  });

  it("verifies a valid signature with a raw Ed25519 public key (Base64)", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

    const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    expect(jwk).toMatchObject({ kty: "OKP", crv: "Ed25519", x: expect.any(String) });
    expect(jwk.x).not.toBe("");
    const rawPublicKey = Buffer.from(expectDefined(jwk.x, "Ed25519 public key"), "base64url");
    const rawPublicKeyBase64 = rawPublicKey.toString("base64");
    const provider = createProvider(rawPublicKeyBase64);
    const rawBody = JSON.stringify({
      event_type: "call.initiated",
      payload: { call_control_id: "x" },
    });
    expect(provider.verifyWebhook(createSignedTelnyxCtx({ privateKey, rawBody })).ok).toBe(true);
  });

  it("returns replay status when the same signed request is seen twice", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const provider = createProvider(spkiDer.toString("base64"));

    const rawBody = JSON.stringify({
      event_type: "call.initiated",
      payload: { call_control_id: "call-replay-test" },
      nonce: crypto.randomUUID(),
    });
    const ctx = createSignedTelnyxCtx({ privateKey, rawBody });

    const first = provider.verifyWebhook(ctx);
    const second = provider.verifyWebhook(ctx);

    expect([first.ok, second.ok]).toEqual([true, true]);
    expect([Boolean(first.isReplay), Boolean(second.isReplay)]).toEqual([false, true]);
    expect(first.verifiedRequestKey).toEqual(expect.any(String));
    expect(first.verifiedRequestKey?.length).toBeGreaterThan(0);
    expect(second.verifiedRequestKey).toBe(first.verifiedRequestKey);
  });
});

describe("TelnyxProvider.parseWebhookEvent", () => {
  it("maps call direction and phone numbers from Call Control callbacks", () => {
    const result = parseEvent(
      "call.initiated",
      {
        call_control_id: "call-1",
        direction: "incoming",
        from: "+15551111111",
        to: "+15550000000",
      },
      "telnyx:req:abc",
    );

    expect(result.events).toMatchObject([
      {
        dedupeKey: "telnyx:req:abc",
        type: "call.initiated",
        direction: "inbound",
        from: "+15551111111",
        to: "+15550000000",
      },
    ]);
  });

  it("uses raw client_state fallback when client_state is malformed base64", () => {
    const result = parseEvent("call.initiated", {
      call_control_id: "call-fallback",
      client_state: "call-1@@@",
    });

    expect(result.events).toMatchObject([{ callId: "call-1@@@" }]);
  });

  it("reads transcription text from Telnyx transcription_data payloads", () => {
    const result = parseEvent("call.transcription", {
      call_control_id: "call-1",
      transcription_data: {
        transcript: "hello this is a test speech",
        is_final: false,
        confidence: 0.977219,
      },
    });

    expect(result.events).toMatchObject([
      {
        type: "call.speech",
        transcript: "hello this is a test speech",
        isFinal: false,
        confidence: 0.977219,
      },
    ]);
  });

  it("does not emit blank transcription payloads", () => {
    const result = parseEvent("call.transcription", {
      call_control_id: "call-1",
      transcription_data: { transcript: undefined },
    });

    expect(result.events).toEqual([]);
  });
});

describe("TelnyxProvider Media Streaming (PCMU)", () => {
  it("omits streaming fields from the dial payload when streamUrl is absent", async () => {
    mockResponse({ call_control_id: "call-control-1" });
    const provider = new TelnyxProvider(PROVIDER_CONFIG);

    await provider.initiateCall({
      callId: "call-1",
      from: "+15550000001",
      to: "+15550000002",
      webhookUrl: "https://example.test/voice/webhook",
    });

    const body = JSON.parse(requireFetchRequest().init?.body as string) as Record<string, unknown>;
    expect(body.stream_url).toBeUndefined();
    expect(body.stream_codec).toBeUndefined();
    expect(body.stream_bidirectional_codec).toBeUndefined();
    expect(body.stream_auth_token).toBeUndefined();
  });

  it("embeds streaming fields in the answer action when streamUrl is provided", async () => {
    mockResponse();
    const provider = new TelnyxProvider(PROVIDER_CONFIG);

    await provider.answerCall({
      callId: "call-1",
      providerCallId: "call-control-1",
      streamUrl: "wss://example.test/voice/stream/realtime/token-xyz",
      streamAuthToken: "token-xyz",
    });

    const body = JSON.parse(requireFetchRequest().init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      command_id: "openclaw-answer-call-1",
      stream_url: "wss://example.test/voice/stream/realtime/token-xyz",
      stream_codec: "PCMU",
      stream_bidirectional_target_legs: "self",
      stream_auth_token: "token-xyz",
    });
  });

  it("silently acknowledges streaming.started and streaming.stopped webhooks", () => {
    // The WebSocket owns stream lifecycle; carrier callbacks must not duplicate it.
    for (const eventType of ["streaming.started", "streaming.stopped"]) {
      const result = parseEvent(eventType, { call_control_id: "call-control-1" }, "key-1");
      expect(result).toMatchObject({ events: [], statusCode: 200 });
    }
  });
  it("passes custom Telnyx voice ids to the speak action", async () => {
    const release = mockResponse();
    const provider = new TelnyxProvider(PROVIDER_CONFIG);

    await provider.playTts({
      callId: "call-1",
      providerCallId: "call-control-1",
      text: "hello",
      voice: "Telnyx.Qwen3TTS.12345678-1234-1234-1234-123456789abc",
    });

    expect(apiMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(1);
    const request = requireFetchRequest();
    expect(request).toMatchObject({
      url: "https://api.telnyx.com/v2/calls/call-control-1/actions/speak",
      auditContext: "voice-call.telnyx.api",
      init: { method: "POST" },
    });
    expect(request.policy).toEqual({ allowedHostnames: ["api.telnyx.com"] });
    expect(typeof request.init?.body).toBe("string");
    const body = JSON.parse(request.init?.body as string) as { voice?: string };
    expect(body.voice).toBe("Telnyx.Qwen3TTS.12345678-1234-1234-1234-123456789abc");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
