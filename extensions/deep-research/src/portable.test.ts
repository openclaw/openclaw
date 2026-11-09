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
  it("keeps verified findings when a model reply lists more items than the schema allows", async () => {
    const { io, evidence, verdict } = fixture();
    const extra = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix} ${index}`);
    const responses = [
      { questions: extra("river question", 6) },
      {
        findings: [{ statement: "The river is 12 km long.", evidence: [evidence] }],
        gaps: [],
        queries: extra("follow-up", 6),
      },
      { verdicts: [verdict], unanswered: extra("open question", 10) },
    ];
    io.complete = vi.fn(async () => ({ text: JSON.stringify(responses.shift()) }));
    const result = await runPortableResearch(
      { question: "How long is the river?", budget: { modelCalls: 3 } },
      io,
    );
    expect(result.findings).toMatchObject([{ statement: "The river is 12 km long." }]);
    expect(result.gaps).not.toContain(
      "Research response did not satisfy the evidence contract; no repair call was made.",
    );
    expect(vi.mocked(io.search).mock.calls.length).toBeLessThanOrEqual(4);
    expect(result.gaps.filter((gap) => gap.startsWith("open question"))).toHaveLength(8);
  });
  it("rejects an audit that repeats a verdict instead of trimming away its contradiction", async () => {
    const { io, evidence } = fixture();
    const supported = { index: 0, verdict: "supported", reason: "Direct evidence" };
    const responses = [
      { questions: ["river length"] },
      {
        findings: [{ statement: "The river is 12 km long.", evidence: [evidence] }],
        gaps: [],
        queries: [],
      },
      {
        verdicts: [
          ...Array.from({ length: 12 }, (_, index) => ({ ...supported, index })),
          { index: 0, verdict: "contradicted", reason: "Later measurement" },
        ],
        unanswered: [],
      },
    ];
    io.complete = vi.fn(async () => ({ text: JSON.stringify(responses.shift()) }));
    const result = await runPortableResearch({ question: "How long is the river?" }, io);
    expect(result.findings).toEqual([]);
    expect(result.gaps).toContain(
      "Research response did not satisfy the evidence contract; no repair call was made.",
    );
  });
  it.each(["unsupported", "contradicted"])(
    "reaudits retained findings on later rounds without erasing them on an %s sample",
    async (verdict) => {
      const { io, evidence } = fixture();
      const finding = { statement: "The river is 12 km long.", evidence: [evidence] };
      const responses = [
        { questions: ["river length"] },
        { findings: [finding], gaps: ["Check later measurements"], queries: ["river update"] },
        {
          verdicts: [{ index: 0, verdict: "supported", reason: "Direct evidence" }],
          unanswered: [],
        },
        { findings: [], gaps: [], queries: [] },
        { verdicts: [{ index: 0, verdict, reason: "Second-round audit" }], unanswered: [] },
      ];
      io.complete = vi.fn(async () => ({ text: JSON.stringify(responses.shift()) }));
      const result = await runPortableResearch({ question: "River length" }, io);
      expect(result.findings).toHaveLength(verdict === "contradicted" ? 0 : 1);
      expect(result.gaps).toContain(
        verdict === "contradicted"
          ? "Support contradicted: The river is 12 km long."
          : "Recheck inconclusive for previously supported finding: The river is 12 km long.",
      );
      expect(io.complete).toHaveBeenCalledTimes(5);
    },
  );

  it("removes an obsolete citation gap once a later round verifies that finding", async () => {
    const { io, evidence } = fixture();
    const statement = "The river is 12 km long.";
    const responses = [
      { questions: ["river length"] },
      {
        findings: [
          {
            statement,
            evidence: [{ ...evidence, quote: "This passage was never in the source." }],
          },
        ],
        gaps: ["Find the source"],
        queries: ["river evidence"],
      },
      { findings: [{ statement, evidence: [evidence] }], gaps: [], queries: [] },
      { verdicts: [{ index: 0, verdict: "supported", reason: "Direct evidence" }], unanswered: [] },
    ];
    io.complete = vi.fn(async () => ({ text: JSON.stringify(responses.shift()) }));
    const result = await runPortableResearch({ question: "River length" }, io);
    expect(result.status).toBe("completed");
    expect(result.gaps).toEqual([]);
    expect(result.findings).toMatchObject([{ statement }]);
  });

  it.each(["insufficient budget", "next extraction failure"])(
    "retains completed-round gaps after %s without wasting an unauditable call",
    async (failure) => {
      const { io, evidence, verdict } = fixture();
      const responses = [
        { questions: ["river length"] },
        {
          findings: [{ statement: "The river is 12 km long.", evidence: [evidence] }],
          gaps: ["Missing update"],
          queries: ["river update"],
        },
        { verdicts: [verdict], unanswered: ["Unknown measurement date"] },
      ];
      io.complete = vi.fn(async () => {
        if (!responses.length) {
          throw new Error("provider unavailable");
        }
        return { text: JSON.stringify(responses.shift()) };
      });
      const result = await runPortableResearch(
        {
          question: "River length",
          budget: { modelCalls: failure === "insufficient budget" ? 4 : 6 },
        },
        io,
      );
      expect(result.status).toBe("partial");
      expect(result.gaps).toEqual(
        expect.arrayContaining(["Missing update", "Unknown measurement date"]),
      );
      expect(result.findings).toHaveLength(1);
      expect(io.complete).toHaveBeenCalledTimes(failure === "insufficient budget" ? 3 : 4);
    },
  );

  it("bounds page titles before they enter extraction and audit prompts", async () => {
    const { io } = fixture();
    io.fetch = async (url) => ({
      url,
      title: "Malicious\nHeading" + "x".repeat(1_000),
      text: "The measured river length is 12 km.",
    });
    const result = await runPortableResearch({ question: "River length" }, io);
    expect(result.sources[0]?.title).toHaveLength(256);
    expect(result.sources[0]?.title).not.toContain("\n");
    expect(vi.mocked(io.complete).mock.calls[1]?.[0]).not.toContain("x".repeat(257));
  });

  it("keeps findings that differ only past the display cap as separate candidates", async () => {
    const { io, evidence } = fixture();
    const prefix = "a".repeat(999);
    // Both statements are schema-valid; they diverge where display truncation stops.
    const statements = [prefix, `${prefix}\u{1f600}`];
    const responses = [
      { questions: ["river length"] },
      {
        findings: statements.map((statement) => ({ statement, evidence: [evidence] })),
        gaps: [],
        queries: [],
      },
      {
        verdicts: statements.map((_statement, index) => ({
          index,
          verdict: "supported",
          reason: "Direct evidence",
        })),
        unanswered: [],
      },
    ];
    io.complete = vi.fn(async () => ({ text: JSON.stringify(responses.shift()) }));
    const result = await runPortableResearch({ question: "River length" }, io);
    expect(result.findings.map((finding) => finding.statement)).toEqual(statements);
  });
});
