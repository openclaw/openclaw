import { beforeEach, describe, expect, it, vi } from "vitest";

type EndpointCall = {
  url: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  init?: RequestInit;
};

const endpointMockState: {
  calls: EndpointCall[];
  responses: Response[];
} = {
  calls: [],
  responses: [],
};

vi.mock("openclaw/plugin-sdk/provider-web-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-web-search")>();
  return {
    ...actual,
    withTrustedWebSearchEndpoint: vi.fn(
      async (params: EndpointCall, run: (response: Response) => Promise<unknown>) => {
        endpointMockState.calls.push(params);
        const response = endpointMockState.responses.shift();
        if (!response) {
          throw new Error("Missing mocked DuckDuckGo response.");
        }
        return await run(response);
      },
    ),
  };
});

const { runDuckDuckGoSearch } = await import("./ddg-client.js");

function htmlResponse(body = "<html><body>no results</body></html>") {
  return new Response(body, { headers: { "content-type": "text/html" }, status: 200 });
}

describe("runDuckDuckGoSearch User-Agent", () => {
  beforeEach(() => {
    endpointMockState.calls = [];
    endpointMockState.responses = [htmlResponse()];
  });

  it("sends an honest, plugin-identifying User-Agent instead of a spoofed browser UA", async () => {
    await runDuckDuckGoSearch({
      query: "OpenClaw DuckDuckGo request identity",
      cacheTtlMinutes: 0,
    });

    expect(endpointMockState.calls).toHaveLength(1);
    const headers = new Headers(endpointMockState.calls[0]?.init?.headers);
    const userAgent = headers.get("User-Agent");
    expect(userAgent).toMatch(/^openclaw-duckduckgo\//);
    expect(userAgent).not.toMatch(/Mozilla|Chrome|AppleWebKit/);
  });
});
