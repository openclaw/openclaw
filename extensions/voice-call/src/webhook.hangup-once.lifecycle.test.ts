import crypto from "node:crypto";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema, type VoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createTestStorePath,
  FakeProvider,
  finalizeTestManagerCalls,
  installVoiceCallStateRuntimeForTests,
} from "./manager.test-harness.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { TwilioProvider } from "./providers/twilio.js";
import { getOptionalVoiceCallStateRuntime } from "./runtime-state.js";
import type { WebhookContext, WebhookParseOptions } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

const createConfig = (overrides: Partial<VoiceCallConfig> = {}): VoiceCallConfig => {
  const base = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    inboundPolicy: "disabled",
  });
  base.serve.port = 0;

  return {
    ...base,
    ...overrides,
  };
};

async function postWebhookForm(baseUrl: string, body: string) {
  return await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-plivo-signature-v2": "sig",
      "x-plivo-signature-v2-nonce": "nonce",
    },
    body,
  });
}

async function withServer(
  provider: VoiceCallProvider,
  run: (manager: CallManager, url: string) => Promise<void>,
  config = createConfig(),
  storePath = createTestStorePath(),
) {
  const manager = new CallManager(config, storePath);
  const server = new VoiceCallWebhookServer(config, manager, provider);
  try {
    const url = await server.start();
    await manager.initialize(provider, url);
    await run(manager, url);
  } finally {
    try {
      await server.stop();
    } finally {
      await finalizeTestManagerCalls(manager);
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
          id: "evt-reject-once",
          dedupeKey: options?.verifiedRequestKey,
          type: "call.initiated" as const,
          callId: "provider-inbound-1",
          providerCallId: "provider-inbound-1",
          timestamp: Date.now(),
          direction: "inbound" as const,
          from: "+15552222222",
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
    await withServer(
      provider,
      async (manager, baseUrl) => {
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
        const openStore = state.openKeyedStore.bind(state);
        const fault = vi
          .spyOn(state, "openKeyedStore")
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
      config,
    );
  });

  it("retains a rejected event through failed hangup, duplicate delivery, and manager restart", async () => {
    const storePath = createTestStorePath();
    const firstProvider = new RejectInboundReplayWithHangupFailureProvider("plivo");
    await withServer(
      firstProvider,
      async (manager, url) => {
        const first = await postWebhookForm(url, "CallSid=CA123&From=%2B15552222222");
        const duplicate = await postWebhookForm(url, "CallSid=CA123&From=%2B15552222222");
        expect(first.status).toBe(200);
        expect(duplicate.status).toBe(200);
        expect(firstProvider.hangupCalls).toEqual([
          {
            callId: "provider-inbound-1",
            providerCallId: "provider-inbound-1",
            reason: "hangup-bot",
          },
        ]);
        expect(manager.getCallByProviderCallId("provider-inbound-1")).toBeUndefined();
      },
      createConfig(),
      storePath,
    );

    const secondProvider = new RejectInboundReplayProvider("plivo");
    await withServer(
      secondProvider,
      async (manager, url) => {
        const replay = await postWebhookForm(url, "CallSid=CA123&From=%2B15552222222");
        expect(replay.status).toBe(200);
        expect(secondProvider.hangupCalls).toHaveLength(0);
        expect(manager.getCallByProviderCallId("provider-inbound-1")).toBeUndefined();
      },
      createConfig(),
      storePath,
    );
  });

  it("answers an over-limit webhook with 413 and then closes the connection", async () => {
    // Driven over a real socket: the server answers while the sender is still uploading
    // and then closes, so a mocked response cannot show whether either half happened.
    await withServer(new FakeProvider(), async (_manager, baseUrl) => {
      const result = await postRawWebhook({
        url: baseUrl,
        body: `CallSid=CA123&From=%2B15552222222&Padding=${"x".repeat(2 * 1024 * 1024)}`,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-plivo-signature-v2": "sig",
          "x-plivo-signature-v2-nonce": "nonce",
        },
      });

      expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(result.closedByServer).toBe(true);
    });
  });
});
