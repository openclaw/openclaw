import crypto from "node:crypto";
import path from "node:path";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeVoiceCallConfig, type VoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createTestStorePath,
  FakeProvider,
  finalizeTestManagerCalls,
  installVoiceCallStateRuntimeForTests,
} from "./manager.test-harness.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { MockProvider } from "./providers/mock.js";
import { TwilioProvider } from "./providers/twilio.js";
import { getOptionalVoiceCallStateRuntime } from "./runtime-state.js";
import type { CallRecord, WebhookContext, WebhookParseOptions } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

const createConfig = (overrides: Partial<VoiceCallConfig> = {}): VoiceCallConfig => {
  const base = normalizeVoiceCallConfig({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    inboundPolicy: "disabled",
  });
  base.serve.port = 0;

  return { ...base, ...overrides };
};

const formHeaders = {
  "content-type": "application/x-www-form-urlencoded",
  "x-plivo-signature-v2": "sig",
  "x-plivo-signature-v2-nonce": "nonce",
};

async function postWebhookForm(baseUrl: string, body: string) {
  return await fetch(baseUrl, { method: "POST", headers: formHeaders, body });
}

async function withWebhook(
  run: (fixture: {
    manager: CallManager;
    provider: VoiceCallProvider;
    url: string;
    send: (payload: unknown) => Promise<void>;
    rows: () => ReturnType<typeof rawCallRows>;
  }) => Promise<void>,
  {
    provider = new MockProvider(),
    config = createConfig({ provider: "mock", inboundPolicy: "open" }),
    storePath = createTestStorePath(),
    preserveActive = false,
  }: {
    provider?: VoiceCallProvider;
    config?: VoiceCallConfig;
    storePath?: string;
    preserveActive?: boolean;
  } = {},
) {
  const manager = new CallManager(config, storePath);
  const server = new VoiceCallWebhookServer(
    createTestPluginServiceScheduler(),
    config,
    manager,
    provider,
  );
  try {
    const url = await server.start();
    await manager.initialize(provider, url);
    await run({
      manager,
      provider,
      url,
      rows: () => rawCallRows(storePath),
      send: async (payload) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        await response.text();
        expect(response.status, "mock webhook HTTP status").toBe(200);
      },
    });
  } finally {
    try {
      await server.stop();
    } finally {
      try {
        if (!preserveActive) {
          await finalizeTestManagerCalls(manager);
        }
      } finally {
        if (provider instanceof MockProvider) {
          await manager.stop();
        }
      }
    }
  }
}

class RejectInboundReplayProvider extends FakeProvider {
  override verifyWebhook() {
    return { ok: true, verifiedRequestKey: "verified:req:reject-once" };
  }

  override parseWebhookEvent(_ctx: WebhookContext, options?: WebhookParseOptions) {
    return {
      statusCode: 200,
      events: [
        {
          ...eventFacts("evt-reject-once"),
          dedupeKey: options?.verifiedRequestKey,
          callId: "provider-inbound-1",
          providerCallId: "provider-inbound-1",
          to: "+15550000000",
        },
      ],
    };
  }
}

class RejectInboundReplayWithHangupFailureProvider extends RejectInboundReplayProvider {
  override async hangupCall(input: Parameters<FakeProvider["hangupCall"]>[0]): Promise<void> {
    this.hangupCalls.push(input);
    throw new Error("hangup failed");
  }
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  installVoiceCallStateRuntimeForTests();
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
});

function eventFacts(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "call.initiated" as const,
    callId: id,
    providerCallId: `provider-${id}`,
    timestamp: Date.now(),
    direction: "inbound" as const,
    from: "+15552222222",
    to: "+15553333333",
    ...overrides,
  };
}

async function rawCallRows(storePath: string) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: storePath };
  // Read raw namespaces, not schema-filtered history: invalid persisted calls must be visible.
  const rows = [];
  for (const [namespace, maxEntries] of [
    ["call-record-events", 1_100],
    ["call-record-event-chunks", 48_048],
  ] as const) {
    const store = createPluginStateKeyedStoreForTests<unknown>("voice-call", {
      namespace,
      maxEntries,
      env,
    });
    rows.push((await store.entries()).toSorted((a, b) => a.key.localeCompare(b.key)));
  }
  return rows;
}

