import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { createManagerHarness, FakeProvider, markCallAnswered } from "../manager.test-harness.js";
import { findCallInStore } from "../manager/store.js";
import type { NormalizedEvent } from "../types.js";
import { RealtimeCallHandler } from "./realtime-handler.js";
import {
  connectCarrierStream,
  createBridge,
  createRealtimeConfig,
  makeRealtimeProvider,
} from "./realtime-handler.lifecycle.test-helpers.js";
import type { StreamDisconnectLifecycle } from "./stream-disconnect-grace.js";

// The lifecycle harness keeps its own no-op disconnect lifecycle module-private,
// so this test supplies its own rather than importing the helper's binding.
const noOpStreamDisconnectLifecycle: StreamDisconnectLifecycle = {
  connect: () => {},
  disconnect: () => {},
  retire: () => {},
};

/**
 * These cases read the persisted transcript rather than the manager mock, because
 * dialogue order is a property of what the store ends up holding: the handler issues
 * caller and assistant writes without awaiting each other, and only the manager's
 * mutation queue decides the order they land in.
 */
describe("RealtimeCallHandler stored dialogue", () => {
  const gateFailure = new Error("caller turn write failed");

  async function startDialogue(gate?: { transcript: string; mode: "hold" | "fail" }): Promise<{
    callbacks: RealtimeVoiceBridgeCreateRequest;
    close: () => Promise<unknown>;
    consult: (question: string) => Promise<void>;
    gateReached: Promise<void>;
    order: string[];
    readStoredTranscript: () => Promise<string[][] | undefined>;
    release: () => void;
  }> {
    const { manager, storePath } = await createManagerHarness(
      { provider: "twilio", realtime: { enabled: true } },
      new FakeProvider("twilio"),
    );
    const started = await manager.initiateCall("+15550000001");
    expect(started.success).toBe(true);
    await markCallAnswered(manager, started.callId, "answered-stored-dialogue");

    const order: string[] = [];
    const released = createDeferred<void>();
    const gateReached = createDeferred<void>();
    const realProcessEvent = manager.processEvent.bind(manager);
    let pendingGate = gate;
    vi.spyOn(manager, "processEvent").mockImplementation((event: NormalizedEvent) => {
      const matched = pendingGate;
      if (!matched || event.type !== "call.speech" || event.transcript !== matched.transcript) {
        return realProcessEvent(event);
      }
      pendingGate = undefined;
      gateReached.resolve();
      if (matched.mode === "fail") {
        // Never reaches the store, so the turn has to be recovered by the end-of-call flush.
        return released.promise.then(() => {
          throw gateFailure;
        });
      }
      // Enqueue now so the manager still applies this turn in dialogue order, but leave
      // the handler's write pending so shutdown has a queued turn write to wait for.
      const queued = realProcessEvent(event);
      return released.promise.then(async () => {
        const result = await queued;
        order.push("caller-turn-write");
        return result;
      });
    });

    const ready = createDeferred<RealtimeVoiceBridgeCreateRequest>();
    let consultAnswered = createDeferred<void>();
    const realtimeProvider = makeRealtimeProvider((request) => {
      ready.resolve(request);
      return createBridge(() => {}, { submitToolResult: () => consultAnswered.resolve() });
    });
    const handler = new RealtimeCallHandler(
      createRealtimeConfig(),
      manager,
      () => ({
        agentId: "main",
        instructions: "Be helpful.",
        provider: realtimeProvider,
        providerConfig: { apiKey: "test-key" },
        // Native delegation keeps the forced-consult scheduler out of these cases, so
        // the only writes under test are the caller turns and their replies.
        capabilities: {
          transports: ["gateway-relay" as const],
          inputAudioFormats: [],
          outputAudioFormats: [],
          handlesAgentConsult: true,
          supportsBargeIn: false,
          handlesInputAudioBargeIn: false,
        },
      }),
      "/voice/webhook",
      noOpStreamDisconnectLifecycle,
    );
    handler.registerToolHandler("openclaw_agent_consult", async () => ({ text: "Consulted." }));
    // The harness owns ws/server teardown via onTestFinished, so this scope must not
    // close the carrier server itself: a second close rejects with ERR_SERVER_NOT_RUNNING.
    const { ws } = await connectCarrierStream(handler);
    ws.send(
      JSON.stringify({
        event: "start",
        start: { streamSid: "MZ-stored-dialogue", callSid: "request-uuid" },
      }),
    );
    const callbacks = await ready.promise;

    return {
      callbacks,
      close: async () => {
        const outcome = await handler.close().then(
          () => undefined,
          (error: unknown) => error,
        );
        order.push("close");
        return outcome;
      },
      consult: async (question) => {
        consultAnswered = createDeferred<void>();
        callbacks.onToolCall?.({
          itemId: "consult-item",
          callId: "consult-call",
          name: "openclaw_agent_consult",
          args: { question },
        });
        await consultAnswered.promise;
        // The handler spends the consult context right after the provider has its
        // answer; a macrotask turn lets that continuation finish.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      },
      gateReached: gateReached.promise,
      order,
      readStoredTranscript: async () => {
        const stored = await findCallInStore(storePath, started.callId);
        return stored?.transcript.map(({ speaker, text }) => [speaker, text]);
      },
      release: () => released.resolve(),
    };
  }

  /** Two caller turns, each answered, then the provider's single end-of-call flush. */
  function speakDialogue(callbacks: RealtimeVoiceBridgeCreateRequest): void {
    callbacks.onTranscript?.("user", "yes", false);
    callbacks.onTranscript?.("assistant", "First reply", true);
    callbacks.onTranscript?.("user", "okay", false);
    callbacks.onTranscript?.("assistant", "Second reply", true);
    // Google Live streams each input fragment before its end-of-call flush.
    callbacks.onTranscript?.("user", "goodbye", false);
    callbacks.onTranscript?.("user", "yes okay goodbye", true);
  }

  /**
   * Google Live accumulates the caller's input transcript, flushes all of it when the
   * connection ends, and only then notifies close - so a caller turn write still in
   * flight has to survive the close callback for the flush to reduce against it.
   */
  function closeLikeGoogleLive(
    callbacks: RealtimeVoiceBridgeCreateRequest,
    flushedTranscript: string,
  ): void {
    callbacks.onTranscript?.("user", flushedTranscript, true);
    callbacks.onClose?.("completed");
  }

  /**
   * A consult waits for the caller's partials to go quiet. Stamping the partial in the
   * past lets the consult start at once without moving the clock the store writes use.
   */
  function streamSettledCallerPartial(
    callbacks: RealtimeVoiceBridgeCreateRequest,
    text: string,
  ): void {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 1_000);
    try {
      callbacks.onTranscript?.("user", text, false);
    } finally {
      clock.mockRestore();
    }
  }

  it("stores each caller turn ahead of the reply it answered", async () => {
    const dialogue = await startDialogue();
    speakDialogue(dialogue.callbacks);
    dialogue.release();

    expect(await dialogue.close()).toBeUndefined();
    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "yes"],
      ["bot", "First reply"],
      ["user", "okay"],
      ["bot", "Second reply"],
      // The flush restates the whole call; only its uncommitted suffix is stored.
      ["user", "goodbye"],
    ]);
  });

  it("does not store a long caller turn again when the final includes its discarded prefix", async () => {
    const dialogue = await startDialogue();
    const first = "Caller detail. ".repeat(100);
    const second = `${"More detail. ".repeat(100)}Final detail.`;
    dialogue.callbacks.onTranscript?.("user", first, false);
    dialogue.callbacks.onTranscript?.("user", second, false);
    dialogue.callbacks.onTranscript?.("assistant", "Details received", true);
    dialogue.callbacks.onTranscript?.("user", "Goodbye.", false);
    closeLikeGoogleLive(dialogue.callbacks, `${first}${second} Goodbye.`);

    expect(await dialogue.close()).toBeUndefined();
    const stored = await dialogue.readStoredTranscript();
    expect(stored).toEqual([
      // The whole utterance, not just the tail the consult buffer retains.
      ["user", `${first}${second}`],
      ["bot", "Details received"],
      ["user", "Goodbye."],
    ]);
  });

  it("stores a consulted caller turn once when the final restates the call", async () => {
    const dialogue = await startDialogue();
    dialogue.callbacks.onTranscript?.("user", "What is the status?", false);
    dialogue.callbacks.onTranscript?.("assistant", "Checking", true);
    streamSettledCallerPartial(dialogue.callbacks, "Check the deployment.");
    // A completed consult spends its own context, not the deltas the turn is stored from.
    await dialogue.consult("Check the deployment.");
    dialogue.callbacks.onTranscript?.("assistant", "Deployment is healthy", true);
    closeLikeGoogleLive(dialogue.callbacks, "What is the status? Check the deployment.");

    expect(await dialogue.close()).toBeUndefined();
    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "What is the status?"],
      ["bot", "Checking"],
      ["user", "Check the deployment."],
      ["bot", "Deployment is healthy"],
    ]);
  });

  it("preserves words split across provider input transcription frames", async () => {
    const dialogue = await startDialogue();
    // Google Live forwards inputTranscription text fragments without joining them.
    dialogue.callbacks.onTranscript?.("user", "What is the", false);
    dialogue.callbacks.onTranscript?.("user", " ca", false);
    dialogue.callbacks.onTranscript?.("user", "pital", false);
    dialogue.callbacks.onTranscript?.("user", " ", false);
    dialogue.callbacks.onTranscript?.("user", "of France?", false);
    dialogue.callbacks.onTranscript?.("assistant", "Paris", true);
    closeLikeGoogleLive(dialogue.callbacks, "What is the capital of France?");

    expect(await dialogue.close()).toBeUndefined();
    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "What is the capital of France?"],
      ["bot", "Paris"],
    ]);
  });

  it("finishes a queued caller turn write before shutdown completes", async () => {
    const dialogue = await startDialogue({ transcript: "yes", mode: "hold" });
    speakDialogue(dialogue.callbacks);
    await dialogue.gateReached;

    const closing = dialogue.close();
    dialogue.release();
    expect(await closing).toBeUndefined();

    expect(dialogue.order).toEqual(["caller-turn-write", "close"]);
    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "yes"],
      ["bot", "First reply"],
      ["user", "okay"],
      ["bot", "Second reply"],
      ["user", "goodbye"],
    ]);
  });

  it("stores the reply paired with a failed caller turn and recovers that turn at flush", async () => {
    const dialogue = await startDialogue({ transcript: "okay", mode: "fail" });
    speakDialogue(dialogue.callbacks);
    await dialogue.gateReached;
    dialogue.release();

    expect(await dialogue.close()).toBe(gateFailure);
    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "yes"],
      ["bot", "First reply"],
      // "okay" never reached the store, but its reply is still persisted...
      ["bot", "Second reply"],
      // ...and the flush carries the lost turn instead of dropping it.
      ["user", "okay goodbye"],
    ]);
  });

  it("keeps a later stored caller turn out of the flush after an earlier write fails", async () => {
    const dialogue = await startDialogue({ transcript: "okay", mode: "fail" });
    dialogue.callbacks.onTranscript?.("user", "yes", false);
    dialogue.callbacks.onTranscript?.("assistant", "First reply", true);
    dialogue.callbacks.onTranscript?.("user", "okay", false);
    dialogue.callbacks.onTranscript?.("assistant", "Second reply", true);
    dialogue.callbacks.onTranscript?.("user", "goodbye", false);
    dialogue.callbacks.onTranscript?.("assistant", "Third reply", true);
    await dialogue.gateReached;

    closeLikeGoogleLive(dialogue.callbacks, "yes okay goodbye");
    dialogue.release();
    expect(await dialogue.close()).toBe(gateFailure);

    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "yes"],
      ["bot", "First reply"],
      ["bot", "Second reply"],
      ["user", "goodbye"],
      ["bot", "Third reply"],
      // "goodbye" was stored when it arrived, so the flush recovers only the failed turn,
      // which therefore lands after it.
      ["user", "okay"],
    ]);
  });

  it("reduces the Google Live flush against a caller write still pending at close", async () => {
    const dialogue = await startDialogue({ transcript: "yes", mode: "hold" });
    dialogue.callbacks.onTranscript?.("user", "yes", false);
    dialogue.callbacks.onTranscript?.("assistant", "First reply", true);
    dialogue.callbacks.onTranscript?.("user", "goodbye", false);
    await dialogue.gateReached;

    closeLikeGoogleLive(dialogue.callbacks, "yes goodbye");
    dialogue.release();
    await dialogue.close();

    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "yes"],
      ["bot", "First reply"],
      // The flush lands after close, so its reduction still has to see the pending turn.
      ["user", "goodbye"],
    ]);
  });

  it("does not reduce a reconnected provider's flush against the prior session's turns", async () => {
    const dialogue = await startDialogue();
    dialogue.callbacks.onTranscript?.("user", "book a table", false);
    dialogue.callbacks.onTranscript?.("assistant", "First reply", true);
    // A non-resumable reconnect drops the provider's accumulated input transcript, so
    // its end-of-call flush restates only what the replacement session heard.
    dialogue.callbacks.onEvent?.({ direction: "client", type: "session.continuity.reset" });
    dialogue.callbacks.onTranscript?.("user", "for two people", false);
    dialogue.callbacks.onTranscript?.("assistant", "Second reply", true);
    closeLikeGoogleLive(dialogue.callbacks, "for two people");

    expect(await dialogue.close()).toBeUndefined();
    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "book a table"],
      ["bot", "First reply"],
      ["user", "for two people"],
      ["bot", "Second reply"],
    ]);
  });

  it("stores a caller final deferred behind a pending turn write ahead of its reply", async () => {
    const dialogue = await startDialogue({ transcript: "yes", mode: "hold" });
    dialogue.callbacks.onTranscript?.("user", "yes", false);
    dialogue.callbacks.onTranscript?.("assistant", "First reply", true);
    await dialogue.gateReached;
    // The "yes" write is still pending, so this final waits for the ledger to settle;
    // the reply that answers it must not overtake it in the manager queue.
    dialogue.callbacks.onTranscript?.("user", "okay", true);
    dialogue.callbacks.onTranscript?.("assistant", "Second reply", true);
    dialogue.release();
    expect(await dialogue.close()).toBeUndefined();

    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "yes"],
      ["bot", "First reply"],
      ["user", "okay"],
      ["bot", "Second reply"],
    ]);
  });

  it("keeps a repeated caller utterance a provider finalizes on its own", async () => {
    const dialogue = await startDialogue();
    dialogue.callbacks.onTranscript?.("user", "I said yes", false);
    dialogue.callbacks.onTranscript?.("assistant", "First reply", true);
    // A provider that finalizes each utterance restates only that utterance, so this
    // final is new speech even though the committed turn already contains the phrase.
    dialogue.callbacks.onTranscript?.("user", "yes", false);
    dialogue.callbacks.onTranscript?.("user", "yes", true);
    await dialogue.close();

    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "I said yes"],
      ["bot", "First reply"],
      ["user", "yes"],
    ]);
  });

  it("stores repeated per-utterance finals once when each restates a committed turn", async () => {
    const dialogue = await startDialogue();
    dialogue.callbacks.onTranscript?.("user", "I said yes", false);
    dialogue.callbacks.onTranscript?.("assistant", "First reply", true);
    dialogue.callbacks.onTranscript?.("user", "yes", false);
    dialogue.callbacks.onTranscript?.("assistant", "Second reply", true);
    // Both finals arrive late, each restating one committed turn.
    dialogue.callbacks.onTranscript?.("user", "I said yes", true);
    dialogue.callbacks.onTranscript?.("user", "yes", true);
    await dialogue.close();

    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "I said yes"],
      ["bot", "First reply"],
      ["user", "yes"],
      ["bot", "Second reply"],
    ]);
  });

  it("keeps a new caller turn whose text starts with a stored turn", async () => {
    const dialogue = await startDialogue();
    dialogue.callbacks.onTranscript?.("user", "hi", false);
    dialogue.callbacks.onTranscript?.("assistant", "First reply", true);
    // "high" opens with the letters of the stored "hi" but does not restate that turn.
    dialogue.callbacks.onTranscript?.("user", "high", false);
    dialogue.callbacks.onTranscript?.("user", "high", true);
    await dialogue.close();

    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "hi"],
      ["bot", "First reply"],
      ["user", "high"],
    ]);
  });

  it("keeps a new caller utterance that repeats a stored turn exactly", async () => {
    const dialogue = await startDialogue();
    dialogue.callbacks.onTranscript?.("user", "yes", false);
    dialogue.callbacks.onTranscript?.("assistant", "First reply", true);
    // The final covers only the "yes" streamed since the stored turn, so it is new speech.
    dialogue.callbacks.onTranscript?.("user", "yes", false);
    dialogue.callbacks.onTranscript?.("user", "yes", true);
    await dialogue.close();

    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "yes"],
      ["bot", "First reply"],
      ["user", "yes"],
    ]);
  });

  it("keeps a new caller turn that extends a stored turn", async () => {
    const dialogue = await startDialogue();
    dialogue.callbacks.onTranscript?.("user", "hello", false);
    dialogue.callbacks.onTranscript?.("assistant", "First reply", true);
    // A per-utterance final that opens with a stored turn is still one new utterance.
    dialogue.callbacks.onTranscript?.("user", "hello again", false);
    dialogue.callbacks.onTranscript?.("user", "hello again", true);
    await dialogue.close();

    expect(await dialogue.readStoredTranscript()).toEqual([
      ["user", "hello"],
      ["bot", "First reply"],
      ["user", "hello again"],
    ]);
  });
});
