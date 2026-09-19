// Voice Call tests cover manager.closed loop plugin behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { describe, expect, it, vi } from "vitest";
import { createManagerHarness, FakeProvider, markCallAnswered } from "./manager.test-harness.js";

function requireTurnToken(provider: Awaited<ReturnType<typeof createManagerHarness>>["provider"]) {
  const firstStart = provider.startListeningCalls[0];
  if (!firstStart?.turnToken) {
    throw new Error("expected closed-loop turn to capture a turn token");
  }
  return firstStart.turnToken;
}

function expectTranscriptWaiter(
  manager: Awaited<ReturnType<typeof createManagerHarness>>["manager"],
  callId: string,
) {
  const waiters = (
    manager as unknown as {
      transcriptWaiters: Map<string, unknown>;
    }
  ).transcriptWaiters;
  expect(waiters.has(callId)).toBe(true);
}

function abandonTurn(
  manager: Awaited<ReturnType<typeof createManagerHarness>>["manager"],
  callId: string,
) {
  const waiters = (
    manager as unknown as {
      transcriptWaiters: Map<string, { reject: (error: Error) => void; timeout: NodeJS.Timeout }>;
    }
  ).transcriptWaiters;
  const waiter = expectDefined(waiters.get(callId), `transcript waiter for ${callId}`);
  clearTimeout(waiter.timeout);
  waiters.delete(callId);
  waiter.reject(new Error("turn abandoned"));
}

