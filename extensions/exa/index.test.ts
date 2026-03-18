import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { __testing as exaTesting, createExaWebSearchProvider } from "./src/exa-search-provider.js";

describe("exa plugin", () => {
  it("registers the expected plugin metadata", () => {
    expect(plugin.id).toBe("exa");
    expect(plugin.name).toBe("Exa Plugin");
  });

  it("normalizes Exa results into provider output fields", () => {
    expect(
      exaTesting.normalizeExaResults({
        results: [
          {
            title: "Example result",
            url: "https://example.com/post",
            publishedDate: "2024-01-15T12:00:00.000Z",
            highlights: ["first highlight", "second highlight"],
            text: "fallback text",
          },
        ],
      }),
    ).toEqual([
      {
        title: "Example result",
        url: "https://example.com/post",
        publishedDate: "2024-01-15T12:00:00.000Z",
        highlights: ["first highlight", "second highlight"],
        text: "fallback text",
      },
    ]);
  });

  it("returns empty array for non-array results", () => {
    expect(exaTesting.normalizeExaResults({})).toEqual([]);
    expect(exaTesting.normalizeExaResults(null)).toEqual([]);
    expect(exaTesting.normalizeExaResults({ results: "bad" })).toEqual([]);
  });

  it("prefers highlights over text when resolving descriptions", () => {
    expect(
      exaTesting.resolveDescription({
        highlights: ["first", "second"],
        text: "fallback",
      }),
    ).toBe("first\nsecond");
    expect(exaTesting.resolveDescription({ text: "fallback" })).toBe("fallback");
    expect(exaTesting.resolveDescription({})).toBe("");
  });

  it("normalizes ISO date via normalizeToIsoDate", () => {
    expect(exaTesting.normalizeToIsoDate("2024-03-10")).toBe("2024-03-10");
    expect(exaTesting.normalizeToIsoDate("not-a-date")).toBeUndefined();
  });

  it("normalizes freshness via normalizeFreshness", () => {
    expect(exaTesting.normalizeFreshness("day", "exa")).toBe("day");
    expect(exaTesting.normalizeFreshness("week", "exa")).toBe("week");
    expect(exaTesting.normalizeFreshness("month", "exa")).toBe("month");
    expect(exaTesting.normalizeFreshness("year", "exa")).toBe("year");
    expect(exaTesting.normalizeFreshness("yesterday", "exa")).toBeUndefined();
  });
});

describe("exa execute() — strict param validation (no HTTP)", () => {
  const TEST_API_KEY = "exa-test-key"; // pragma: allowlist secret

  function makeProvider() {
    return createExaWebSearchProvider().createTool({
      config: undefined,
      searchConfig: { exa: { apiKey: TEST_API_KEY } },
    });
  }

  it("returns error payload on invalid type value", async () => {
    const tool = makeProvider();
    const result = (await tool!.execute({ query: "test query", type: "fuzzy" })) as Record<
      string,
      unknown
    >;
    expect(result.error).toBe("invalid_type");
  });

  it("returns error payload on non-object contents", async () => {
    const tool = makeProvider();
    const result = (await tool!.execute({
      query: "test query",
      contents: "yes",
    })) as Record<string, unknown>;
    expect(result.error).toBe("invalid_contents");
  });

  it("returns error payload on non-boolean contents.highlights", async () => {
    const tool = makeProvider();
    const result = (await tool!.execute({
      query: "test query",
      contents: { highlights: "yes" },
    })) as Record<string, unknown>;
    expect(result.error).toBe("invalid_contents");
  });

  it("returns error payload on unknown contents field", async () => {
    const tool = makeProvider();
    const result = (await tool!.execute({
      query: "test query",
      contents: { summaries: true },
    })) as Record<string, unknown>;
    expect(result.error).toBe("invalid_contents");
  });

  it("returns error payload on invalid date_after format", async () => {
    const tool = makeProvider();
    const result = (await tool!.execute({
      query: "test query",
      date_after: "not-a-date",
    })) as Record<string, unknown>;
    expect(result.error).toBe("invalid_date");
  });

  it("returns error payload on invalid date_before format", async () => {
    const tool = makeProvider();
    const result = (await tool!.execute({
      query: "test query",
      date_before: "99-99-9999",
    })) as Record<string, unknown>;
    expect(result.error).toBe("invalid_date");
  });

  it("returns error payload when date_after is after date_before", async () => {
    const tool = makeProvider();
    const result = (await tool!.execute({
      query: "test query",
      date_after: "2024-06-01",
      date_before: "2024-01-01",
    })) as Record<string, unknown>;
    expect(result.error).toBe("invalid_date_range");
  });

  it("returns error payload when freshness conflicts with date filters", async () => {
    const tool = makeProvider();
    const result = (await tool!.execute({
      query: "test query",
      freshness: "week",
      date_after: "2024-01-01",
    })) as Record<string, unknown>;
    expect(result.error).toBe("conflicting_time_filters");
  });

  it("returns error payload on invalid freshness value", async () => {
    const tool = makeProvider();
    const result = (await tool!.execute({
      query: "test query",
      freshness: "yesterday",
    })) as Record<string, unknown>;
    expect(result.error).toBe("invalid_freshness");
  });

  it("returns missing key payload when no API key configured", async () => {
    const provider = createExaWebSearchProvider().createTool({
      config: undefined,
      searchConfig: {},
    });
    const result = (await provider!.execute({ query: "test" })) as Record<string, unknown>;
    expect(result.error).toBe("missing_exa_api_key");
  });
});
