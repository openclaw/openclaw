import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, vi } from "vitest";
import * as providerFetch from "../provider-transport-fetch.js";
import { prepareGooglePromptCacheStreamFn } from "./google-prompt-cache.js";

afterEach(() => vi.restoreAllMocks());

export type SessionCustomEntry = {
  type: "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data: unknown;
};

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
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    headers: { "X-Provider": "google" },
  } satisfies Model<"google-generative-ai">;
}

export function createCacheFetchMock(name: string, expireTime = new Date(4_600_000).toISOString()) {
  return vi.fn().mockResolvedValue(Response.json({ name, expireTime }));
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

export function callArg(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
  argIndex: number,
) {
  const call = mock.mock.calls[callIndex];
  if (!call || argIndex >= call.length) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

export function fetchInit(fetchMock: { mock: { calls: unknown[][] } }, callIndex = 0): RequestInit {
  const init = callArg(fetchMock, callIndex, 1);
  if (!init || typeof init !== "object") {
    throw new Error(`expected fetch init for call ${callIndex}`);
  }
  return init as RequestInit;
}

export function fetchUrl(fetchMock: { mock: { calls: unknown[][] } }, callIndex = 0): string {
  return String(callArg(fetchMock, callIndex, 0));
}

export function streamContext(streamFn: { mock: { calls: unknown[][] } }, callIndex = 0) {
  return callArg(streamFn, callIndex, 1) as {
    systemPrompt?: unknown;
    tools?: unknown;
  };
}

export function streamOptions(streamFn: { mock: { calls: unknown[][] } }, callIndex = 0) {
  return callArg(streamFn, callIndex, 2) as Record<string, unknown>;
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
  },
) {
  const { entries = [], ...options } = params;
  const capture = createCapturingStreamFn();
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
  await wrapped(
    makeGoogleModel(),
    { systemPrompt: `Follow policy.${SYSTEM_PROMPT_CACHE_BOUNDARY}`, messages: [] },
    {},
  );
  const entry = entries[0];
  if (!entry?.data || typeof entry.data !== "object") {
    throw new Error("Expected the cache owner to persist a ready entry");
  }
  return { ...entry, data: entry.data };
}
