import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeCallHandler } from "./realtime-handler.js";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
  makeRealtimeProvider,
} from "./realtime-handler.lifecycle.test-helpers.js";

type ToolHandler = Parameters<RealtimeCallHandler["registerToolHandler"]>[1];
type ProviderRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

async function createConsultFixture(delegation = false) {
  const providers: Array<{
    request: ProviderRequest;
    submit: ReturnType<typeof vi.fn<RealtimeVoiceBridge["submitToolResult"]>>;
  }> = [];
  let connected = createDeferred<void>();
  const realtimeProvider = makeRealtimeProvider((request) => {
    const submit = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
    providers.push({ request, submit });
    connected.resolve();
    return createBridge(vi.fn(), {
      supportsToolResultContinuation: true,
      submitToolResult: submit,
    });
  });
  const { handler, call, processEvent } = createCarrierLifecycleHarness(
    realtimeProvider.createBridge,
    delegation
      ? {
          resolveCallRegistration: () => ({
            agentId: "main",
            instructions: "Help the caller.",
            provider: realtimeProvider,
            providerConfig: {},
            capabilities: {
              transports: ["gateway-relay"],
              inputAudioFormats: [],
              outputAudioFormats: [],
              handlesAgentConsult: true,
            },
          }),
        }
      : {},
  );
  const consult = vi.fn<ToolHandler>();
  handler.registerToolHandler("openclaw_agent_consult", consult);
  const connect = async () => {
    const index = providers.length;
    connected = createDeferred<void>();
    const connection = await connectCarrierStream(handler);
    connection.ws.send(
      JSON.stringify({
        event: "start",
        start: { streamSid: `MZ-consult-${index}`, callSid: call.providerCallId },
      }),
    );
    await connected.promise;
    const provider = expectDefined(providers[index], "realtime provider callbacks");
    return {
      ...provider,
      invoke: (id: string, args: unknown) => {
        provider.request.onToolCall?.({
          itemId: `item-${id}`,
          callId: id,
          name: "openclaw_agent_consult",
          args,
        });
      },
      finalResults: (id: string) =>
        provider.submit.mock.calls.filter(
          ([callId, , options]) => callId === id && !options?.willContinue,
        ),
    };
  };
  return { handler, consult, connect, processEvent, provider: await connect() };
}

