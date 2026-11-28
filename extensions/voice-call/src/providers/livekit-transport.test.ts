import { afterEach, expect, it, vi } from "vitest";
import { normalizeVoiceCallConfig } from "../config.js";
import { LiveKitProvider } from "./livekit.js";

const clients = vi.hoisted(() => ({ rooms: vi.fn(), sip: vi.fn() }));
vi.mock("livekit-server-sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("livekit-server-sdk")>();
  return {
    ...sdk,
    RoomServiceClient: class extends sdk.RoomServiceClient {
      constructor(...args: ConstructorParameters<typeof sdk.RoomServiceClient>) {
        super(...args);
        clients.rooms(...args);
      }
    },
    SipClient: class extends sdk.SipClient {
      constructor(...args: ConstructorParameters<typeof sdk.SipClient>) {
        super(...args);
        clients.sip(...args);
      }
    },
  };
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it.each([
  ["wss://livekit.example.test:7880", false, "https://livekit.example.test:7880"],
  ["ws://10.0.0.1:7880", true, "http://10.0.0.1:7880"],
  ["WSS://livekit.example.test:7880", false, "https://livekit.example.test:7880"],
  ["WS://10.0.0.1:7880", true, "http://10.0.0.1:7880"],
])("maps %s to the matching SDK API transport", async (url, allowInsecureWs, host) => {
  const config = normalizeVoiceCallConfig({
    livekit: {
      url,
      allowInsecureWs,
      apiKey: "synthetic-livekit-key",
      apiSecret: "synthetic-livekit-secret-for-offline-tests",
      outboundTrunkId: "ST_out",
      inboundTrunkIds: ["ST_in"],
    },
  }).livekit!;
  const provider = new LiveKitProvider(config);
  expect(clients.rooms).toHaveBeenCalledWith(host, config.apiKey, config.apiSecret);
  expect(clients.sip).toHaveBeenCalledWith(host, config.apiKey, config.apiSecret);
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('{"participants":[]}', {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await provider.getCallStatus({ providerCallId: "openclaw-call-offline" })).toMatchObject({
    status: "completed",
    isTerminal: true,
  });
  const request = fetch.mock.calls[0]?.[0];
  const requestUrl =
    request instanceof URL ? request.href : typeof request === "string" ? request : request?.url;
  expect(requestUrl).toBe(`${host}/twirp/livekit.RoomService/ListParticipants`);
  const unsigned = await provider.verifyWebhook({
    headers: {},
    rawBody: "{}",
    method: "POST",
    url: "https://voice.example.test/webhook",
  });
  expect(unsigned.ok).toBe(false);
  await provider.stop();
});
