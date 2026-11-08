// Verifies the streaming path aborts the in-flight agent run on caller barge-in.
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeVoiceCallConfig } from "./config.js";
import { FakeProvider } from "./manager.test-harness.js";
import { TwilioProvider } from "./providers/twilio.js";
import type { CallRecord } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

const mocks = vi.hoisted(() => ({
  abortAgentHarnessRun: vi.fn<(sessionId: string) => boolean>(),
}));
vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  abortAgentHarnessRun: mocks.abortAgentHarnessRun,
}));

const PROVIDER_CALL_ID = "provider-call-1";
const STREAM_SID = "stream-1";
const CALL_ID = "call-1";

/** Minimal twilio-shaped provider: getCurrentStream requires a registered stream. */
class StreamProvider extends FakeProvider {
  private readonly streamOwner = new TwilioProvider({
    accountSid: "test-account",
    authToken: "test-auth",
  });
  readonly clearTtsQueue = vi.fn();
  registerCallStream(callId: string, streamId: string) {
    this.streamOwner.registerCallStream(callId, streamId);
  }
  hasRegisteredStream(callId: string, streamId?: string) {
    return this.streamOwner.hasRegisteredStream(callId, streamId);
  }
}

function createServer(abortAgentRun: boolean) {
  const config = normalizeVoiceCallConfig({
    enabled: true,
    provider: "twilio",
    fromNumber: "+15550000000",
    skipSignatureVerification: true,
    streaming: { enabled: true, provider: "test-transcription" },
    bargeIn: { abortAgentRun },
  });
  const call = {
    callId: CALL_ID,
    providerCallId: PROVIDER_CALL_ID,
    direction: "inbound",
    state: "answered",
    from: "+15550001234",
    to: "+15550009999",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {},
  } as unknown as CallRecord;
  const provider = new StreamProvider("twilio");
  provider.registerCallStream(PROVIDER_CALL_ID, STREAM_SID);
  const manager = {
    getCallByProviderCallId: () => call,
    invalidateAutoResponse: vi.fn(),
  };
  const server = new VoiceCallWebhookServer(
    createTestPluginServiceScheduler(),
    config,
    manager as never,
    provider as never,
    {},
    undefined,
    // A real logger stub, not an empty object: the abort coordinator logs on
    // both its success and guarded-failure paths, so a missing method would
    // surface as a TypeError from the logger rather than the behaviour tested.
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  );
  // Private surfaces: the barge-in trigger and the per-call run registry are
  // both internal, and the observable behaviour under test is the abort call.
  const internals = server as unknown as {
    interruptStreamReply: (providerCallId: string, streamSid: string) => symbol | undefined;
    bargeInAgentAbort: {
      trackTurn: (callId: string) => {
        onAgentRunStarted: (run: { sessionId: string; runId: string }) => void;
      };
    };
  };
  const bargeIn = () => internals.interruptStreamReply(PROVIDER_CALL_ID, STREAM_SID);
  const trackRun = () =>
    internals.bargeInAgentAbort.trackTurn(CALL_ID).onAgentRunStarted({
      sessionId: "session-1",
      runId: "voice:call-1:1",
    });
  return { bargeIn, trackRun };
}

beforeEach(() => {
  mocks.abortAgentHarnessRun.mockReset();
  mocks.abortAgentHarnessRun.mockReturnValue(true);
});

describe("streaming barge-in agent-run abort", () => {
  it("aborts the tracked run when the caller barges in", () => {
    const { bargeIn, trackRun } = createServer(true);
    trackRun();

    expect(bargeIn()).toBeDefined();

    expect(mocks.abortAgentHarnessRun).toHaveBeenCalledWith("session-1");
  });

  it("leaves the agent run alone when the opt-in flag is off", () => {
    const { bargeIn, trackRun } = createServer(false);
    trackRun();

    expect(bargeIn()).toBeDefined();

    // Audio-side barge-in still happens; only the agent-run abort is gated.
    expect(mocks.abortAgentHarnessRun).not.toHaveBeenCalled();
  });

  it("attempts no abort for a turn with no run in flight", () => {
    const { bargeIn } = createServer(true);

    expect(bargeIn()).toBeDefined();

    expect(mocks.abortAgentHarnessRun).not.toHaveBeenCalled();
  });

  it("contains an abort that throws so barge-in audio handling still completes", () => {
    const { bargeIn, trackRun } = createServer(true);
    trackRun();
    mocks.abortAgentHarnessRun.mockImplementation(() => {
      throw new Error("run registry exploded");
    });

    // A throw must not escape the inbound transcript path, and barge-in must
    // still return its generation symbol so the reply is revoked.
    expect(() => bargeIn()).not.toThrow();
    expect(bargeIn()).toBeDefined();
  });
});
