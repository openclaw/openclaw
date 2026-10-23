import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookContext } from "../types.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { PlivoProvider } from "./plivo.js";

const PROVIDER_CONFIG = { authId: "MA000000000000000000", authToken: "test-token" };

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

const callId = "internal-call-id";
const requestUuid = "request-uuid";
const callUuid = "call-uuid";
const webhookUrl = "https://example.com/voice/webhook";
const hangup = { callId, providerCallId: requestUuid, reason: "hangup-bot" as const };

function seedState(provider: PlivoProvider, id = callId) {
  const state = getPlivoPrivateCallState(provider);
  state.requestUuidToCallUuid.set(requestUuid, callUuid);
  state.callIdToWebhookUrl.set(id, webhookUrl);
  state.callUuidToWebhookUrl.set(callUuid, webhookUrl);
  state.pendingSpeakByCallId.set(id, { text: "Hello" });
  state.pendingListenByCallId.set(id, { language: "en-US" });
}

function expectState(provider: PlivoProvider, present: boolean, id = callId) {
  const state = getPlivoPrivateCallState(provider);
  expect(state.requestUuidToCallUuid).toEqual(
    present ? new Map([[requestUuid, callUuid]]) : new Map(),
  );
  expect([
    state.callIdToWebhookUrl.has(id),
    state.callUuidToWebhookUrl.has(callUuid),
    state.pendingSpeakByCallId.has(id),
    state.pendingListenByCallId.has(id),
  ]).toEqual([present, present, present, present]);
}

function context(overrides: Partial<WebhookContext> = {}): WebhookContext {
  return {
    headers: { host: "example.com" },
    rawBody:
      "CallUUID=call-uuid&CallStatus=in-progress&Direction=outbound&From=%2B15550000000&To=%2B15550000001&Event=StartApp",
    url: `${webhookUrl}?provider=plivo&flow=answer&callId=${callId}`,
    method: "POST",
    query: { provider: "plivo", flow: "answer", callId },
    ...overrides,
  };
}

function expectTransfer(body: unknown) {
  expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
    expect.objectContaining({
      url: `https://api.plivo.com/v1/Account/${PROVIDER_CONFIG.authId}/Call/call-uuid/`,
      init: expect.objectContaining({ method: "POST", body }),
    }),
  );
}

describe("PlivoProvider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset().mockImplementation(async () => ({
      response: new Response("{}"),
      release: async () => {},
    }));
  });

  it("uses verified request key when provided", () => {
    const result = new PlivoProvider(PROVIDER_CONFIG).parseWebhookEvent(
      context({ headers: { host: "example.com", "x-plivo-signature-v3-nonce": "nonce-1" } }),
      { verifiedRequestKey: "plivo:v3:verified" },
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.dedupeKey).toBe("plivo:v3:verified");
  });

  it("pins call-control transfer URLs to the configured publicUrl path", async () => {
    const provider = new PlivoProvider(PROVIDER_CONFIG, {
      publicUrl: "https://voice.openclaw.ai/voice/webhook?provider=plivo",
    });
    provider.parseWebhookEvent(
      context({
        headers: { host: "attacker.example" },
        url: "https://attacker.example/admin?provider=plivo&flow=answer&callId=internal-call-id",
      }),
    );

    await provider.playTts({ callId, providerCallId: callUuid, text: "How can I help?" });

    expectTransfer(
      JSON.stringify({
        legs: "aleg",
        aleg_url:
          "https://voice.openclaw.ai/voice/webhook?provider=plivo&flow=xml-speak&callId=internal-call-id",
        aleg_method: "POST",
      }),
    );
  });

  it("renders an auto-response as the prompt for the next speech input", async () => {
    const provider = new PlivoProvider(PROVIDER_CONFIG);
    getPlivoPrivateCallState(provider).callIdToWebhookUrl.set(callId, webhookUrl);

    await provider.playTts({
      callId,
      providerCallId: callUuid,
      text: "How can I help?",
      locale: "en-US",
      listenAfterPlayback: true,
    });

    expectTransfer(expect.stringContaining("flow=xml-speak"));

    const result = provider.parseWebhookEvent(
      context({
        rawBody: "CallUUID=call-uuid",
        url: "https://example.com/voice/webhook?provider=plivo&flow=xml-speak&callId=internal-call-id",
        query: { provider: "plivo", flow: "xml-speak", callId },
      }),
    );
    const responseBody = expectDefined(result.providerResponseBody, "Plivo response body");
    expect(responseBody).toContain('<GetInput inputType="speech"');
    expect(responseBody).toContain('speechEndTimeout="2"');
    expect(responseBody).toContain("flow=getinput");
    expect(responseBody).toContain('<Speak language="en-US">How can I help?</Speak>');
    expect(responseBody.indexOf("<GetInput")).toBeLessThan(responseBody.indexOf("<Speak"));
  });

  it.each([true, false])("releases terminal call state (query override=%s)", (override) => {
    const provider = new PlivoProvider(PROVIDER_CONFIG);
    const id = override ? callId : callUuid;
    seedState(provider, id);
    const terminal = context({
      rawBody: `CallUUID=${callUuid}&RequestUUID=${requestUuid}&CallStatus=completed&Direction=outbound`,
      url: override ? `${webhookUrl}?provider=plivo&flow=hangup&callId=${id}` : webhookUrl,
      query: override ? { provider: "plivo", flow: "hangup", callId: id } : {},
    });

    // Repeat the override callback to retain the late-replay cleanup contract.
    for (let attempt = 0; attempt < (override ? 2 : 1); attempt++) {
      expect(provider.parseWebhookEvent(terminal).events[0], `attempt ${attempt}`).toMatchObject({
        type: "call.ended",
        callId: id,
        providerCallId: callUuid,
        reason: "completed",
      });
      expectState(provider, false, id);
    }
  });

  it("releases all provider call state after repeated explicit hangups", async () => {
    const provider = new PlivoProvider(PROVIDER_CONFIG);
    seedState(provider);

    await provider.hangupCall(hangup);
    expectState(provider, false);
    fetchWithSsrFGuardMock.mockImplementation(async () => ({
      response: new Response("", { status: 404 }),
      release: async () => {},
    }));
    await provider.hangupCall(hangup);
    expectState(provider, false);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(3);
  });

  it("retains call state when explicit hangup fails so it can retry", async () => {
    const provider = new PlivoProvider(PROVIDER_CONFIG);
    seedState(provider);
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("temporary Plivo failure"));

    await expect(provider.hangupCall(hangup)).rejects.toThrow("temporary Plivo failure");
    expectState(provider, true);

    await provider.hangupCall(hangup);
    expectState(provider, false);
    for (const call of [1, 2]) {
      expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
        call,
        expect.objectContaining({
          url: `https://api.plivo.com/v1/Account/${PROVIDER_CONFIG.authId}/Call/${callUuid}/`,
          init: expect.objectContaining({ method: "DELETE" }),
        }),
      );
    }
  });
});
