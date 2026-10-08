import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const connected = createDeferred<void>();
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
  return { consult, processEvent, provider: await connect() };
}

afterEach(() => vi.useRealTimers());

describe("native realtime consult request identity", () => {
  it.each([
    {
      label: "invocation ID with identical arguments",
      args: { question: "Check Dataset A.", context: "2025" },
    },
    { label: "question", args: { question: "Check Dataset B.", context: "2025" } },
  ])("rejects an overlapping different $label and accepts its later retry", async ({ args }) => {
    const { consult, provider } = await createConsultFixture();
    vi.useFakeTimers();
    const first = createDeferred<unknown>();
    consult
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ text: "Answer for the retried request." });
    provider.invoke("first", { question: "Check Dataset A.", context: "2025" });
    await vi.advanceTimersByTimeAsync(0);
    expect(consult).toHaveBeenCalledOnce();
    provider.invoke("different", args);
    await vi.advanceTimersByTimeAsync(0);
    const overlappingSubmissions = provider.submit.mock.calls.filter(([id]) => id === "different");
    expect(consult).toHaveBeenCalledOnce();

    first.resolve({ text: "Answer only for Dataset A in 2025." });
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.finalResults("first")).toEqual([
      ["first", { text: "Answer only for Dataset A in 2025." }, undefined],
    ]);
    const busy = {
      status: "busy",
      started: false,
      retryable: true,
      error: expect.stringMatching(/different request.*not started.*retry/i),
    };
    expect(provider.finalResults("different")).toEqual([["different", busy, undefined]]);
    expect(overlappingSubmissions).toEqual([["different", busy, undefined]]);

    provider.invoke("retry", args);
    await vi.advanceTimersByTimeAsync(0);
    expect(consult).toHaveBeenCalledTimes(2);
    expect(consult.mock.calls[1]?.[0]).toEqual(args);
    expect(provider.finalResults("retry")).toEqual([
      ["retry", { text: "Answer for the retried request." }, undefined],
    ]);
  });

  it.each([
    { phase: "working response", final: true },
    { phase: "completed ASR", final: true },
    { phase: "same completed ASR", final: true },
    { phase: "transcript settling", final: false },
    { phase: "transcript persistence", final: false },
  ])("isolates rejected speech during $phase (final=$final)", async ({ phase, final }) => {
    const { consult, provider, processEvent } = await createConsultFixture();
    const first = createDeferred<unknown>();
    const working = createDeferred<void>();
    const persistence = createDeferred<Awaited<ReturnType<typeof processEvent>>>();
    const speechA = "Read the latest report for Dataset A.";
    const speechB = "Now check the independent report for Dataset B.";
    consult.mockImplementationOnce(() => first.promise).mockResolvedValue({ text: "Answer B." });
    if (phase === "working response" || phase.includes("completed ASR")) {
      provider.submit.mockImplementationOnce(() => working.promise);
    }
    if (phase === "transcript persistence") {
      processEvent.mockReturnValueOnce(persistence.promise);
    }
    vi.useFakeTimers();
    try {
      provider.request.onTranscript?.(
        "user",
        phase.includes("completed ASR") ? "Read the latest report" : speechA,
        phase === "transcript persistence",
      );
      provider.invoke("first", { question: "message" });
      await vi.advanceTimersByTimeAsync(0);
      if (final) {
        provider.request.onTranscript?.("user", speechA, true);
      }
      if (phase !== "same completed ASR") {
        provider.request.onTranscript?.("user", speechB, final);
      }
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
      provider.invoke("retry", { question: phase === "same completed ASR" ? speechB : "message" });
      await vi.advanceTimersByTimeAsync(350);
      expect(consult).toHaveBeenCalledTimes(2);
      expect(consult.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ question: speechB }));
      expect(consult.mock.calls[1]?.[2].partialUserTranscript).toBe(
        phase === "same completed ASR" ? undefined : speechB,
      );
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
});
