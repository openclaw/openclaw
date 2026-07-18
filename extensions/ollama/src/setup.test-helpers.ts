// Shared helpers for ollama setup tests.
import { jsonResponse, requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { vi } from "vitest";

export function createOllamaFetchMock(params: {
  tags?: string[];
  show?: Record<string, number | undefined>;
  capabilities?: Record<string, string[] | undefined>;
  pullResponse?: Response;
  tagsError?: Error;
  meResponse?: Response;
}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.endsWith("/api/tags")) {
      if (params.tagsError) {
        throw params.tagsError;
      }
      return jsonResponse({ models: (params.tags ?? []).map((name) => ({ name })) });
    }
    if (url.endsWith("/api/show")) {
      const body = JSON.parse(requestBodyText(init?.body)) as { name?: string };
      const contextWindow = body.name ? params.show?.[body.name] : undefined;
      const capabilities = body.name
        ? params.capabilities === undefined
          ? ["tools"]
          : params.capabilities[body.name]
        : undefined;
      return jsonResponse({
        ...(contextWindow ? { model_info: { "llama.context_length": contextWindow } } : {}),
        ...(capabilities ? { capabilities } : {}),
      });
    }
    if (url.endsWith("/api/me")) {
      return params.meResponse ?? jsonResponse({});
    }
    if (url.endsWith("/api/pull")) {
      return params.pullResponse ?? new Response('{"status":"success"}\n', { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

export function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mock.mock.calls.at(index)?.at(argIndex);
}

export function createDefaultOllamaConfig(primary: string) {
  return {
    agents: { defaults: { model: { primary } } },
    models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
  };
}