describe("Mock webhook caller facts over HTTP and SQLite", () => {
  it("restores all four admitted event types before any synthetic finalization", async () => {
    const storePath = createTestStorePath();
    const retained: CallRecord[] = [];
    await withWebhook(
      async ({ manager, send }) => {
        const greeting = vi.spyOn(manager, "speakInitialMessage");
        for (const [type, state] of [
          ["call.initiated", "ringing"],
          ["call.ringing", "ringing"],
          ["call.answered", "listening"],
          ["call.active", "active"],
        ]) {
          const event = eventFacts(`http-${type}`, { type });
          await send({ event });
          if (type === "call.answered") {
            expect(greeting).toHaveBeenCalledExactlyOnceWith(event.providerCallId);
            const result = greeting.mock.results[0];
            if (result?.type !== "return") {
              throw new Error("expected actual greeting completion");
            }
            await result.value;
          }
          const call = manager.getCallByProviderCallId(event.providerCallId);
          expect(call, "HTTP event must admit caller facts").toMatchObject({
            provider: "mock",
            providerCallId: event.providerCallId,
            direction: "inbound",
            from: event.from,
            to: event.to,
            state,
          });
          if (!call) {
            throw new Error("expected admitted call");
          }
          retained.push(structuredClone(call));
          const rows = await rawCallRows(storePath);
          expect(rows[0]?.length).toBeGreaterThan(0);
          expect(rows[1]?.length).toBeGreaterThan(0);
          await send({ event });
          await send({ event, delivery: "same-event-new-request" });
          expect(await rawCallRows(storePath)).toEqual(rows);
          expect(manager.getActiveCalls()).toHaveLength(retained.length);
        }
      },
      { storePath, preserveActive: true },
    );

    // The first server and manager are fully stopped, but no call.ended has been synthesized.
    await closeOpenClawStateDatabaseByPathAsync(path.join(storePath, "state", "openclaw.sqlite"));
    await withWebhook(
      async ({ manager, send }) => {
        expect(manager.getActiveCalls()).toHaveLength(retained.length);
        for (const call of retained) {
          expect(manager.getCall(call.callId)).toMatchObject(call);
          await send({
            event: {
              id: `end-${call.providerCallId}`,
              type: "call.ended",
              callId: call.callId,
              providerCallId: call.providerCallId,
              timestamp: Date.now(),
              reason: "completed",
            },
          });
          expect(await manager.getCallFromMemoryOrStore(call.callId)).toMatchObject({
            ...call,
            state: "completed",
            endReason: "completed",
            processedEventIds: expect.arrayContaining(call.processedEventIds),
          });
        }
        expect(manager.getActiveCalls()).toEqual([]);
      },
      { storePath },
    );
  });

  it.each([
    { inboundPolicy: "disabled", allowFrom: [], admitted: false },
    { inboundPolicy: "allowlist", allowFrom: ["+15552222222"], admitted: true },
    { inboundPolicy: "allowlist", allowFrom: ["+15559999999"], admitted: false },
  ] as const)("honors $inboundPolicy policy with admitted=$admitted", async (policy) => {
    const storePath = createTestStorePath();
    await withWebhook(
      async ({ manager, provider, send }) => {
        const hangup = vi.spyOn(provider, "hangupCall");
        const event = eventFacts("policy-call");
        await send({ event });
        const rows = await rawCallRows(storePath);
        if (policy.admitted) {
          expect(manager.getCallByProviderCallId(event.providerCallId)).toMatchObject({
            direction: "inbound",
            from: event.from,
            to: event.to,
          });
          expect(hangup).not.toHaveBeenCalled();
        } else {
          expect(manager.getActiveCalls()).toEqual([]);
          expect(rows.map((entries) => entries.length)).toEqual([1, 1]);
          expect((await manager.getCallHistory()).at(-1)).toMatchObject({
            providerCallId: event.providerCallId,
            state: "hangup-bot",
            endReason: "hangup-bot",
            metadata: { rejectionReason: "inbound-policy" },
          });
          expect(hangup).toHaveBeenCalledExactlyOnceWith({
            callId: event.callId,
            providerCallId: event.providerCallId,
            reason: "hangup-bot",
          });
        }
        await send({ event });
        await send({ event, delivery: "retry" });
        expect(await rawCallRows(storePath)).toEqual(rows);
        expect(hangup).toHaveBeenCalledTimes(policy.admitted ? 0 : 1);
      },
      {
        storePath,
        config: createConfig({
          provider: "mock",
          inboundPolicy: policy.inboundPolicy,
          allowFrom: [...policy.allowFrom],
        }),
      },
    );
  });

  it("does not write unknown calls with malformed identity or direction", async () => {
    await withWebhook(async ({ manager, provider, send, rows }) => {
      const hangup = vi.spyOn(provider, "hangupCall");
      const empty = await rows();
      expect(empty).toEqual([[], []]);
      for (const [index, overrides] of [
        { direction: "sideways" },
        { callId: 42 },
        { providerCallId: { unexpected: true } },
        { providerCallId: undefined },
        { direction: { unexpected: true } },
        { direction: undefined },
      ].entries()) {
        await send({ event: eventFacts(`invalid-${index}`, overrides) });
        expect(await rows(), `raw writes for invalid case ${index}`).toEqual(empty);
        expect(manager.getActiveCalls()).toEqual([]);
        expect(await manager.getCallHistory()).toEqual([]);
      }
      expect(hangup).not.toHaveBeenCalled();
    });
  });

  it("uses manager fallback for optional numbers and updates an owned outbound call without direction", async () => {
    await withWebhook(async ({ manager, send, rows }) => {
      for (const [index, numbers] of [
        { from: undefined, to: undefined },
        { from: { unexpected: true }, to: 42 },
        { from: "", to: "" },
      ].entries()) {
        const event = eventFacts(`fallback-${index}`, numbers);
        await send({ event });
        const numbersFallback = { from: "unknown", to: "+15550000000" };
        expect(manager.getCallByProviderCallId(event.providerCallId)).toMatchObject({
          direction: "inbound",
          ...numbersFallback,
        });
        expect((await manager.getCallHistory()).at(-1)).toMatchObject({
          providerCallId: event.providerCallId,
          ...numbersFallback,
        });
        await send({
          event: { ...event, id: `end-${index}`, type: "call.ended", reason: "completed" },
        });
      }
      const started = await manager.initiateCall("+15554444444", "agent:main:voice:mock-proof");
      expect(started.success).toBe(true);
      const original = structuredClone(manager.getCall(started.callId));
      expect(original).toMatchObject({ direction: "outbound", to: "+15554444444" });
      await send({
        event: {
          id: "owned-outbound-update",
          type: "call.active",
          callId: started.callId,
          timestamp: Date.now(),
        },
      });
      const updated = {
        callId: started.callId,
        direction: "outbound",
        from: "+15550000000",
        to: "+15554444444",
        state: "active",
      };
      expect(manager.getCall(started.callId)).toMatchObject({
        ...updated,
        providerCallId: original?.providerCallId,
      });
      expect((await manager.getCallHistory()).at(-1)).toMatchObject(updated);
      const stored = await rows();
      expect(stored[0]?.length).toBeGreaterThan(0);
      expect(stored[1]?.length).toBeGreaterThan(0);
    });
  });
});

