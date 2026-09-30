import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  readRealtimeVoiceConsultQuestion,
  type RealtimeVoiceBridge,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "../websocket-test-support.js";
import { WebSocket } from "../websocket.js";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
} from "./realtime-handler.lifecycle.test-helpers.js";

type Callbacks = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];
type ToolResult = Parameters<RealtimeVoiceBridge["submitToolResult"]>;

async function withConsultHarness(
  run: (fixture: {
    transcript: (text: string, isFinal?: boolean) => void;
    consult: (id: string, args: unknown) => Promise<void>;
    dispatched: string[];
    results: ToolResult[];
    release: () => void;
    workingStarted: Promise<void>;
    releaseWorking: () => void;
  }) => Promise<void>,
  options: { holdWorking?: boolean } = {},
) {
  const started = createDeferred<Callbacks>();
  const gate = createDeferred<void>();
  const workingStarted = createDeferred<void>();
  const workingGate = createDeferred<void>();
  let firstWorking = true;
  const results: ToolResult[] = [];
  const dispatched: string[] = [];
  const pending: Promise<void>[] = [];
  const completions = new Map<string, Array<() => void>>();
  const { call, handler } = createCarrierLifecycleHarness((callbacks) => {
    started.resolve(callbacks);
    return createBridge(() => {}, {
      supportsToolResultContinuation: true,
      submitToolResult: (...result) => {
        results.push(result);
        if (result[2]?.willContinue && firstWorking) {
          firstWorking = false;
          workingStarted.resolve();
          if (options.holdWorking) {
            return workingGate.promise;
          }
        }
        if (!result[2]?.willContinue) {
          completions.get(result[0])?.shift()?.();
        }
        return undefined;
      },
    });
  });
  handler.registerToolHandler("openclaw_agent_consult", async (args) => {
    const question = readRealtimeVoiceConsultQuestion(args) ?? "missing question";
    dispatched.push(question);
    if (dispatched.length === 1) {
      await gate.promise;
    }
    return { text: `ANSWER FOR: ${question}` };
  });
  const { server, ws } = await connectCarrierStream(handler);
  try {
    ws.send(
      JSON.stringify({
        event: "start",
        start: { streamSid: "MZ-consult-identity", callSid: call.providerCallId },
      }),
    );
    const callbacks = await withTimeout(started.promise);
    await run({
      transcript: (text, isFinal = false) => callbacks.onTranscript?.("user", text, isFinal),
      consult: (id, args) => {
        const completed = createDeferred<void>();
        const waiting = completions.get(id) ?? [];
        waiting.push(() => completed.resolve());
        completions.set(id, waiting);
        // Provider callbacks are notifications, not completion promises. Observe the
        // actual final result, then let its synchronous owner's cleanup finish.
        const operation = completed.promise.then(
          () =>
            new Promise<void>((resolve) => {
              setImmediate(resolve);
            }),
        );
        pending.push(operation);
        callbacks.onToolCall?.({
          itemId: id,
          callId: id,
          name: "openclaw_agent_consult",
          args,
        });
        return operation;
      },
      dispatched,
      results,
      release: () => gate.resolve(),
      workingStarted: workingStarted.promise,
      releaseWorking: () => workingGate.resolve(),
    });
  } finally {
    workingGate.resolve();
    gate.resolve();
    try {
      await withTimeout(Promise.allSettled(pending));
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      try {
        await handler.close();
      } finally {
        await server.close();
      }
    }
  }
}

function finalResults(results: ToolResult[], id: string) {
  return results
    .filter(([callId, , options]) => callId === id && !options?.willContinue)
    .map(([, result]) => result);
}