describe("native realtime consult request identity", () => {
  it("shares one pending consult only for a replay of the same invocation", async () => {
    const { consult, provider } = await createConsultFixture();
    const pending = createDeferred<unknown>();
    consult.mockImplementation(() => pending.promise);
    provider.invoke("first", { question: "Check Dataset A.", context: "2025" });
    await vi.waitFor(() => expect(consult).toHaveBeenCalledOnce(), { interval: 1 });
    provider.invoke("first", { question: "Check Dataset A.", context: "2025" });
    await vi.waitFor(() => expect(provider.submit).toHaveBeenCalledTimes(2), { interval: 1 });

    pending.resolve({ text: "Dataset A has 12 records." });
    await vi.waitFor(() => expect(provider.finalResults("first")).toHaveLength(2), {
      interval: 1,
    });
    expect(consult).toHaveBeenCalledOnce();
    expect(provider.finalResults("first")).toEqual([
      ["first", { text: "Dataset A has 12 records." }, undefined],
      ["first", { text: "Dataset A has 12 records." }, undefined],
    ]);
  });

  it.each([
    {
      label: "invocation ID with identical arguments",
      args: { question: "Check Dataset A.", context: "2025" },
    },
    {
      label: "invocation ID with equivalent arguments",
      args: { prompt: " Check Dataset A. ", context: "2025" },
    },
    { label: "question", args: { question: "Check Dataset B.", context: "2025" } },
    { label: "context", args: { question: "Check Dataset A.", context: "all time" } },
    { label: "removed context", args: { question: "Check Dataset A." } },
    { label: "case-sensitive value", args: { question: "Check dataset a.", context: "2025" } },
    {
      label: "response style",
      args: { question: "Check Dataset A.", context: "2025", responseStyle: "Give exact totals." },
    },
    {
      label: "confirmation",
      args: { question: "Check Dataset A.", context: "2025", confirmationId: "new-confirmation" },
    },
  ])("rejects an overlapping different $label and accepts its later retry", async ({ args }) => {
    const { consult, provider } = await createConsultFixture();
    const first = createDeferred<unknown>();
    consult
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ text: "Answer for the retried request." });
    provider.invoke("first", { question: "Check Dataset A.", context: "2025" });
    await vi.waitFor(() => expect(consult).toHaveBeenCalledOnce(), { interval: 1 });
    provider.invoke("different", args);
    await vi.waitFor(
      () => expect(provider.submit.mock.calls.some(([id]) => id === "different")).toBe(true),
      { interval: 1 },
    );
    const overlappingSubmissions = provider.submit.mock.calls.filter(([id]) => id === "different");
    expect(consult).toHaveBeenCalledOnce();

    first.resolve({ text: "Answer only for Dataset A in 2025." });
    await vi.waitFor(() => expect(provider.finalResults("first")).toHaveLength(1), { interval: 1 });
    await vi.waitFor(() => expect(provider.finalResults("different")).toHaveLength(1), {
      interval: 1,
    });
    const busy = {
      status: "busy",
      started: false,
      retryable: true,
      error: expect.stringMatching(/different request.*not started.*retry/i),
    };
    expect(provider.finalResults("different")).toEqual([["different", busy, undefined]]);
    expect(overlappingSubmissions).toEqual([["different", busy, undefined]]);

    provider.invoke("retry", args);
    await vi.waitFor(() => expect(provider.finalResults("retry")).toHaveLength(1), { interval: 1 });
    expect(consult).toHaveBeenCalledTimes(2);
    expect(consult.mock.calls[1]?.[0]).toEqual(args);
    expect(provider.finalResults("retry")).toEqual([
      ["retry", { text: "Answer for the retried request." }, undefined],
    ]);
  });

  it.each([
    {
      label: "a different question",
      firstArgs: { question: "Dataset A" },
      nextArgs: { question: "Dataset B" },
    },
    {
      label: "a missing question",
      firstArgs: { context: "2025" },
      nextArgs: { context: "2025" },
    },
  ])(
    "rejects $label while the first consult is settling its transcript",
    async ({ firstArgs, nextArgs }) => {
      const { consult, provider } = await createConsultFixture();
      const pending = createDeferred<unknown>();
      consult.mockImplementation(() => pending.promise);
      vi.useFakeTimers();
      try {
        provider.request.onTranscript?.("user", "Read the latest report for Dataset A.", false);
        provider.invoke("first", firstArgs);
        await vi.advanceTimersByTimeAsync(0);
        provider.invoke("different", nextArgs);
        await vi.advanceTimersByTimeAsync(0);
        expect(consult).not.toHaveBeenCalled();
        expect(provider.finalResults("different")).toEqual([
          [
            "different",
            {
              status: "busy",
              started: false,
              retryable: true,
              error: expect.stringContaining("not started"),
            },
            undefined,
          ],
        ]);
        await vi.advanceTimersByTimeAsync(350);
        expect(consult).toHaveBeenCalledOnce();
        expect(consult.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({ question: "Read the latest report for Dataset A." }),
        );
        pending.resolve({ text: "The latest Dataset A report." });
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.finalResults("first")).toEqual([
          ["first", { text: "The latest Dataset A report." }, undefined],
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { phase: "working response", final: false },
    { phase: "working response", final: true },
    { phase: "transcript settling", final: false },
    { phase: "transcript settling", final: true },
    { phase: "transcript persistence", final: false },
  ])("isolates rejected speech during $phase (final=$final)", async ({ phase, final }) => {
    const { consult, provider, processEvent } = await createConsultFixture();
    const first = createDeferred<unknown>();
    const working = createDeferred<void>();
    const persistence = createDeferred<Awaited<ReturnType<typeof processEvent>>>();
    const speechA = "Read the latest report for Dataset A.";
    const speechB = "Now check the independent report for Dataset B.";
    consult.mockImplementationOnce(() => first.promise).mockResolvedValue({ text: "Answer B." });
    if (phase === "working response") {
      provider.submit.mockImplementationOnce(() => working.promise);
    }
    if (phase === "transcript persistence") {
      processEvent.mockReturnValueOnce(persistence.promise);
    }
    vi.useFakeTimers();
    try {
      provider.request.onTranscript?.("user", speechA, phase === "transcript persistence");
      provider.invoke("first", { question: "message" });
      await vi.advanceTimersByTimeAsync(0);
      provider.request.onTranscript?.("user", speechB, final);
      provider.invoke("different", { question: "message" });
      await vi.advanceTimersByTimeAsync(0);
      expect(consult).not.toHaveBeenCalled();
      persistence.resolve({ kind: "processed" });
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.finalResults("different")).toEqual([
        [
          "different",
          expect.objectContaining({ status: "busy", started: false, retryable: true }),
          undefined,
        ],
      ]);
      expect(provider.submit.mock.calls.filter(([id]) => id === "different")).toHaveLength(1);
      working.resolve();
      await vi.advanceTimersByTimeAsync(350);
      expect(consult).toHaveBeenCalledOnce();
      expect(consult.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ question: speechA }));
      expect(consult.mock.calls[0]?.[2].partialUserTranscript).toBe(speechA);

      first.resolve({ text: "Answer A." });
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.finalResults("different")).toHaveLength(1);
      provider.invoke("retry", { question: "message" });
      await vi.advanceTimersByTimeAsync(350);
      expect(consult).toHaveBeenCalledTimes(2);
      expect(consult.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ question: speechB }));
      expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(speechB);
      expect(provider.finalResults("retry")).toEqual([["retry", { text: "Answer B." }, undefined]]);
    } finally {
      working.resolve();
      persistence.resolve({ kind: "processed" });
      first.resolve({ text: "Cleanup." });
      vi.useRealTimers();
    }
  });

  it("captures native delegation context before transcript persistence yields", async () => {
    const { consult, provider, processEvent } = await createConsultFixture(true);
    const delegate = expectDefined(provider.request.runAgentConsult, "native delegation");
    const persisted = createDeferred<Awaited<ReturnType<typeof processEvent>>>();
    const first = createDeferred<unknown>();
    processEvent.mockReturnValueOnce(persisted.promise);
    consult.mockImplementationOnce(() => first.promise).mockResolvedValue({ text: "Answer B." });
    const speechA = "Read the latest report for Dataset A.";
    const speechB = "Now check the independent report for Dataset B.";
    vi.useFakeTimers();
    try {
      provider.request.onTranscript?.("user", speechA, true);
      const answerA = delegate({ prompt: "message" });
      provider.request.onTranscript?.("user", speechB, false);
      const busy = delegate({ prompt: "message" }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(consult).not.toHaveBeenCalled();
      persisted.resolve({ kind: "processed" });
      await vi.advanceTimersByTimeAsync(350);
      expect(await busy).toBeInstanceOf(Error);
      expect(consult).toHaveBeenCalledOnce();
      expect(consult.mock.calls[0]?.[2].partialUserTranscript).toBe(speechA);
      first.resolve({ text: "Answer A." });
      await expect(answerA).resolves.toEqual({ text: "Answer A." });
      const answerB = delegate({ prompt: "message" });
      await vi.advanceTimersByTimeAsync(350);
      await expect(answerB).resolves.toEqual({ text: "Answer B." });
      expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(speechB);
      expect(provider.submit).not.toHaveBeenCalled();
    } finally {
      persisted.resolve({ kind: "processed" });
      first.resolve({ text: "Cleanup." });
      vi.useRealTimers();
    }
  });

  it("keeps an empty admission snapshot separate from later speech", async () => {
    const { consult, provider } = await createConsultFixture();
    const working = createDeferred<void>();
    const first = createDeferred<unknown>();
    consult.mockImplementationOnce(() => first.promise).mockResolvedValue({ text: "Answer B." });
    provider.submit.mockImplementationOnce(() => working.promise);
    vi.useFakeTimers();
    try {
      provider.invoke("first", { question: "Dataset A" });
      await vi.advanceTimersByTimeAsync(0);
      const speechB = "Read the independent report for Dataset B.";
      provider.request.onTranscript?.("user", speechB, false);
      provider.invoke("different", { question: "Dataset B" });
      await vi.advanceTimersByTimeAsync(0);
      working.resolve();
      await vi.advanceTimersByTimeAsync(350);
      expect(consult.mock.calls[0]?.[0]).toEqual({ question: "Dataset A" });
      expect(consult.mock.calls[0]?.[2].partialUserTranscript).toBeUndefined();
      first.resolve({ text: "Answer A." });
      await vi.advanceTimersByTimeAsync(0);
      provider.invoke("retry", { question: "message" });
      await vi.advanceTimersByTimeAsync(350);
      expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(speechB);
    } finally {
      working.resolve();
      first.resolve({ text: "Cleanup." });
      vi.useRealTimers();
    }
  });

  it.each(["repeats", "extends"])(
    "preserves an independent final that %s the active question",
    async (kind) => {
      const { consult, provider } = await createConsultFixture();
      const first = createDeferred<unknown>();
      consult.mockImplementationOnce(() => first.promise).mockResolvedValue({ text: "Answer B." });
      const speechA = "Read the latest report for Dataset A.";
      const speechB = kind === "repeats" ? speechA : `${speechA} Include this year's totals.`;
      vi.useFakeTimers();
      try {
        provider.request.onTranscript?.("user", speechA, true);
        provider.invoke("first", { question: "message" });
        await vi.advanceTimersByTimeAsync(0);
        expect(consult).toHaveBeenCalledOnce();
        provider.request.onTranscript?.("user", speechB, true);
        provider.invoke("different", { question: "message" });
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.finalResults("different")).toEqual([
          ["different", expect.objectContaining({ status: "busy" }), undefined],
        ]);
        first.resolve({ text: "Answer A." });
        await vi.advanceTimersByTimeAsync(0);
        provider.invoke("retry", { question: "message" });
        await vi.advanceTimersByTimeAsync(0);
        expect(consult).toHaveBeenCalledTimes(2);
        expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(speechB);
      } finally {
        first.resolve({ text: "Cleanup." });
        vi.useRealTimers();
      }
    },
  );

  it("lets exact replays keep collecting their own transcript before dispatch", async () => {
    const { consult, provider } = await createConsultFixture();
    consult.mockResolvedValue({ text: "Answer A." });
    vi.useFakeTimers();
    try {
      provider.request.onTranscript?.("user", "Read the latest report", false);
      provider.invoke("first", { question: "message" });
      await vi.advanceTimersByTimeAsync(50);
      provider.request.onTranscript?.("user", "for Dataset A.", false);
      provider.invoke("first", { question: "message" });
      await vi.advanceTimersByTimeAsync(350);
      expect(consult).toHaveBeenCalledOnce();
      expect(consult.mock.calls[0]?.[2].partialUserTranscript).toBe(
        "Read the latest report for Dataset A.",
      );
      expect(provider.finalResults("first")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["continuity reset", "replacement stream", "teardown"] as const)(
    "retires shared consults on %s without delivering an old result",
    async (lifecycle) => {
      const { handler, consult, connect, provider } = await createConsultFixture();
      const old = createDeferred<unknown>();
      const replacement = createDeferred<unknown>();
      consult
        .mockImplementationOnce(() => old.promise)
        .mockImplementationOnce(() => replacement.promise);
      const args = { question: "Check Dataset A.", context: "2025" };
      provider.invoke("old", args);
      await vi.waitFor(() => expect(consult).toHaveBeenCalledOnce(), { interval: 1 });
      provider.invoke("old", args);
      await vi.waitFor(() => expect(provider.submit).toHaveBeenCalledTimes(2), { interval: 1 });
      const oldSignal = expectDefined(
        consult.mock.calls[0]?.[2].abortSignal,
        "consult abort signal",
      );

      let current = provider;
      if (lifecycle === "continuity reset") {
        provider.request.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      } else if (lifecycle === "replacement stream") {
        current = await connect();
      } else {
        await handler.close();
      }
      expect(oldSignal.aborted).toBe(true);
      if (lifecycle !== "teardown") {
        current.invoke("replacement", args);
        await vi.waitFor(() => expect(consult).toHaveBeenCalledTimes(2), { interval: 1 });
      }

      old.resolve({ text: "Retired answer." });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(provider.finalResults("old")).toEqual([]);

      if (lifecycle === "teardown") {
        provider.invoke("stale", args);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(consult).toHaveBeenCalledOnce();
        expect(provider.finalResults("stale")).toEqual([]);
        return;
      }
      current.invoke("replacement", args);
      await vi.waitFor(
        () =>
          expect(current.submit.mock.calls.filter(([id]) => id === "replacement")).toHaveLength(2),
        { interval: 1 },
      );
      expect(consult).toHaveBeenCalledTimes(2);
      replacement.resolve({ text: "Current answer." });
      await vi.waitFor(() => expect(current.finalResults("replacement")).toHaveLength(2), {
        interval: 1,
      });
      expect(current.finalResults("replacement")).toEqual([
        ["replacement", { text: "Current answer." }, undefined],
        ["replacement", { text: "Current answer." }, undefined],
      ]);
    },
  );
});