describe("Voice-call webhook lifecycle", () => {
  it("preserves finalized identity through signed HTTP callbacks and retries failed history reads", async () => {
    const authToken = "synthetic-terminal-webhook-token";
    const config = createConfig({
      provider: "twilio",
      agentId: "default-agent",
      twilio: { accountSid: "AC-fixture", authToken },
    });
    const provider = new TwilioProvider({ accountSid: "AC-fixture", authToken });
    vi.spyOn(provider, "initiateCall").mockResolvedValue({
      providerCallId: "CA-terminal-identity",
      status: "initiated",
    });
    const playback = vi.spyOn(provider, "playTts").mockResolvedValue();
    const hangup = vi.spyOn(provider, "hangupCall").mockResolvedValue();
    await withWebhook(
      async ({ manager, url: baseUrl }) => {
        const processing = vi.spyOn(manager, "processEvent");
        provider.setPublicUrl(baseUrl);
        const started = await manager.initiateCall("+15550000001", "agent:sales:voice:http", {
          agentId: "sales",
        });
        expect(started.success).toBe(true);
        const url = new URL(baseUrl);
        url.searchParams.set("callId", started.callId);
        url.searchParams.set("type", "status");
        const send = async (callStatus: string, sequence: string) => {
          const form = new URLSearchParams({
            CallSid: "CA-terminal-identity",
            CallStatus: callStatus,
            Direction: "outbound-api",
            From: "+15550000000",
            To: "+15550000001",
            SequenceNumber: sequence,
          });
          form.sort();
          const material = url.toString() + [...form].map(([key, value]) => key + value).join("");
          const signature = crypto.createHmac("sha1", authToken).update(material).digest("base64");
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-twilio-signature": signature,
            },
            body: form.toString(),
          });
          await response.text();
          return response.status;
        };

        expect(await send("in-progress", "1")).toBe(200);
        await expect(
          manager.speak(started.callId, "Keep the original transcript."),
        ).resolves.toEqual({
          success: true,
        });
        await expect(manager.endCall(started.callId)).resolves.toEqual({ success: true });
        const history = await manager.getCallHistory();
        expect(history.at(-1)).toMatchObject({
          callId: started.callId,
          agentId: "sales",
          sessionKey: "agent:sales:voice:http",
          state: "hangup-bot",
          transcript: [expect.objectContaining({ text: "Keep the original transcript." })],
        });
        expect(await send("completed", "2")).toBe(200);
        const terminalCalls = processing.mock.calls.length;
        expect(await send("completed", "2")).toBe(200);
        expect(processing).toHaveBeenCalledTimes(terminalCalls);

        const state = getOptionalVoiceCallStateRuntime()?.state;
        if (!state) {
          throw new Error("expected fixture SQLite runtime");
        }
        const openStore = state.openKeyedStoreV2.bind(state);
        const fault = vi
          .spyOn(state, "openKeyedStoreV2")
          .mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) => {
            const store = openStore<T>(options);
            store.entries = async () => {
              throw new Error("synthetic signed callback history failure");
            };
            return store;
          });
        try {
          expect(await send("completed", "3")).toBe(500);
        } finally {
          fault.mockRestore();
        }
        expect(await send("completed", "3")).toBe(200);
        expect(processing).toHaveBeenCalledTimes(terminalCalls + 2);
        expect(await manager.getCallHistory()).toEqual(history);
        expect(manager.getActiveCalls()).toEqual([]);
        expect(playback).toHaveBeenCalledTimes(1);
        expect(hangup).toHaveBeenCalledTimes(1);
      },
      { provider, config },
    );
  });

  it("retains a rejected event through failed hangup, duplicate delivery, and manager restart", async () => {
    const storePath = createTestStorePath();
    const rejected = {
      callId: "provider-inbound-1",
      providerCallId: "provider-inbound-1",
      reason: "hangup-bot",
    };
    for (const [provider, deliveries, expected] of [
      [new RejectInboundReplayWithHangupFailureProvider("plivo"), 2, [rejected]],
      [new RejectInboundReplayProvider("plivo"), 1, []],
    ] as const) {
      await withWebhook(
        async ({ manager, url }) => {
          for (let delivery = 0; delivery < deliveries; delivery++) {
            expect((await postWebhookForm(url, "CallSid=CA123&From=%2B15552222222")).status).toBe(
              200,
            );
          }
          expect(provider.hangupCalls).toEqual(expected);
          expect(manager.getCallByProviderCallId(rejected.providerCallId)).toBeUndefined();
        },
        { provider, config: createConfig(), storePath },
      );
    }
  });

  it("answers an over-limit webhook with 413 and then closes the connection", async () => {
    // Driven over a real socket: the server answers while the sender is still uploading
    // and then closes, so a mocked response cannot show whether either half happened.
    await withWebhook(
      async ({ url: baseUrl }) => {
        const result = await postRawWebhook({
          url: baseUrl,
          body: `CallSid=CA123&From=%2B15552222222&Padding=${"x".repeat(2 * 1024 * 1024)}`,
          headers: formHeaders,
        });

        expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
        expect(result.closedByServer).toBe(true);
      },
      { provider: new FakeProvider(), config: createConfig() },
    );
  });
});
