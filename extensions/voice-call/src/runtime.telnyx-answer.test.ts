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

const apiMocks = vi.hoisted(() => ({ fetchWithSsrFGuard: vi.fn<typeof fetchWithSsrFGuard>() }));

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

async function startRuntime(
  noiseSuppression?: NonNullable<VoiceCallConfig["telnyx"]>["noiseSuppression"],
): Promise<VoiceCallRuntime> {
  const base = createVoiceCallBaseConfig({ provider: "telnyx" });
  return createVoiceCallRuntime({
    scheduler: createTestPluginServiceScheduler(),
    config: {
      ...base,
      store: createTestStorePath(),
      publicUrl: "https://voice.example.test/voice/webhook",
      serve: { ...base.serve, port: 0 },
      inboundPolicy: "open",
      staleCallReaperSeconds: 0,
      skipSignatureVerification: true,
      realtime: { ...base.realtime, enabled: true },
      telnyx: { apiKey: "KEY123", connectionId: "CONN456", noiseSuppression },
    },
    coreConfig: { agents: { entries: { main: {} } } } as OpenClawConfig,
    agentRuntime: {} as never,
    stateRuntime: createVoiceCallStateRuntimeForTests(),
  });
}

/** POST a Telnyx `call.initiated` webhook for a new inbound call and return its call control ID. */
async function deliverInboundCall(runtime: VoiceCallRuntime): Promise<string> {
  const callControlId = `v3:${crypto.randomUUID()}`;
  const response = await fetch(await runtime.webhookServer.start(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      data: {
        id: crypto.randomUUID(),
        event_type: "call.initiated",
        payload: { call_control_id: callControlId, direction: "incoming", from: "+15550009999" },
      },
    }),
  });
  expect(response.status).toBe(200);
  return callControlId;
}

/** Wait for `count` Telnyx commands for the call; return each action with its parsed body. */
async function waitForCommands(callControlId: string, count: number) {
  const timeout = 3_000;
  await vi.waitFor(() => expect(apiMocks.fetchWithSsrFGuard).toHaveBeenCalledTimes(count), {
    timeout,
  });
  const prefix = `https://api.telnyx.com/v2/calls/${callControlId}/actions/`;
  return apiMocks.fetchWithSsrFGuard.mock.calls.map(([{ url, init }]) => {
    expect(url.startsWith(prefix)).toBe(true);
    const body = (init as { body?: string } | undefined)?.body;
    return {
      action: url.slice(prefix.length),
      body: body ? (JSON.parse(body) as object) : undefined,
    };
  });
}

const STREAM_FIELDS = {
  stream_url: expect.stringMatching(/^wss:\/\/voice\.example\.test\/voice\/stream\/realtime\//),
  stream_track: "inbound_track",
  stream_bidirectional_mode: "rtp",
  stream_auth_token: expect.any(String),
};

describe("voice-call runtime answering inbound Telnyx realtime calls", () => {
  it.each([
    {
      name: "answers with the stream inline when noise suppression is not configured",
      actions: ["answer"],
    },
    {
      name: "starts Krisp suppression between the stream-less answer and streaming_start",
      noiseSuppression: {
        direction: "outbound",
        engine: "Krisp",
        engineConfig: { model: "krisp-viva-tel-lite-v1.kef", suppressionLevel: 100 },
      },
      actions: ["answer", "suppression_start", "streaming_start"],
      suppressionBody: {
        command_id: expect.stringMatching(/^openclaw-suppression-/),
        direction: "outbound",
        noise_suppression_engine: "Krisp",
        noise_suppression_engine_config: {
          model: "krisp-viva-tel-lite-v1.kef",
          suppression_level: 100,
        },
      },
    },
    {
      name: "keeps the call and streams without suppression when Telnyx rejects suppression_start",
      noiseSuppression: { direction: "outbound", engine: "Krisp" },
      reject: "suppression_start",
      actions: ["answer", "suppression_start", "streaming_start"],
      warning: "Noise suppression failed to start",
    },
  ] as const)("$name", async ({ noiseSuppression, reject, actions, suppressionBody, warning }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    apiMocks.fetchWithSsrFGuard.mockImplementation(async ({ url }) => ({
      response:
        reject && url.endsWith(`/${reject}`)
          ? new Response(JSON.stringify({ errors: [{ code: "90045" }] }), { status: 422 })
          : new Response(JSON.stringify({ data: {} }), { status: 200 }),
      finalUrl: url,
      release: vi.fn(async () => {}),
    }));
    const runtime = await startRuntime(noiseSuppression);
    try {
      const commands = await waitForCommands(await deliverInboundCall(runtime), actions.length);

      expect(commands.map((command) => command.action)).toEqual(actions);
      // The stream fields ride on the only answer when unset, otherwise on streaming_start.
      expect(commands.at(-1)?.body).toMatchObject(STREAM_FIELDS);
      if (suppressionBody) {
        expect(commands[0]?.body).not.toHaveProperty("stream_url");
        expect(commands[1]?.body).toEqual(suppressionBody);
      }
      if (warning) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(warning));
      }
      expect(runtime.manager.getActiveCalls()).toHaveLength(1);
    } finally {
      await runtime.stop();
    }
  });
});
