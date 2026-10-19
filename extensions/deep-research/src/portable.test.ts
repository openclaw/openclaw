import { describe, expect, it, vi } from "vitest";
import { runPortableResearch, type ResearchIO } from "./portable.js";

function fixture() {
  const evidence = { sourceId: "S1", quote: "The measured river length is 12 km." };
  const verdict = {
    index: 0,
    verdict: "supported",
    reason: "The cited passage states the measured length.",
  };
  const responses = [
    { questions: ["river length"] },
    {
      findings: [{ statement: "The river is 12 km long.", evidence: [evidence] }],
      gaps: [],
      queries: [],
    },
    { verdicts: [verdict], unanswered: [] },
  ];
  const io: ResearchIO = {
    complete: vi.fn(async () => ({ text: JSON.stringify(responses.shift()), tokens: 20 })),
    search: vi.fn(async () => [{ url: "https://example.org/river", title: "River" }]),
    fetch: vi.fn(async (url) => ({
      url,
      title: "River",
      text: "The measured river length is 12 km.",
    })),
    assertCurrent: vi.fn(),
    progress: vi.fn(),
  };
  return { io, evidence, verdict };
}

describe("portable research", () => {
  it("returns a report whose citations resolve to fetched passages without inventing a runtime", async () => {
    const { io } = fixture();
    const result = await runPortableResearch({ question: "How long is the river?" }, io);
    expect(result.status).toBe("completed");
    expect(result.route.runtime).toBe("unobserved");
    expect(result.report).toContain("The river is 12 km long. [S1]");
    expect(result.sources).toMatchObject([
      {
        id: "S1",
        url: "https://example.org/river",
        text: "The measured river length is 12 km.",
        extraction: "web-fetch-text-v1",
      },
    ]);
    const observations = vi.mocked(io.progress).mock.calls.map(([, observation]) => observation);
    expect(observations.map((observation) => observation?.phase)).toEqual([
      "planning",
      "gathering",
      "assessing",
      "auditing",
    ]);
    expect(observations[0]?.sources).toEqual([]);
    expect(observations[2]?.sources[0]).toMatchObject({
      id: "S1",
      text: "The measured river length is 12 km.",
    });
    expect(observations[2]?.counts).toEqual({ modelCalls: 1, searches: 1, fetches: 1, sources: 1 });
    expect(result.reportCitations).toHaveLength(1);
    expect(result.usage).toEqual({
      modelCalls: 3,
      searches: 1,
      fetches: 1,
      reportedTokens: 60,
      tokensComplete: true,
    });
  });

  it("discloses changed runtime ownership across replayed and fresh model receipts", async () => {
    const { io } = fixture();
    const complete = io.complete;
    let first = true;
    io.complete = async (...args) => {
      const result = await complete(...args);
      const direct = first;
      first = false;
      return {
        ...result,
        route: {
          model: "openai/gpt-5.4",
          runtime: direct ? "direct-provider" : "isolated-agent-runtime",
          owner: direct ? { kind: "provider", id: "openai" } : { kind: "harness", id: "codex" },
        },
      };
    };
    const result = await runPortableResearch({ question: "River length" }, io);
    expect(result.status).toBe("partial");
    expect(result.route).toMatchObject({
      runtime: "isolated-agent-runtime",
      owner: { id: "codex" },
    });
    expect(result.gaps).toContain(
      "Model execution changed between research steps; route shows the last observed execution.",
    );
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("excludes invented quotations and copied sources instead of publishing false support", async () => {
    const { io, evidence } = fixture();
    evidence.quote = "The measured river length is 99 km.";
    io.search = async () => [
      { url: "https://example.org/a", title: "A" },
      { url: "https://example.org/b", title: "B" },
    ];
    const result = await runPortableResearch({ question: "River length" }, io);
    expect(result.status).toBe("partial");
    expect(result.findings).toEqual([]);
    expect(result.sources).toHaveLength(1);
    expect(result.gaps).toContain("Unverifiable citation omitted: The river is 12 km long.");
  });

  it("shares a fetch budget across parallel branches and excludes forbidden sources", async () => {
    const { io } = fixture();
    io.search = async () =>
      ["https://blocked.example/a", "https://example.org/a", "https://example.org/b"].map(
        (url) => ({ url, title: url }),
      );
    const result = await runPortableResearch(
      {
        question: "River length",
        sources: { allowDomains: ["example.org"] },
        budget: { fetches: 1, parallelism: 4 },
      },
      io,
    );
    expect(io.fetch).toHaveBeenCalledTimes(1);
    expect(io.fetch).toHaveBeenCalledWith("https://example.org/a", expect.any(AbortSignal));
    expect(result.usage.fetches).toBe(1);
  });

  it("stops before another paid call when the global model budget is exhausted", async () => {
    const { io } = fixture();
    const result = await runPortableResearch(
      { question: "River length", budget: { modelCalls: 1 } },
      io,
    );
    expect(io.complete).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("partial");
    expect(result.gaps).toContain("modelCalls budget exhausted");
  });

  it("does not admit work after cancellation or retired invocation authority", async () => {
    const { io } = fixture();
    const cancel = new AbortController();
    cancel.abort();
    expect(
      (await runPortableResearch({ question: "River length" }, io, cancel.signal)).status,
    ).toBe("cancelled");
    expect(io.complete).not.toHaveBeenCalled();
    io.assertCurrent = () => {
      throw new Error("retired");
    };
    await expect(runPortableResearch({ question: "River length" }, io)).rejects.toThrow("retired");
    expect(io.complete).not.toHaveBeenCalled();
  });

  it("retains evidence when model output is incomplete and rejects trivial quotations", async () => {
    const { io, evidence } = fixture();
    evidence.quote = ".";
    const result = await runPortableResearch({ question: "River length" }, io);
    expect(result.findings).toEqual([]);
    expect(result.sources).toHaveLength(1);
    const retry = fixture().io;
    vi.mocked(retry.complete)
      .mockResolvedValueOnce({ text: '{"questions":["river"]}' })
      .mockRejectedValueOnce(new Error("context too long"));
    const partial = await runPortableResearch({ question: "River length" }, retry);
    expect(partial.status).toBe("partial");
    expect(partial.sources).toHaveLength(1);
  });

  it("caps the combined corpus and keeps source IDs stable across parallel completion", async () => {
    const { io } = fixture();
    const result = await runPortableResearch(
      {
        question: "River length",
        sources: {
          documents: Array.from({ length: 10 }, (_, i) => ({
            title: `Doc ${i}`,
            text: `${i}`.repeat(20_000),
          })),
        },
      },
      io,
    );
    expect(
      result.sources.reduce((n, source) => n + Buffer.byteLength(source.text), 0),
    ).toBeLessThanOrEqual(60_000);
    expect(result.status).toBe("partial");
  });

  it("does not send private document content to public search without explicit opt-in", async () => {
    const { io } = fixture();
    const result = await runPortableResearch(
      {
        question: "River length",
        sources: {
          documents: [{ title: "Private note", text: "The measured river length is 12 km." }],
        },
      },
      io,
    );
    expect(io.search).not.toHaveBeenCalled();
    expect(io.fetch).not.toHaveBeenCalled();
    expect(result.findings).toMatchObject([{ support: "model-supported" }]);
  });

  it("withholds exact-quote findings when the separate audit finds a contradiction", async () => {
    const { io, verdict } = fixture();
    verdict.verdict = "contradicted";
    const result = await runPortableResearch({ question: "River length" }, io);
    expect(result.findings).toEqual([]);
    expect(result.status).toBe("partial");
  });

  it("rejects malformed model data without attempting an unrequested repair call", async () => {
    const { io } = fixture();
    io.complete = vi.fn(async () => ({ text: '{"questions":"not an array"}' }));
    expect((await runPortableResearch({ question: "River length" }, io)).status).toBe("partial");
    expect(io.complete).toHaveBeenCalledTimes(1);
    expect(io.search).not.toHaveBeenCalled();
  });
});
