import { describe, expect, it, vi } from "vitest";
import type { WebhookContext } from "../types.js";
import { TwilioProvider } from "./twilio.js";

const STREAM_URL = "wss://example.ngrok.app/voice/stream";

function createProvider(): TwilioProvider {
  return new TwilioProvider(
    { accountSid: "AC123", authToken: "secret" },
    { publicUrl: "https://example.ngrok.app", streamPath: "/voice/stream" },
  );
}

function createContext(rawBody: string, query?: WebhookContext["query"]): WebhookContext {
  return {
    headers: {},
    rawBody,
    url: "https://example.ngrok.app/voice/twilio",
    method: "POST",
    query,
  };
}

function expectStreamingTwiml(body: string) {
  expect(body).toContain(STREAM_URL);
  expect(body).toContain('<Parameter name="token" value="');
  expect(body).toContain("<Connect>");
}

describe("TwilioProvider", () => {
  it("returns streaming TwiML for outbound conversation calls before in-progress", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=initiated&Direction=outbound-api&CallSid=CA123", {
      callId: "call-1",
    });

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toBeDefined();
    expectStreamingTwiml(result.providerResponseBody ?? "");
  });

  it("returns empty TwiML for status callbacks", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=ringing&Direction=outbound-api", {
      callId: "call-1",
      type: "status",
    });

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
  });

  it("returns streaming TwiML for inbound calls", () => {
    const provider = createProvider();
    const ctx = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA456");

    const result = provider.parseWebhookEvent(ctx);

    expect(result.providerResponseBody).toBeDefined();
    expectStreamingTwiml(result.providerResponseBody ?? "");
  });

  it("returns queue TwiML for second inbound call when first call is active", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA111");
    const secondInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA222");

    const firstResult = provider.parseWebhookEvent(firstInbound);
    const secondResult = provider.parseWebhookEvent(secondInbound);

    expect(firstResult.providerResponseBody).toContain("<Connect>");
    expect(secondResult.providerResponseBody).toContain("Please hold while we connect you.");
    expect(secondResult.providerResponseBody).toContain("<Enqueue");
    expect(secondResult.providerResponseBody).toContain("hold-queue");
  });

  it("connects next inbound call after unregisterCallStream cleanup", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA311");
    const secondInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA322");

    provider.parseWebhookEvent(firstInbound);
    provider.unregisterCallStream("CA311");
    const secondResult = provider.parseWebhookEvent(secondInbound);

    expect(secondResult.providerResponseBody).toContain("<Connect>");
    expect(secondResult.providerResponseBody).not.toContain("hold-queue");
  });

  it("cleans up active inbound call on completed status callback", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA411");
    const completed = createContext("CallStatus=completed&Direction=inbound&CallSid=CA411", {
      type: "status",
    });
    const nextInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA422");

    provider.parseWebhookEvent(firstInbound);
    provider.parseWebhookEvent(completed);
    const nextResult = provider.parseWebhookEvent(nextInbound);

    expect(nextResult.providerResponseBody).toContain("<Connect>");
    expect(nextResult.providerResponseBody).not.toContain("hold-queue");
  });

  it("cleans up active inbound call on canceled status callback", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA511");
    const canceled = createContext("CallStatus=canceled&Direction=inbound&CallSid=CA511", {
      type: "status",
    });
    const nextInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA522");

    provider.parseWebhookEvent(firstInbound);
    provider.parseWebhookEvent(canceled);
    const nextResult = provider.parseWebhookEvent(nextInbound);

    expect(nextResult.providerResponseBody).toContain("<Connect>");
    expect(nextResult.providerResponseBody).not.toContain("hold-queue");
  });

  it("QUEUE_TWIML references /voice/hold-music waitUrl", () => {
    const provider = createProvider();
    const firstInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA611");
    const secondInbound = createContext("CallStatus=ringing&Direction=inbound&CallSid=CA622");

    provider.parseWebhookEvent(firstInbound);
    const result = provider.parseWebhookEvent(secondInbound);

    expect(result.providerResponseBody).toContain('waitUrl="/voice/hold-music"');
  });

  it("uses a stable fallback dedupeKey for identical request payloads", () => {
    const provider = createProvider();
    const rawBody = "CallSid=CA789&Direction=inbound&SpeechResult=hello";
    const ctxA = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-123" },
    };
    const ctxB = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-123" },
    };

    const eventA = provider.parseWebhookEvent(ctxA).events[0];
    const eventB = provider.parseWebhookEvent(ctxB).events[0];

    expect(eventA).toBeDefined();
    expect(eventB).toBeDefined();
    expect(eventA?.id).not.toBe(eventB?.id);
    expect(eventA?.dedupeKey).toContain("twilio:fallback:");
    expect(eventA?.dedupeKey).toBe(eventB?.dedupeKey);
  });

  it("uses verified request key for dedupe and ignores idempotency header changes", () => {
    const provider = createProvider();
    const rawBody = "CallSid=CA790&Direction=inbound&SpeechResult=hello";
    const ctxA = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-a" },
    };
    const ctxB = {
      ...createContext(rawBody, { callId: "call-1", turnToken: "turn-1" }),
      headers: { "i-twilio-idempotency-token": "idem-b" },
    };

    const eventA = provider.parseWebhookEvent(ctxA, { verifiedRequestKey: "twilio:req:abc" })
      .events[0];
    const eventB = provider.parseWebhookEvent(ctxB, { verifiedRequestKey: "twilio:req:abc" })
      .events[0];

    expect(eventA?.dedupeKey).toBe("twilio:req:abc");
    expect(eventB?.dedupeKey).toBe("twilio:req:abc");
  });

  it("keeps turnToken from query on speech events", () => {
    const provider = createProvider();
    const ctx = createContext("CallSid=CA222&Direction=inbound&SpeechResult=hello", {
      callId: "call-2",
      turnToken: "turn-xyz",
    });

    const event = provider.parseWebhookEvent(ctx).events[0];
    expect(event?.type).toBe("call.speech");
    expect(event?.turnToken).toBe("turn-xyz");
  });

  it("falls back to TwiML when an active stream exists but telephony TTS is unavailable", async () => {
    const provider = createProvider();
    const apiRequest = vi.fn<
      (
        endpoint: string,
        params: Record<string, string | string[]>,
        options?: { allowNotFound?: boolean },
      ) => Promise<unknown>
    >(async () => ({}));
    (
      provider as unknown as {
        apiRequest: (
          endpoint: string,
          params: Record<string, string | string[]>,
          options?: { allowNotFound?: boolean },
        ) => Promise<unknown>;
      }
    ).apiRequest = apiRequest;
    (
      provider as unknown as {
        callWebhookUrls: Map<string, string>;
      }
    ).callWebhookUrls.set("CA-stream", "https://example.ngrok.app/voice/twilio");
    provider.registerCallStream("CA-stream", "MZ-stream");

    await expect(
      provider.playTts({
        callId: "call-stream",
        providerCallId: "CA-stream",
        text: "Hello stream",
      }),
    ).resolves.toBeUndefined();
    expect(apiRequest).toHaveBeenCalledTimes(1);
    const call = apiRequest.mock.calls[0]!;
    const endpoint = call[0];
    const params = call[1] as { Twiml?: string };
    expect(endpoint).toBe("/Calls/CA-stream.json");
    expect(params.Twiml).toContain("<Say");
  });

  it("times out telephony synthesis in stream mode and does not send completion mark", async () => {
    vi.useFakeTimers();
    try {
      const provider = createProvider();
      provider.registerCallStream("CA-timeout", "MZ-timeout");

      const sendAudio = vi.fn();
      const sendMark = vi.fn();
      const mediaStreamHandler = {
        queueTts: async (
          _streamSid: string,
          playFn: (signal: AbortSignal) => Promise<void>,
        ): Promise<void> => {
          await playFn(new AbortController().signal);
        },
        sendAudio,
        sendMark,
      };

      provider.setMediaStreamHandler(mediaStreamHandler as never);
      provider.setTTSProvider({
        synthesizeForTelephony: async () => await new Promise<Buffer>(() => {}),
      });

      const playExpectation = expect(
        provider.playTts({
          callId: "call-timeout",
          providerCallId: "CA-timeout",
          text: "Timeout me",
        }),
      ).rejects.toThrow("Telephony TTS synthesis timed out");
      await vi.advanceTimersByTimeAsync(8_100);
      await playExpectation;
      expect(sendAudio).toHaveBeenCalled();
      expect(sendMark).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails stream playback when all audio sends and completion mark are dropped", async () => {
    const provider = createProvider();
    provider.registerCallStream("CA-dropped", "MZ-dropped");

    const sendAudio = vi.fn(() => ({ sent: false }));
    const sendMark = vi.fn(() => ({ sent: false }));
    const mediaStreamHandler = {
      queueTts: async (
        _streamSid: string,
        playFn: (signal: AbortSignal) => Promise<void>,
      ): Promise<void> => {
        await playFn(new AbortController().signal);
      },
      sendAudio,
      sendMark,
    };

    provider.setMediaStreamHandler(mediaStreamHandler as never);
    provider.setTTSProvider({
      synthesizeForTelephony: async () => Buffer.alloc(320),
    });

    await expect(
      provider.playTts({
        callId: "call-dropped",
        providerCallId: "CA-dropped",
        text: "Dropped audio",
      }),
    ).rejects.toThrow("Telephony stream playback failed");
    expect(sendAudio).toHaveBeenCalled();
    expect(sendMark).toHaveBeenCalledTimes(1);
  });
});
