// Voice Call tests cover how a running Telnyx runtime answers inbound realtime calls.
import crypto from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { fetchWithSsrFGuard } from "../api.js";
import type { VoiceCallConfig } from "./config.js";
import {
  createTestStorePath,
  createVoiceCallStateRuntimeForTests,
} from "./manager.test-harness.js";
import { createVoiceCallRuntime, type VoiceCallRuntime } from "./runtime.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

const PUBLIC_URL = "https://voice.example.test/voice/webhook";

const apiMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<typeof fetchWithSsrFGuard>(),
}));

// Only the outbound Telnyx HTTP edge is simulated; config parsing, the webhook server,
// event handling, stream session issuing, and the provider all run for real.
vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api.js")>()),
  fetchWithSsrFGuard: apiMocks.fetchWithSsrFGuard,
}));

afterEach(() => {
  apiMocks.fetchWithSsrFGuard.mockReset();
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
});

/** Answer every Telnyx command with a 200 unless `fail` supplies a response for its action. */
function mockTelnyxApi(fail?: (action: string) => Response | undefined) {
  apiMocks.fetchWithSsrFGuard.mockImplementation(async (request) => ({
    response:
      fail?.(request.url.split("/").pop() ?? "") ??
      new Response(JSON.stringify({ data: {} }), { status: 200 }),
    finalUrl: request.url,
    release: vi.fn(async () => {}),
  }));
}

/** Telnyx actions sent so far, in order, with their parsed JSON bodies. */
function readTelnyxCommands() {
  return apiMocks.fetchWithSsrFGuard.mock.calls.map(([request]) => {
    const body = (request as { init?: { body?: unknown } }).init?.body;
    return {
      url: request.url,
      action: request.url.split("/actions/").pop(),
      body: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : undefined,
    };
  });
}

function createTelnyxRealtimeConfig(
  noiseSuppression?: NonNullable<VoiceCallConfig["telnyx"]>["noiseSuppression"],
): VoiceCallConfig {
  const config = createVoiceCallBaseConfig({ provider: "telnyx" });
  config.store = createTestStorePath();
  config.publicUrl = PUBLIC_URL;
  config.serve = { ...config.serve, port: 0 };
  config.inboundPolicy = "open";
  config.staleCallReaperSeconds = 0;
  config.skipSignatureVerification = true;
  config.realtime.enabled = true;
  config.telnyx = {
    apiKey: "KEY123",
    connectionId: "CONN456",
    ...(noiseSuppression ? { noiseSuppression } : {}),
  };
  return config;
}

async function startRuntime(config: VoiceCallConfig): Promise<VoiceCallRuntime> {
  return createVoiceCallRuntime({
    scheduler: createTestPluginServiceScheduler(),
    config,
    coreConfig: { agents: { entries: { main: {} } } } as OpenClawConfig,
    agentRuntime: {} as never,
    stateRuntime: createVoiceCallStateRuntimeForTests(),
  });
}

/**
 * POST a Telnyx `call.initiated` webhook for a new inbound call to the runtime's local listener.
 * Returns the call control ID; each call is unique so webhook replay protection never skips it.
 */
async function deliverInboundCall(runtime: VoiceCallRuntime): Promise<string> {
  const callControlId = `v3:${crypto.randomUUID()}`;
  const localUrl = await runtime.webhookServer.start();
  const response = await fetch(localUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      data: {
        id: crypto.randomUUID(),
        event_type: "call.initiated",
        payload: {
          call_control_id: callControlId,
          direction: "incoming",
          from: "+15550009999",
          to: "+15550001234",
        },
      },
    }),
  });
  expect(response.status).toBe(200);
  return callControlId;
}

/** Wait until the runtime has sent `count` Telnyx commands for the call, then return them. */
async function waitForTelnyxCommands(callControlId: string, count: number) {
  await vi.waitFor(() => expect(apiMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(count), {
    timeout: 3_000,
  });
  const commands = readTelnyxCommands();
  for (const { url } of commands) {
    expect(url.startsWith(`https://api.telnyx.com/v2/calls/${callControlId}/actions/`)).toBe(true);
  }
  return commands;
}

/** Assert a streaming field set points the call at this runtime's public realtime stream. */
function expectRealtimeStreamFields(body: Record<string, unknown> | undefined) {
  const streamUrl = new URL(String(body?.stream_url));
  expect(streamUrl.protocol).toBe("wss:");
  expect(streamUrl.host).toBe("voice.example.test");
  expect(streamUrl.pathname.startsWith("/voice/stream/realtime")).toBe(true);
  expect(body).toMatchObject({
    stream_track: "inbound_track",
    stream_bidirectional_mode: "rtp",
    stream_auth_token: expect.any(String),
  });
}

describe("voice-call runtime answering inbound Telnyx realtime calls", () => {
  it("answers with the stream inline when noise suppression is not configured", async () => {
    mockTelnyxApi();
    const runtime = await startRuntime(createTelnyxRealtimeConfig());
    try {
      const callControlId = await deliverInboundCall(runtime);
      const commands = await waitForTelnyxCommands(callControlId, 1);

      expect(commands.map(({ action }) => action)).toEqual(["answer"]);
      expectRealtimeStreamFields(commands[0]?.body);
    } finally {
      await runtime.stop();
    }
  });

  it("starts Krisp suppression between the stream-less answer and streaming_start", async () => {
    mockTelnyxApi();
    const runtime = await startRuntime(
      createTelnyxRealtimeConfig({
        direction: "outbound",
        engine: "Krisp",
        engineConfig: { model: "krisp-viva-tel-lite-v1.kef", suppressionLevel: 100 },
      }),
    );
    try {
      const callControlId = await deliverInboundCall(runtime);
      const [answer, suppression, streaming] = await waitForTelnyxCommands(callControlId, 3);

      expect([answer?.action, suppression?.action, streaming?.action]).toEqual([
        "answer",
        "suppression_start",
        "streaming_start",
      ]);
      expect(answer?.body).not.toHaveProperty("stream_url");
      expect(suppression?.body).toEqual({
        command_id: expect.stringMatching(/^openclaw-suppression-/),
        direction: "outbound",
        noise_suppression_engine: "Krisp",
        noise_suppression_engine_config: {
          model: "krisp-viva-tel-lite-v1.kef",
          suppression_level: 100,
        },
      });
      expectRealtimeStreamFields(streaming?.body);
      expect(runtime.manager.getActiveCalls()).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });

  it("keeps the call and streams without suppression when Telnyx rejects suppression_start", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockTelnyxApi((action) =>
      action === "suppression_start"
        ? new Response(JSON.stringify({ errors: [{ code: "90045" }] }), { status: 422 })
        : undefined,
    );
    const runtime = await startRuntime(
      createTelnyxRealtimeConfig({ direction: "outbound", engine: "Krisp" }),
    );
    try {
      const callControlId = await deliverInboundCall(runtime);
      const commands = await waitForTelnyxCommands(callControlId, 3);

      expect(commands.map(({ action }) => action)).toEqual([
        "answer",
        "suppression_start",
        "streaming_start",
      ]);
      expectRealtimeStreamFields(commands[2]?.body);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Noise suppression failed to start"),
      );
      expect(runtime.manager.getActiveCalls()).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });
});
