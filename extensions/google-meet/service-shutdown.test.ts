// Google Meet tests cover the registered shutdown service drain behavior.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { MEET_URL } from "./src/test-support/fixtures.test-helpers.js";
import {
  getMeetTool,
  invokeGoogleMeetGatewayMethodForTest,
  noopLogger,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import { testing as googleMeetPluginTesting } from "./test-api.js";

const voiceCallMocks = vi.hoisted(() => ({
  createVoiceCallGateway: vi.fn(
    ({ runtime }: { runtime: { gateway: unknown } }) => runtime.gateway,
  ),
  joinMeetViaVoiceCallGateway: vi.fn(async () => ({
    callId: "call-1",
    dtmfSent: true,
    introSent: true,
  })),
  endMeetVoiceCallGatewayCall: vi.fn(async () => {}),
  getMeetVoiceCallGatewayCall: vi.fn(
    async (): Promise<{
      found: boolean;
      call?: { callId: string; state?: string; endedAt?: number; endReason?: string };
    }> => ({
      found: true,
      call: { callId: "call-1" },
    }),
  ),
  isVoiceCallMissingError: vi.fn((error: unknown) => String(error).includes("Call not found")),
  speakMeetViaVoiceCallGateway: vi.fn(async () => {}),
}));

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
    }): Promise<{
      response: Response;
      release: () => Promise<void>;
    }> => ({
      response: await fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
  };
});

vi.mock("./src/voice-call-gateway.js", () => ({
  createVoiceCallGateway: voiceCallMocks.createVoiceCallGateway,
  joinMeetViaVoiceCallGateway: voiceCallMocks.joinMeetViaVoiceCallGateway,
  endMeetVoiceCallGatewayCall: voiceCallMocks.endMeetVoiceCallGatewayCall,
  getMeetVoiceCallGatewayCall: voiceCallMocks.getMeetVoiceCallGatewayCall,
  isVoiceCallMissingError: voiceCallMocks.isVoiceCallMissingError,
  speakMeetViaVoiceCallGateway: voiceCallMocks.speakMeetViaVoiceCallGateway,
}));

function setup(
  config?: Parameters<typeof setupGoogleMeetPlugin>[1],
  options?: Parameters<typeof setupGoogleMeetPlugin>[2],
) {
  const harness = setupGoogleMeetPlugin(plugin, config, options);
  googleMeetPluginTesting.setCallGatewayFromCliForTests(
    async (method, _opts, params) =>
      (await invokeGoogleMeetGatewayMethodForTest(harness.methods, method, params)) as Record<
        string,
        unknown
      >,
  );
  googleMeetPluginTesting.setPlatformForTests(() => options?.registerPlatform ?? "darwin");
  return harness;
}

describe("google-meet shutdown service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceCallMocks.joinMeetViaVoiceCallGateway.mockResolvedValue({
      callId: "call-1",
      dtmfSent: true,
      introSent: true,
    });
    voiceCallMocks.endMeetVoiceCallGatewayCall.mockResolvedValue(undefined);
    voiceCallMocks.getMeetVoiceCallGatewayCall.mockResolvedValue({
      found: true,
      call: { callId: "call-1" },
    });
    voiceCallMocks.isVoiceCallMissingError.mockImplementation((error: unknown) =>
      String(error).includes("Call not found"),
    );
    voiceCallMocks.speakMeetViaVoiceCallGateway.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    googleMeetPluginTesting.setCallGatewayFromCliForTests();
    googleMeetPluginTesting.setPlatformForTests();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.doUnmock("./src/voice-call-gateway.js");
    vi.resetModules();
  });

  it("registers a shutdown service that leaves active sessions through the leave path", async () => {
    const harness = setup({ defaultTransport: "twilio" });
    const service = harness.services.find((candidate) => candidate.id === "google-meet");
    expect(service?.stop).toBeTypeOf("function");
    const tool = getMeetTool(harness);
    const joined = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
      pin: "123456",
    });
    const sessionId = joined.details.session.id;
    expect(voiceCallMocks.endMeetVoiceCallGatewayCall).not.toHaveBeenCalled();

    await service?.stop?.({} as never);

    expect(voiceCallMocks.endMeetVoiceCallGatewayCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call-1" }),
    );
    const status = (await invokeGoogleMeetGatewayMethodForTest(
      harness.methods,
      "googlemeet.status",
      { sessionId },
    )) as { found: boolean; session?: { state?: string } };
    expect(status.found).toBe(true);
    expect(status.session?.state).toBe("ended");
  });

  it("keeps draining remaining sessions when one leave fails during shutdown", async () => {
    const harness = setup({ defaultTransport: "twilio" });
    const service = harness.services.find((candidate) => candidate.id === "google-meet");
    const tool = getMeetTool(harness);
    await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
      pin: "123456",
    });
    await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/xyz-abcd-efg",
      dialInNumber: "+15551234567",
      pin: "654321",
    });
    voiceCallMocks.endMeetVoiceCallGatewayCall
      .mockRejectedValueOnce(new Error("voice gateway unavailable"))
      .mockResolvedValue(undefined);

    await service?.stop?.({} as never);

    expect(voiceCallMocks.endMeetVoiceCallGatewayCall).toHaveBeenCalledTimes(2);
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("voice gateway unavailable"),
    );
  });

  it("stops cleanly when the runtime was never initialized", async () => {
    const harness = setup({ defaultTransport: "twilio" });
    const service = harness.services.find((candidate) => candidate.id === "google-meet");
    expect(service?.stop).toBeTypeOf("function");

    await service?.stop?.({} as never);

    expect(voiceCallMocks.endMeetVoiceCallGatewayCall).not.toHaveBeenCalled();
  });
});
