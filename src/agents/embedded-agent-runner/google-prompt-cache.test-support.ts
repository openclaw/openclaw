import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, vi } from "vitest";
import type { Context } from "../../llm/types.js";
import * as providerFetch from "../provider-transport-fetch.js";
import type { CustomEntry } from "../sessions/session-manager-types.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { prepareGooglePromptCacheStreamFn } from "./google-prompt-cache.js";

afterEach(() => vi.restoreAllMocks());

export type SessionCustomEntry = CustomEntry & { data: unknown };

export function makeSessionManager(entries: SessionCustomEntry[] = []) {
  let counter = 0;
  return {
    async appendCustomEntryAsync(customType: string, data: unknown) {
      counter += 1;
      entries.push({
        type: "custom" as const,
        id: `entry-${counter}`,
        parentId: null,
        timestamp: new Date(counter * 1_000).toISOString(),
        customType,
        data,
      });
    },
    getEntries: () => entries,
  };
}

export function makeGoogleModel(id = "gemini-3.1-pro-preview") {
  return makeProviderModelFixture<"google-generative-ai">({
    id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    contextWindow: 128000,
    maxTokens: 8192,
    headers: { "X-Provider": "google" },
  });
}

export function createCacheFetchMock(name: string, expireTime = new Date(4_600_000).toISOString()) {
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json({ name, expireTime }));
}

export function createOversizedJsonResponse() {
  const cancel = vi.fn(async () => undefined);
  let pullCount = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(pullCount === 1 ? 1024 * 1024 + 1 : 1));
      },
      cancel,
    }),
    { headers: { "content-type": "application/json" } },
  );
  return { response, cancel };
}

export function createCapturingStreamFn(result = "stream") {
  let capturedPayload: Record<string, unknown> | undefined;
  const streamFn = vi.fn((...[model, _context, options]: Parameters<StreamFn>) => {
    const payload: Record<string, unknown> = {};
    void options?.onPayload?.(payload, model);
    capturedPayload = payload;
    return result as never;
  });
  return { streamFn, getCapturedPayload: () => capturedPayload };
}

export function promptContext(overrides: Partial<Context> = {}): Context {
  return {
    systemPrompt: `Follow policy.${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
    messages: [],
    ...overrides,
  };
}

export function preparePromptCacheStream(params: {
  apiKey?: string;
  fetchMock?: typeof fetch;
  model?: ReturnType<typeof makeGoogleModel>;
  now?: number;
  sessionManager?: ReturnType<typeof makeSessionManager>;
  signal?: AbortSignal;
  streamFn: StreamFn;
}) {
  const model = params.model ?? makeGoogleModel();
  vi.spyOn(Date, "now").mockReturnValue(params.now ?? 1_000_000);
  if (params.fetchMock) {
    vi.spyOn(providerFetch, "buildGuardedModelFetch").mockReturnValue(params.fetchMock);
  }
  return prepareGooglePromptCacheStreamFn({
    apiKey: params.apiKey ?? "gemini-api-key",
    extraParams: { cacheRetention: "long" },
    model,
    modelId: model.id,
    provider: "google",
    sessionManager: params.sessionManager ?? makeSessionManager(),
    signal: params.signal,
    streamFn: params.streamFn,
  });
}

export async function setupPromptCache(
  params: Omit<Parameters<typeof preparePromptCacheStream>[0], "streamFn"> & {
    entries?: SessionCustomEntry[];
    result?: string;
  },
) {
  const { entries = [], result, ...options } = params;
  const capture = createCapturingStreamFn(result);
  const sessionManager = params.sessionManager ?? makeSessionManager(entries);
  const wrapped = expectDefined(
    await preparePromptCacheStream({
      ...options,
      sessionManager,
      streamFn: capture.streamFn,
    }),
    "cache wrapper",
  );
  return { ...capture, entries, sessionManager, wrapped };
}

export async function createReadyGooglePromptCacheEntry(params: {
  now: number;
  cachedContent?: string;
  expireTime?: string;
}) {
  const entries: SessionCustomEntry[] = [];
  const { wrapped } = await setupPromptCache({
    now: params.now,
    entries,
    fetchMock: createCacheFetchMock(
      params.cachedContent ?? "cachedContents/existing",
      params.expireTime ?? new Date(params.now + 3_600_000).toISOString(),
    ),
  });
  await wrapped(makeGoogleModel(), promptContext(), {});
  const entry = entries[0];
  if (!entry?.data || typeof entry.data !== "object") {
    throw new Error("Expected the cache owner to persist a ready entry");
  }
  return { ...entry, data: entry.data };
}
