import { afterEach, expect, it, vi } from "vitest";
import { createResearchJobsFixture } from "./jobs.test-support.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

it.each(["live", "paused"] as const)(
  "retains verified portable evidence when a %s job is cancelled",
  async (phase) => {
    const { jobs, runtime, context, readStore } = await createResearchJobsFixture({}, (close) =>
      cleanup.push(close),
    );
    const quote = "The measured river length is twelve kilometers.";
    const modelResponse = (value: unknown) => ({
      text: JSON.stringify(value),
      provider: "example",
      model: "research-model",
      agentId: "main",
      usage: { totalTokens: 10 },
      execution: {
        mode: "direct-provider" as const,
        owner: { kind: "provider" as const, id: "example" },
      },
      audit: { caller: { kind: "plugin" as const, id: "deep-research" } },
    });
    vi.mocked(runtime.llm.complete)
      .mockResolvedValueOnce(modelResponse({ questions: ["River"] }))
      .mockResolvedValueOnce(
        modelResponse({
          findings: [
            {
              statement: "The river is twelve kilometers long.",
              evidence: [{ sourceId: "S1", quote }],
            },
          ],
          gaps: ["River depth remains unknown."],
          queries: ["River depth"],
        }),
      )
      .mockResolvedValueOnce(
        modelResponse({
          verdicts: [{ index: 0, verdict: "supported", reason: "Exact measurement" }],
          unanswered: ["River depth remains unknown."],
        }),
      );
    const searching = Promise.withResolvers<void>();
    vi.mocked(runtime.gateway.request)
      .mockResolvedValueOnce({ ok: true, output: { details: { results: [] } } })
      .mockImplementationOnce(
        async (_method, _params, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("Research search cancelled")),
              {
                once: true,
              },
            );
            searching.resolve();
          }),
      );
    const parent = new AbortController();
    const running = jobs.start(
      {
        question: "River",
        sources: { web: true, documents: [{ title: "River report", text: quote }] },
      },
      "cancel-partial",
      context,
      parent.signal,
    );
    await searching.promise;
    const [entry] = await readStore().entries();
    expect(entry).toBeDefined();
    let result;
    if (phase === "paused") {
      const stopped = expect(running).rejects.toThrow("Pause research");
      parent.abort(new Error("Pause research"));
      await stopped;
      const paused = await jobs.get(entry!.key, context);
      expect(paused.state).toBe("paused");
      const calls = [
        vi.mocked(runtime.llm.complete).mock.calls.length,
        vi.mocked(runtime.gateway.request).mock.calls.length,
      ];
      result = await jobs.cancel(paused, context);
      expect([
        vi.mocked(runtime.llm.complete).mock.calls.length,
        vi.mocked(runtime.gateway.request).mock.calls.length,
      ]).toEqual(calls);
    } else {
      await jobs.cancel(entry!.value, context);
      result = await running;
    }
    expect(result.state).toBe("cancelled");
    expect(result.progress).not.toContain("resum");
    expect(result.result?.status).toBe("cancelled");
    expect(result.result?.report).toContain("The river is twelve kilometers long.");
    expect(result.result?.sources[0]?.text).toBe(quote);
    expect(result.publicationId).toBe(result.id);
    expect((await jobs.get(result.id, context)).result).toEqual(result.result);
  },
);
