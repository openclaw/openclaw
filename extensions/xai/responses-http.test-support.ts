import { requestBodyText } from "openclaw/plugin-sdk/test-env";

type FetchCallSource = {
  mock: { calls: readonly (readonly [input?: unknown, init?: RequestInit])[] };
};

export function createXaiFetchInspectors(label: "code_execution" | "x_search") {
  function firstFetchCall(mockFetch: FetchCallSource) {
    const [call] = mockFetch.mock.calls;
    if (!call) {
      throw new Error(`expected ${label} fetch call`);
    }
    return call;
  }

  function firstFetchInit(mockFetch: FetchCallSource): RequestInit {
    const [, init] = firstFetchCall(mockFetch);
    if (!init || typeof init !== "object" || Array.isArray(init)) {
      throw new Error(`expected ${label} fetch init`);
    }
    return init;
  }

  return {
    firstFetchUrl: (mockFetch: FetchCallSource) => String(firstFetchCall(mockFetch)[0]),
    firstAuthorizationHeader: (mockFetch: FetchCallSource) =>
      new Headers(firstFetchInit(mockFetch).headers).get("Authorization"),
    parseFirstRequestBody: (mockFetch: FetchCallSource) =>
      JSON.parse(requestBodyText(firstFetchInit(mockFetch).body)) as Record<string, unknown>,
  };
}
