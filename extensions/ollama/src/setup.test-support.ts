import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { jsonResponse, requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { OllamaTagModel } from "./provider-models.js";
import { configureOllamaNonInteractive, promptAndConfigureOllama } from "./setup.js";

export const baseUrl = "http://127.0.0.1:11434";

export function createLocalPrompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  return {
    select: vi.fn().mockResolvedValueOnce("local-only"),
    text: vi.fn().mockResolvedValueOnce(baseUrl),
    note: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as WizardPrompter;
}

export function createOllamaFetchMock(params: {
  tags?: string[];
  tagModels?: OllamaTagModel[];
  fallbackCapabilities?: boolean;
  show?: Record<string, number | undefined>;
  capabilities?: Record<string, string[] | undefined>;
  showResponse?: (model: string) => Response;
  fallbackResponse?: (url: string) => Response;
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
      return jsonResponse({
        models: params.tagModels ?? (params.tags ?? []).map((name) => ({ name })),
      });
    }
    if (url.endsWith("/api/show")) {
      const { model } = JSON.parse(requestBodyText(init?.body)) as { model?: string };
      if (params.showResponse) {
        return params.showResponse(model ?? "");
      }
      const contextWindow = model ? params.show?.[model] : undefined;
      const capabilities = model
        ? params.capabilities === undefined
          ? ["tools"]
          : (params.capabilities[model] ?? (params.fallbackCapabilities ? ["tools"] : undefined))
        : params.fallbackCapabilities
          ? ["tools"]
          : undefined;
      return jsonResponse({
        ...(contextWindow ? { model_info: { "llama.context_length": contextWindow } } : {}),
        ...(capabilities ? { capabilities } : {}),
      });
    }
    if (params.fallbackResponse) {
      return params.fallbackResponse(url);
    }
    if (url.endsWith("/api/me") && !params.fallbackCapabilities) {
      return params.meResponse ?? jsonResponse({});
    }
    if (url.endsWith("/api/pull")) {
      return params.pullResponse ?? new Response('{"status":"success"}\n', { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

export async function configureInteractive(
  options: Parameters<typeof createOllamaFetchMock>[0],
  overrides: Partial<WizardPrompter> = {},
) {
  const fetchMock = createOllamaFetchMock(options);
  vi.stubGlobal("fetch", fetchMock);
  const prompter = createLocalPrompter(overrides);
  const result = await promptAndConfigureOllama({ cfg: {}, prompter });
  return { result, prompter, fetchMock };
}

export function startNonInteractive(
  options: Parameters<typeof createOllamaFetchMock>[0],
  nextConfig: Parameters<typeof configureOllamaNonInteractive>[0]["nextConfig"] = {},
) {
  const fetchMock = createOllamaFetchMock(options);
  vi.stubGlobal("fetch", fetchMock);
  const runtime = createRuntimeSpies();
  return {
    fetchMock,
    runtime,
    nextConfig,
    configure: (opts: Parameters<typeof configureOllamaNonInteractive>[0]["opts"] = {}) =>
      configureOllamaNonInteractive({
        nextConfig,
        runtime,
        opts: { customBaseUrl: baseUrl, ...opts },
      }),
  };
}
