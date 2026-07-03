// Senseaudio tests cover web search provider plugin behavior.
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "../test-api.js";
import { createSenseAudioWebSearchProvider } from "./senseaudio-web-search-provider.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function searchCallItem(sources: string[]) {
  return {
    type: "web_search_call",
    status: "completed",
    action: {
      type: "search",
      query: "query",
      sources: sources.map((url) => ({ type: "url", url })),
    },
  };
}

function messageItem(text: string, annotations: unknown[] = []) {
  return {
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations }],
  };
}

function completedResponse(output: unknown[]) {
  return { status: "completed", error: null, incomplete_details: null, output };
}

async function executeSenseAudioSearch(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const provider = createSenseAudioWebSearchProvider();
  const tool = provider.createTool({ config: {}, searchConfig: {} });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return await tool.execute(args);
}

function readFetchJsonBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit | undefined];
  if (typeof init?.body !== "string") {
    throw new Error("Expected captured fetch request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function expectStringFieldContains(result: Record<string, unknown>, field: string, text: string) {
  const value = result[field];
  expect(typeof value).toBe("string");
  expect(value).toContain(text);
}

describe("senseaudio web search provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync({ SENSEAUDIO_API_KEY: undefined }, async () => {
      const result = await executeSenseAudioSearch({ query: "senseaudio missing key" });

      expect(result.error).toBe("missing_senseaudio_api_key");
      expectStringFieldContains(
        result,
        "message",
        "use web_fetch for a specific URL or the browser tool",
      );
    });
  });

  it("uses configured model and base url overrides with sane defaults", () => {
    expect(testing.resolveSenseAudioModel()).toBe("senseaudio-s2");
    expect(testing.resolveSenseAudioModel({ model: "senseaudio-s3" })).toBe("senseaudio-s3");
    expect(testing.resolveSenseAudioBaseUrl()).toBe("https://api.senseaudio.cn/v1");
    expect(testing.resolveSenseAudioBaseUrl({ baseUrl: "https://sense.example/v1/" })).toBe(
      "https://sense.example/v1",
    );
  });

  it("uses config apiKey and falls back to env apiKey", async () => {
    expect(testing.resolveSenseAudioApiKey({ apiKey: "sense-test-key" })).toBe("sense-test-key");
    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-env-key" }, async () => {
      expect(testing.resolveSenseAudioApiKey({})).toBe("sense-env-key");
    });
  });

  it("sends a forced non-streaming web_search request and returns grounded payloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          completedResponse([
            searchCallItem(["https://a.test"]),
            { type: "reasoning" },
            searchCallItem(["https://b.test", "https://a.test"]),
            messageItem("SenseAudio grounded answer.", [
              { type: "url_citation", url: "https://c.test" },
            ]),
          ]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      const result = await executeSenseAudioSearch({ query: "senseaudio grounded citations" });

      const body = readFetchJsonBody(fetchMock);
      expect(body.model).toBe("senseaudio-s2");
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.tool_choice).toEqual({ type: "web_search" });
      expect(body.include).toEqual(["web_search_call.action.sources"]);
      expect(body.stream).toBe(false);
      expect(body.store).toBe(false);

      expect(result.provider).toBe("senseaudio");
      expectStringFieldContains(result, "content", "SenseAudio grounded answer.");
      expect(result.citations).toEqual(["https://a.test", "https://b.test", "https://c.test"]);
      expect(result).not.toHaveProperty("error");
    });
  });

  it("returns a structured failure for ungrounded responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(completedResponse([messageItem("Chat-only answer.")])));
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      const result = await executeSenseAudioSearch({
        query: "senseaudio ungrounded chat fallback",
      });

      expect(result.error).toBe("senseaudio_web_search_ungrounded");
      expect(result.provider).toBe("senseaudio");
      expectStringFieldContains(result, "message", "without native web-search grounding");
    });
  });

  it("treats failed search calls without citations as ungrounded", async () => {
    const failedCall = {
      type: "web_search_call",
      status: "failed",
      action: { type: "search", query: "query", sources: [] },
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(completedResponse([failedCall, messageItem("Parametric answer.")])),
        ),
    );

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      const result = await executeSenseAudioSearch({ query: "senseaudio failed search call" });

      expect(result.error).toBe("senseaudio_web_search_ungrounded");
    });
  });

  it("rejects unsupported search filters before calling the API", async () => {
    const result = await executeSenseAudioSearch({
      query: "senseaudio filters",
      freshness: "week",
    });

    expect(result.error).toBe("unsupported_freshness");
  });

  it("reports malformed SenseAudio JSON with a stable provider error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{ nope")));

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      await expect(
        executeSenseAudioSearch({ query: "senseaudio malformed response" }),
      ).rejects.toThrow("SenseAudio API error: malformed JSON response");
    });
  });

  it("rejects wrong-root SenseAudio success JSON with a stable provider error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      await expect(
        executeSenseAudioSearch({ query: "senseaudio wrong root response" }),
      ).rejects.toThrow("SenseAudio API error: malformed JSON response");
    });
  });

  it("rejects responses without final message text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(completedResponse([searchCallItem([])]))),
    );

    await withEnvAsync({ SENSEAUDIO_API_KEY: "sense-test-key" }, async () => {
      await expect(
        executeSenseAudioSearch({ query: "senseaudio missing final message" }),
      ).rejects.toThrow("SenseAudio API error: malformed JSON response");
    });
  });

  it("surfaces API error objects and non-completed statuses", () => {
    expect(() =>
      testing.parseSenseAudioSearchResponse({ error: { message: "quota exceeded" } }),
    ).toThrow("SenseAudio API error: quota exceeded");
    expect(() =>
      testing.parseSenseAudioSearchResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).toThrow('SenseAudio API error: response status "incomplete" (max_output_tokens)');
  });
});