describe("CallManager closed-loop turns", () => {
  it("completes a closed-loop turn without live audio", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000003");
    expect(started.success).toBe(true);

    await markCallAnswered(manager, started.callId, "evt-closed-loop-answered");

    const turnPromise = manager.continueCall(started.callId, "How can I help?");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });

    await manager.processEvent({
      id: "evt-closed-loop-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Please check status",
      isFinal: true,
    });

    const turn = await turnPromise;
    expect(turn.success).toBe(true);
    expect(turn.transcript).toBe("Please check status");
    expect(provider.startListeningCalls).toHaveLength(1);
    expect(provider.stopListeningCalls).toHaveLength(1);

    const call = expectDefined(manager.getCall(started.callId), `active call ${started.callId}`);
    expect(call.transcript.map((entry) => entry.text)).toEqual([
      "How can I help?",
      "Please check status",
    ]);
    const metadata = call.metadata ?? {};
    expect(typeof metadata.lastTurnLatencyMs).toBe("number");
    expect(typeof metadata.lastTurnListenWaitMs).toBe("number");
    expect(metadata.turnCount).toBe(1);
  });

  it("rejects overlapping continueCall requests for the same call", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000004");
    expect(started.success).toBe(true);

    await markCallAnswered(manager, started.callId, "evt-overlap-answered");

    const first = manager.continueCall(started.callId, "First prompt");
    const second = await manager.continueCall(started.callId, "Second prompt");
    expect(second.success).toBe(false);
    expect(second.error).toBe("Already waiting for transcript");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });

    await manager.processEvent({
      id: "evt-overlap-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Done",
      isFinal: true,
    });

    const firstResult = await first;
    expect(firstResult.success).toBe(true);
    expect(firstResult.transcript).toBe("Done");
    expect(provider.startListeningCalls).toHaveLength(1);
    expect(provider.stopListeningCalls).toHaveLength(1);
  });

  it("ignores speech events with mismatched turnToken while waiting for transcript", async () => {
    const { manager, provider } = await createManagerHarness(
      {
        transcriptTimeoutMs: 5000,
      },
      new FakeProvider("twilio"),
    );

    const started = await manager.initiateCall("+15550000004");
    expect(started.success).toBe(true);

    await markCallAnswered(manager, started.callId, "evt-turn-token-answered");

    const turnPromise = manager.continueCall(started.callId, "Prompt");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });

    const expectedTurnToken = requireTurnToken(provider);

    const staleResult = await manager.processEvent({
      id: "evt-turn-token-bad",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "stale replay",
      isFinal: true,
      turnToken: "wrong-token",
    });
    expect(staleResult).toEqual({ kind: "ignored" });

    expectTranscriptWaiter(manager, started.callId);

    const finalResult = await manager.processEvent({
      id: "evt-turn-token-good",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "final answer",
      isFinal: true,
      turnToken: expectedTurnToken,
    });
    expect(finalResult).toMatchObject({
      kind: "final-speech",
      transcript: "final answer",
      waiterResolved: true,
    });

    const turnResult = await turnPromise;
    expect(turnResult.success).toBe(true);
    expect(turnResult.transcript).toBe("final answer");

    const call = expectDefined(manager.getCall(started.callId), `active call ${started.callId}`);
    expect(call.transcript.map((entry) => entry.text)).toEqual(["Prompt", "final answer"]);
  });

  it("tracks latency metadata across multiple closed-loop turns", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000005");
    expect(started.success).toBe(true);

    await markCallAnswered(manager, started.callId, "evt-multi-answered");

    const firstTurn = manager.continueCall(started.callId, "First question");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });
    await manager.processEvent({
      id: "evt-multi-speech-1",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "First answer",
      isFinal: true,
    });
    await firstTurn;

    const secondTurn = manager.continueCall(started.callId, "Second question");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(2);
      expectTranscriptWaiter(manager, started.callId);
    });
    await manager.processEvent({
      id: "evt-multi-speech-2",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "Second answer",
      isFinal: true,
    });
    const secondResult = await secondTurn;

    expect(secondResult.success).toBe(true);

    const call = expectDefined(manager.getCall(started.callId), `active call ${started.callId}`);
    expect(call.transcript.map((entry) => entry.text)).toEqual([
      "First question",
      "First answer",
      "Second question",
      "Second answer",
    ]);
    const metadata = call.metadata ?? {};
    expect(metadata.turnCount).toBe(2);
    expect(typeof metadata.lastTurnLatencyMs).toBe("number");
    expect(typeof metadata.lastTurnListenWaitMs).toBe("number");
    expect(provider.startListeningCalls).toHaveLength(2);
    expect(provider.stopListeningCalls).toHaveLength(2);
  });

  it("handles repeated closed-loop turns without waiter churn", async () => {
    const { manager, provider } = await createManagerHarness({
      transcriptTimeoutMs: 5000,
    });

    const started = await manager.initiateCall("+15550000006");
    expect(started.success).toBe(true);

    await markCallAnswered(manager, started.callId, "evt-loop-answered");

    for (let i = 1; i <= 5; i++) {
      const turnPromise = manager.continueCall(started.callId, `Prompt ${i}`);
      await vi.waitFor(() => {
        expect(provider.startListeningCalls).toHaveLength(i);
        expectTranscriptWaiter(manager, started.callId);
      });
      await manager.processEvent({
        id: `evt-loop-speech-${i}`,
        type: "call.speech",
        callId: started.callId,
        providerCallId: "request-uuid",
        timestamp: Date.now(),
        transcript: `Answer ${i}`,
        isFinal: true,
      });
      const result = await turnPromise;
      expect(result.success).toBe(true);
      expect(result.transcript).toBe(`Answer ${i}`);
    }

    const call = expectDefined(manager.getCall(started.callId), `active call ${started.callId}`);
    const metadata = call.metadata ?? {};
    expect(metadata.turnCount).toBe(5);
    expect(provider.startListeningCalls).toHaveLength(5);
    expect(provider.stopListeningCalls).toHaveLength(5);
  });

  it("does not let a late turn answer satisfy the next turn on token-echoing providers", async () => {
    const provider = new FakeProvider("plivo");
    provider.echoesTurnToken = true;
    const { manager } = await createManagerHarness({ transcriptTimeoutMs: 5000 }, provider);

    const started = await manager.initiateCall("+15550000009");
    expect(started.success).toBe(true);
    await markCallAnswered(manager, started.callId, "evt-plivo-stale-answered");

    const firstTurn = manager.continueCall(started.callId, "What is your account number?");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });
    const firstTurnToken = requireTurnToken(provider);
    abandonTurn(manager, started.callId);
    await expect(firstTurn).resolves.toMatchObject({ success: false });

    const secondTurn = manager.continueCall(started.callId, "What is your date of birth?");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(2);
      expectTranscriptWaiter(manager, started.callId);
    });
    const secondTurnToken = expectDefined(
      provider.startListeningCalls[1]?.turnToken,
      "second turn token",
    );
    expect(secondTurnToken).not.toBe(firstTurnToken);

    const staleResult = await manager.processEvent({
      id: "evt-plivo-stale-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "eight six seven five three oh nine",
      isFinal: true,
      turnToken: firstTurnToken,
    });
    expect(staleResult).toEqual({ kind: "ignored" });
    expectTranscriptWaiter(manager, started.callId);

    const liveResult = await manager.processEvent({
      id: "evt-plivo-live-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "First of January",
      isFinal: true,
      turnToken: secondTurnToken,
    });
    expect(liveResult).toMatchObject({
      kind: "final-speech",
      transcript: "First of January",
      waiterResolved: true,
    });

    const secondResult = await secondTurn;
    expect(secondResult.success).toBe(true);
    expect(secondResult.transcript).toBe("First of January");

    const call = expectDefined(manager.getCall(started.callId), `active call ${started.callId}`);
    expect(call.transcript.map((entry) => entry.text)).toEqual([
      "What is your account number?",
      "What is your date of birth?",
      "First of January",
    ]);
  });

  it("completes an ordinary turn on token-echoing providers", async () => {
    const provider = new FakeProvider("plivo");
    provider.echoesTurnToken = true;
    const { manager } = await createManagerHarness({ transcriptTimeoutMs: 5000 }, provider);

    const started = await manager.initiateCall("+15550000010");
    expect(started.success).toBe(true);
    await markCallAnswered(manager, started.callId, "evt-plivo-live-answered");

    const turn = manager.continueCall(started.callId, "What is your account number?");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });

    const result = await manager.processEvent({
      id: "evt-plivo-in-turn-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "eight six seven five three oh nine",
      isFinal: true,
      turnToken: requireTurnToken(provider),
    });
    expect(result).toMatchObject({ kind: "final-speech", waiterResolved: true });

    const turnResult = await turn;
    expect(turnResult.success).toBe(true);
    expect(turnResult.transcript).toBe("eight six seven five three oh nine");
  });

  it("ignores an unattributable final transcript while a turn token waiter is live", async () => {
    const provider = new FakeProvider("plivo");
    provider.echoesTurnToken = true;
    const { manager } = await createManagerHarness({ transcriptTimeoutMs: 5000 }, provider);

    const started = await manager.initiateCall("+15550000012");
    expect(started.success).toBe(true);
    await markCallAnswered(manager, started.callId, "evt-plivo-untagged-answered");

    const turn = manager.continueCall(started.callId, "What is your account number?");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });
    const turnToken = requireTurnToken(provider);

    const untagged = await manager.processEvent({
      id: "evt-plivo-untagged-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "answer to an earlier prompt",
      isFinal: true,
    });
    expect(untagged).toEqual({ kind: "ignored" });
    expectTranscriptWaiter(manager, started.callId);

    await manager.processEvent({
      id: "evt-plivo-tagged-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "eight six seven five three oh nine",
      isFinal: true,
      turnToken,
    });

    const turnResult = await turn;
    expect(turnResult.success).toBe(true);
    expect(turnResult.transcript).toBe("eight six seven five three oh nine");

    const call = expectDefined(manager.getCall(started.callId), `active call ${started.callId}`);
    expect(call.transcript.map((entry) => entry.text)).toEqual([
      "What is your account number?",
      "eight six seven five three oh nine",
    ]);
  });

  it("does not issue a turn token to providers that cannot echo it back", async () => {
    const provider = new FakeProvider("telnyx");
    const { manager } = await createManagerHarness({ transcriptTimeoutMs: 5000 }, provider);

    const started = await manager.initiateCall("+15550000011");
    expect(started.success).toBe(true);
    await markCallAnswered(manager, started.callId, "evt-telnyx-answered");

    const turn = manager.continueCall(started.callId, "What is your account number?");
    await vi.waitFor(() => {
      expect(provider.startListeningCalls).toHaveLength(1);
      expectTranscriptWaiter(manager, started.callId);
    });
    expect(provider.echoesTurnToken).toBe(false);
    expect(provider.startListeningCalls[0]?.turnToken).toBeUndefined();

    await manager.processEvent({
      id: "evt-telnyx-speech",
      type: "call.speech",
      callId: started.callId,
      providerCallId: "request-uuid",
      timestamp: Date.now(),
      transcript: "eight six seven five three oh nine",
      isFinal: true,
    });

    const turnResult = await turn;
    expect(turnResult.success).toBe(true);
    expect(turnResult.transcript).toBe("eight six seven five three oh nine");
  });
});
