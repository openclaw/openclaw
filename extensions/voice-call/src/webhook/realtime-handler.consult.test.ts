import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { RealtimeCallHandler } from "./realtime-handler.js";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
} from "./realtime-handler.lifecycle.test-helpers.js";

type ToolHandler = Parameters<RealtimeCallHandler["registerToolHandler"]>[1];
type ProviderRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

async function createConsultFixture() {
  const providers: Array<{
    request: ProviderRequest;
    submit: ReturnType<typeof vi.fn<RealtimeVoiceBridge["submitToolResult"]>>;
  }> = [];
  const connections: Array<Awaited<ReturnType<typeof connectCarrierStream>>> = [];
  const { handler, call } = createCarrierLifecycleHarness((request) => {
    const submit = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
    providers.push({ request, submit });
    return createBridge(vi.fn(), {
      supportsToolResultContinuation: true,
      submitToolResult: submit,
    });
  });
  const consult = vi.fn<ToolHandler>();
  handler.registerToolHandler("openclaw_agent_consult", consult);
  onTestFinished(async () => {
    await handler.close();
    for (const { server } of connections) {
      await server.close();
    }
  });
  const connect = async () => {
    const index = providers.length;
    const connection = await connectCarrierStream(handler);
    connections.push(connection);
    connection.ws.send(
      JSON.stringify({
        event: "start",
        start: { streamSid: `MZ-consult-${index}`, callSid: call.providerCallId },
      }),
    );
    await vi.waitFor(() => expect(providers).toHaveLength(index + 1), { interval: 1 });
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
  return { handler, consult, connect, provider: await connect() };
}

describe("native realtime consult request identity", () => {
  it.each([
    { label: "identical arguments", args: { question: "Check Dataset A.", context: "2025" } },
    { label: "reordered arguments", args: { context: "2025", question: "Check Dataset A." } },
    { label: "trimmed alias", args: { prompt: " Check Dataset A. ", context: " 2025 " } },
    {
      label: "empty optional values",
      args: {
        question: "Check Dataset A.",
        context: "2025",
        responseStyle: " ",
        confirmationId: "",
      },
    },
  ])("shares one pending consult for $label", async ({ args }) => {
    const { consult, provider } = await createConsultFixture();
    const pending = createDeferred<unknown>();
    consult.mockImplementation(() => pending.promise);
    provider.invoke("first", { question: "Check Dataset A.", context: "2025" });
    await vi.waitFor(() => expect(consult).toHaveBeenCalledOnce(), { interval: 1 });
    provider.invoke("equivalent", args);
    await vi.waitFor(() => expect(provider.submit).toHaveBeenCalledTimes(2), { interval: 1 });

    pending.resolve({ text: "Dataset A has 12 records." });
    await vi.waitFor(() => expect(provider.finalResults("equivalent")).toHaveLength(1), {
      interval: 1,
    });
    expect(consult).toHaveBeenCalledOnce();
    for (const id of ["first", "equivalent"]) {
      expect(provider.finalResults(id)).toEqual([
        [id, { text: "Dataset A has 12 records." }, undefined],
      ]);
    }
  });

  it.each([
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
            { status: "busy", error: expect.stringContaining("not started") },
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
      provider.invoke("old-duplicate", args);
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
      expect(provider.finalResults("old-duplicate")).toEqual([]);

      if (lifecycle === "teardown") {
        provider.invoke("stale", args);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(consult).toHaveBeenCalledOnce();
        expect(provider.finalResults("stale")).toEqual([]);
        return;
      }
      current.invoke("replacement-duplicate", args);
      await vi.waitFor(
        () =>
          expect(current.submit.mock.calls.some(([id]) => id === "replacement-duplicate")).toBe(
            true,
          ),
        { interval: 1 },
      );
      expect(consult).toHaveBeenCalledTimes(2);
      replacement.resolve({ text: "Current answer." });
      await vi.waitFor(
        () => expect(current.finalResults("replacement-duplicate")).toHaveLength(1),
        {
          interval: 1,
        },
      );
      for (const id of ["replacement", "replacement-duplicate"]) {
        expect(current.finalResults(id)).toEqual([[id, { text: "Current answer." }, undefined]]);
      }
    },
  );
});
