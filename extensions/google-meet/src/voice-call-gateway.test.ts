import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import { joinMeetViaVoiceCallGateway } from "./voice-call-gateway.js";

const gatewayMocks = vi.hoisted(() => ({
  request: vi.fn(),
  stopAndWait: vi.fn(async () => {}),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({ ready: true, aborted: false })),
  dispatchPluginGatewayRequest: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  GatewayClient: vi.fn(function MockGatewayClient(params: { onHelloOk?: () => void }) {
    queueMicrotask(() => params.onHelloOk?.());
    return {
      request: gatewayMocks.request,
      stopAndWait: gatewayMocks.stopAndWait,
    };
  }),
  startGatewayClientWhenEventLoopReady: gatewayMocks.startGatewayClientWhenEventLoopReady,
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  dispatchPluginGatewayRequest: gatewayMocks.dispatchPluginGatewayRequest,
}));

describe("Google Meet voice-call gateway", () => {
  beforeEach(() => {
    vi.useRealTimers();
    gatewayMocks.request.mockReset();
    gatewayMocks.request.mockResolvedValue({ success: true });
    gatewayMocks.stopAndWait.mockClear();
    gatewayMocks.startGatewayClientWhenEventLoopReady.mockClear();
    gatewayMocks.dispatchPluginGatewayRequest.mockReset();
    gatewayMocks.dispatchPluginGatewayRequest.mockResolvedValue({ callId: "call-1" });
  });

  it("starts Twilio Meet calls with pre-connect DTMF, then speaks the intro without TwiML fallback", async () => {
    const config = resolveGoogleMeetConfig({
      voiceCall: {
        gatewayUrl: "ws://127.0.0.1:18789",
        dtmfDelayMs: 1,
        postDtmfSpeechDelayMs: 2,
      },
      realtime: { introMessage: "Say exactly: I'm here and listening." },
    });

    const join = joinMeetViaVoiceCallGateway({
      config,
      dialInNumber: "+15551234567",
      dtmfSequence: "123456#",
      message: "Say exactly: I'm here and listening.",
      requesterSessionKey: "agent:main:discord:channel:general",
      sessionKey: "voice:google-meet:meet-1",
    });

    await join;

    expect(gatewayMocks.dispatchPluginGatewayRequest).toHaveBeenCalledWith(
      "voicecall.start",
      {
        to: "+15551234567",
        mode: "conversation",
        dtmfSequence: "123456#",
        requesterSessionKey: "agent:main:discord:channel:general",
        sessionKey: "voice:google-meet:meet-1",
      },
      { pluginRuntimeOwnerId: "google-meet" },
    );
    expect(gatewayMocks.dispatchPluginGatewayRequest).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.request).toHaveBeenNthCalledWith(
      1,
      "voicecall.speak",
      {
        callId: "call-1",
        allowTwimlFallback: false,
        message: "Say exactly: I'm here and listening.",
      },
      { timeoutMs: 30_000 },
    );
    expect(gatewayMocks.request).toHaveBeenCalledTimes(1);
  });

  it("forwards agentId and sessionKey on the voicecall.start RPC payload", async () => {
    const config = resolveGoogleMeetConfig({
      voiceCall: {
        gatewayUrl: "ws://127.0.0.1:18789",
        dtmfDelayMs: 0,
        postDtmfSpeechDelayMs: 0,
      },
    });

    await joinMeetViaVoiceCallGateway({
      config,
      dialInNumber: "+15551234567",
      agentId: "slack-u123",
      sessionKey: "agent:slack-u123:google-meet:meet_42",
    });

    expect(gatewayMocks.dispatchPluginGatewayRequest).toHaveBeenCalledWith(
      "voicecall.start",
      {
        to: "+15551234567",
        mode: "conversation",
        agentId: "slack-u123",
        sessionKey: "agent:slack-u123:google-meet:meet_42",
      },
      { pluginRuntimeOwnerId: "google-meet" },
    );
  });

  it("omits agentId and sessionKey when not provided (back-compat)", async () => {
    const config = resolveGoogleMeetConfig({
      voiceCall: {
        gatewayUrl: "ws://127.0.0.1:18789",
        dtmfDelayMs: 0,
        postDtmfSpeechDelayMs: 0,
      },
    });

    await joinMeetViaVoiceCallGateway({
      config,
      dialInNumber: "+15551234567",
    });

    expect(gatewayMocks.dispatchPluginGatewayRequest).toHaveBeenCalledWith(
      "voicecall.start",
      {
        to: "+15551234567",
        mode: "conversation",
      },
      { pluginRuntimeOwnerId: "google-meet" },
    );
  });

  it("skips the intro without failing when the realtime bridge is not ready", async () => {
    gatewayMocks.dispatchPluginGatewayRequest.mockResolvedValueOnce({ callId: "call-1" });
    gatewayMocks.request.mockResolvedValueOnce({
      success: false,
      error: "No active realtime bridge for call",
    });
    const config = resolveGoogleMeetConfig({
      voiceCall: {
        gatewayUrl: "ws://127.0.0.1:18789",
        dtmfDelayMs: 1,
        postDtmfSpeechDelayMs: 1,
      },
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const result = await joinMeetViaVoiceCallGateway({
      config,
      dialInNumber: "+15551234567",
      dtmfSequence: "123456#",
      logger,
      message: "Say exactly: I'm here and listening.",
    });

    expect(result).toMatchObject({ callId: "call-1", dtmfSent: true, introSent: false });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipped intro speech because realtime bridge was not ready"),
    );
  });
});
