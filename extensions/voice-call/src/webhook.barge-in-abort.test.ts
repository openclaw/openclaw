// Verifies the streaming path aborts the in-flight agent run on caller barge-in,
// and that cancellation follows call ownership rather than the session.
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { normalizeVoiceCallConfig } from "./config.js";
import { FakeProvider } from "./manager.test-harness.js";
import { TwilioProvider } from "./providers/twilio.js";
import type { CallRecord } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

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

type TestCall = { callId: string; providerCallId: string; streamSid: string };

const CALL_A: TestCall = {
  callId: "call-1",
  providerCallId: "provider-call-1",
  streamSid: "stream-1",
};
// Second concurrent call: supported via maxConcurrentCalls > 1.
const CALL_B: TestCall = {
  callId: "call-2",
  providerCallId: "provider-call-2",
  streamSid: "stream-2",
};

function callRecord(call: TestCall): CallRecord {
  return {
    callId: call.callId,
    providerCallId: call.providerCallId,
    direction: "inbound",
    state: "answered",
    from: "+15550001234",
    to: "+15550009999",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {},
  } as unknown as CallRecord;
}

function createServer(abortAgentRun: boolean, calls: TestCall[] = [CALL_A]) {
  const config = normalizeVoiceCallConfig({
    enabled: true,
    provider: "twilio",
    fromNumber: "+15550000000",
    skipSignatureVerification: true,
    streaming: { enabled: true, provider: "test-transcription" },
    // Shared sessions are reachable in supported configurations, so the
    // fixture models them rather than assuming one call per session.
    maxConcurrentCalls: calls.length,
    sessionScope: "main",
    bargeIn: { abortAgentRun },
  });
  const records = new Map(calls.map((call) => [call.providerCallId, callRecord(call)]));
  const provider = new StreamProvider("twilio");
  for (const call of calls) {
    provider.registerCallStream(call.providerCallId, call.streamSid);
  }
  const manager = {
    // Resolve the real record per provider call id: returning one shared record
    // would hide exactly the cross-call confusion under test.
    getCallByProviderCallId: (providerCallId: string) => records.get(providerCallId),
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
    bargeIn: {
      registerRun: (
        callId: string,
        run: { sessionId: string; runId: string; abort: () => void },
      ) => () => void;
    };
  };
  const bargeIn = (call: TestCall = CALL_A) =>
    internals.interruptStreamReply(call.providerCallId, call.streamSid);
  /** Registers a run for `call` and hands back its abort spy and cleanup. */
  const trackRun = (call: TestCall = CALL_A, runId = `voice:${call.callId}:1`) => {
    const abort = vi.fn();
    // One shared session id for every call: sessionScope "main" collapses them.
    const release = internals.bargeIn.registerRun(call.callId, {
      sessionId: "session-1",
      runId,
      abort,
    });
    return { abort, release };
  };
  return { bargeIn, trackRun };
}

describe("streaming barge-in agent-run abort", () => {
  it("aborts the tracked run when the caller barges in", () => {
    const { bargeIn, trackRun } = createServer(true);
    const { abort } = trackRun();

    expect(bargeIn()).toBeDefined();

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("leaves the agent run alone when the opt-in flag is off", () => {
    const { bargeIn, trackRun } = createServer(false);
    const { abort } = trackRun();

    expect(bargeIn()).toBeDefined();

    // Audio-side barge-in still happens; only the agent-run abort is gated.
    expect(abort).not.toHaveBeenCalled();
  });

  it("attempts no abort for a turn with no run in flight", () => {
    const { bargeIn } = createServer(true);

    expect(bargeIn()).toBeDefined();
  });

  it("contains an abort that throws so barge-in audio handling still completes", () => {
    const { bargeIn, trackRun } = createServer(true);
    trackRun(CALL_A, "voice:call-1:throws").abort.mockImplementation(() => {
      throw new Error("run registry exploded");
    });

    // A throw must not escape the inbound transcript path, and barge-in must
    // still return its generation symbol so the reply is revoked.
    expect(() => bargeIn()).not.toThrow();
  });

  it("aborts only the interrupting call's run when two calls share a session", () => {
    const { bargeIn, trackRun } = createServer(true, [CALL_A, CALL_B]);
    const runA = trackRun(CALL_A);
    const runB = trackRun(CALL_B);

    expect(bargeIn(CALL_A)).toBeDefined();

    // The defect this pins: a session-keyed abort resolves whichever turn owns
    // the shared session and can cancel the sibling call's accepted work.
    expect(runA.abort).toHaveBeenCalledTimes(1);
    expect(runB.abort).not.toHaveBeenCalled();
  });

  it("keeps the replacement run abortable after a superseded turn settles", () => {
    const { bargeIn, trackRun } = createServer(true);
    const first = trackRun(CALL_A, "voice:call-1:1");
    const second = trackRun(CALL_A, "voice:call-1:2");

    // The superseded response settles late and runs its own cleanup.
    first.release();

    expect(bargeIn()).toBeDefined();

    expect(second.abort).toHaveBeenCalledTimes(1);
    expect(first.abort).not.toHaveBeenCalled();
  });

  it("retires the run's authority once its own response settles", () => {
    const { bargeIn, trackRun } = createServer(true);
    const { abort, release } = trackRun();

    release();

    expect(bargeIn()).toBeDefined();
    expect(abort).not.toHaveBeenCalled();
  });
});