describe("native consult invocation identity", () => {
  it("does not replace an empty admission snapshot with a later invocation's speech", async () => {
    await withConsultHarness(
      async ({ transcript, consult, dispatched, release, workingStarted, releaseWorking }) => {
        const questionA = "Check the full independent initial request without a transcript.";
        const questionB = "Inspect the subsequent request and report its own separate result.";
        const first = consult("empty-A", { question: questionA });
        await withTimeout(workingStarted);
        transcript(questionB);
        await consult("empty-B", { question: "report" });
        releaseWorking();
        await vi.waitFor(() => expect(dispatched).toEqual([questionA]));
        release();
        await first;
        await consult("empty-B-retry", { question: "report" });
        expect(dispatched).toEqual([questionA, questionB]);
      },
      { holdWorking: true },
    );
  });

  it("keeps transcript settling open for an exact invocation replay", async () => {
    await withConsultHarness(
      async ({
        transcript,
        consult,
        dispatched,
        results,
        release,
        workingStarted,
        releaseWorking,
      }) => {
        const question = "Please inspect the first dataset and return its annual sales report.";
        transcript("Please inspect the first");
        const first = consult("replay-settling", { question: "report" });
        await withTimeout(workingStarted);
        const replay = consult("replay-settling", { question: "report" });
        transcript(" dataset and return its annual sales report.");
        releaseWorking();
        await vi.waitFor(() => expect(dispatched).toEqual([question]));
        release();
        await Promise.all([first, replay]);
        expect(dispatched).toHaveLength(1);
        expect(finalResults(results, "replay-settling")).toEqual([
          { text: `ANSWER FOR: ${question}` },
          { text: `ANSWER FOR: ${question}` },
        ]);
      },
      { holdWorking: true },
    );
  });

  it.each([false, true])(
    "preserves a later transcript during a pending working response (final=%s)",
    async (isFinal) => {
      await withConsultHarness(
        async ({
          transcript,
          consult,
          dispatched,
          results,
          release,
          workingStarted,
          releaseWorking,
        }) => {
          const questionA = "Please inspect the first dataset and return its annual sales report.";
          const questionB = "Now inspect the second dataset and return its all-time sales report.";
          transcript(questionA);
          const first = consult("settling-A", { question: "report" });
          await withTimeout(workingStarted);
          expect(dispatched).toEqual([]);
          transcript(` ${questionB}`, isFinal);
          await consult("settling-B", { question: "report" });
          expect(finalResults(results, "settling-B")).toEqual([
            expect.objectContaining({ status: "busy", started: false, retryable: true }),
          ]);
          expect(results.filter(([id]) => id === "settling-B")).toHaveLength(1);
          releaseWorking();
          await vi.waitFor(() => expect(dispatched).toHaveLength(1));
          expect.soft(dispatched).toEqual([questionA]);
          release();
          await first;
          await consult("settling-B-retry", { question: "report" });
          expect.soft(dispatched).toEqual([questionA, questionB]);
          expect(finalResults(results, "settling-B-retry")).toEqual([
            { text: `ANSWER FOR: ${questionB}` },
          ]);
        },
        { holdWorking: true },
      );
    },
  );

  it.each([
    { label: "different questions", second: { question: "Inspect Dataset B instead." } },
    { label: "equal questions on new invocations", second: { question: "Inspect Dataset A." } },
    { label: "changed context", second: { question: "Inspect Dataset A.", context: "Dataset B" } },
    {
      label: "changed confirmation",
      second: { question: "Inspect Dataset A.", confirmationId: "new-confirmation" },
    },
  ])("rejects $label while the original invocation is pending", async ({ second }) => {
    await withConsultHarness(async ({ consult, dispatched, results, release }) => {
      const first = consult("consult-A", { question: "Inspect Dataset A." });
      await vi.waitFor(() => expect(dispatched).toEqual(["Inspect Dataset A."]));
      const next = consult("consult-B", second);
      const rejectedBeforeFirstCompleted = await withTimeout(next).then(
        () => true,
        () => false,
      );
      expect.soft(rejectedBeforeFirstCompleted).toBe(true);
      expect
        .soft(finalResults(results, "consult-B"))
        .toEqual([expect.objectContaining({ status: "busy", started: false, retryable: true })]);
      expect.soft(results.filter(([id]) => id === "consult-B")).toHaveLength(1);
      expect
        .soft(results.some(([id, , options]) => id === "consult-B" && options?.willContinue))
        .toBe(false);
      release();
      await Promise.all([first, next]);
      expect(dispatched).toEqual(["Inspect Dataset A."]);
      expect
        .soft(finalResults(results, "consult-B"))
        .not.toContainEqual({ text: "ANSWER FOR: Inspect Dataset A." });
      await consult("consult-B-retry", second);
      expect(dispatched).toEqual(["Inspect Dataset A.", second.question]);
      expect(finalResults(results, "consult-B-retry")).toEqual([
        { text: `ANSWER FOR: ${second.question}` },
      ]);
    });
  });

  it("does not equate the same short arguments across different settled transcripts", async () => {
    await withConsultHarness(async ({ transcript, consult, dispatched, results, release }) => {
      const questionA = "Please inspect the first dataset and return its annual sales report.";
      const questionB = "Now inspect the second dataset and return its all-time sales report.";
      transcript(questionA);
      const first = consult("transcript-A", { question: "report" });
      await vi.waitFor(() => expect(dispatched).toEqual([questionA]));
      transcript(questionB);
      const second = consult("transcript-B", { question: "report" });
      const rejectedBeforeFirstCompleted = await withTimeout(second).then(
        () => true,
        () => false,
      );
      expect.soft(rejectedBeforeFirstCompleted).toBe(true);
      expect
        .soft(finalResults(results, "transcript-B"))
        .toEqual([expect.objectContaining({ status: "busy", started: false, retryable: true })]);
      expect.soft(results.filter(([id]) => id === "transcript-B")).toHaveLength(1);
      expect
        .soft(results.some(([id, , options]) => id === "transcript-B" && options?.willContinue))
        .toBe(false);
      release();
      await Promise.all([first, second]);
      expect
        .soft(finalResults(results, "transcript-B"))
        .not.toContainEqual({ text: `ANSWER FOR: ${questionA}` });
      await consult("transcript-B-retry", { question: "report" });
      expect(dispatched).toEqual([questionA, questionB]);
      expect(finalResults(results, "transcript-B-retry")).toEqual([
        { text: `ANSWER FOR: ${questionB}` },
      ]);
      console.info(
        "VOICE_CONSULT_TRANSCRIPT_IDENTITY",
        JSON.stringify({
          dispatched,
          first: finalResults(results, "transcript-A"),
          rejected: finalResults(results, "transcript-B"),
          retry: finalResults(results, "transcript-B-retry"),
        }),
      );
    });
  });

  it("shares a replay of the same provider invocation without dispatching twice", async () => {
    await withConsultHarness(async ({ consult, dispatched, results, release }) => {
      const first = consult("same-invocation", { question: "Inspect Dataset A." });
      await vi.waitFor(() => expect(dispatched).toEqual(["Inspect Dataset A."]));
      const replay = consult("same-invocation", { question: "Inspect Dataset A." });
      release();
      await Promise.all([first, replay]);
      expect(dispatched).toEqual(["Inspect Dataset A."]);
      expect(finalResults(results, "same-invocation")).toEqual([
        { text: "ANSWER FOR: Inspect Dataset A." },
        { text: "ANSWER FOR: Inspect Dataset A." },
      ]);
    });
  });
});
