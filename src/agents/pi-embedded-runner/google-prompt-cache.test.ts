import crypto from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "../pi-ai-contract.js";
import { prepareGooglePromptCacheStreamFn } from "./google-prompt-cache.js";

type SessionCustomEntry = {
  type: "custom";
  id: string;
  parentId: string | null;
  timestamp: string;
  customType: string;
  data: unknown;
};

function makeSessionManager(entries: SessionCustomEntry[] = []) {
  let counter = 0;
  return {
    appendCustomEntry(customType: string, data: unknown) {
      counter += 1;
      const id = `entry-${counter}`;
      entries.push({
        type: "custom",
        id,
        parentId: null,
        timestamp: new Date(counter * 1_000).toISOString(),
        customType,
        data,
      });
      return id;
    },
    getEntries() {
      return entries;
    },
  };
}

function makeGoogleModel(id = "gemini-3.1-pro-preview") {
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

function createCacheFetchMock(params: { name: string; expireTime: string }) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(params), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function createCapturingStreamFn(result = "stream") {
  let capturedPayload: Record<string, unknown> | undefined;
  const streamFn = vi.fn(
    (
      model: Parameters<StreamFn>[0],
      _context: Parameters<StreamFn>[1],
      options: Parameters<StreamFn>[2],
    ) => {
      const payload: Record<string, unknown> = {};
      void options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return result as never;
    },
  );
  return {
    streamFn,
    getCapturedPayload: () => capturedPayload,
  };
}

function preparePromptCacheStream(params: {
  fetchMock: ReturnType<typeof vi.fn>;
  now: number;
  sessionManager: ReturnType<typeof makeSessionManager>;
  streamFn: StreamFn;
}) {
  return prepareGooglePromptCacheStreamFn(
    {
      apiKey: "gemini-api-key",
      extraParams: { cacheRetention: "long" },
      model: makeGoogleModel(),
      modelId: "gemini-3.1-pro-preview",
      provider: "google",
      sessionManager: params.sessionManager,
      streamFn: params.streamFn,
      systemPrompt: "Follow policy.",
    },
    {
      buildGuardedFetch: () => params.fetchMock as typeof fetch,
      now: () => params.now,
    },
  );
}

describe("google prompt cache", () => {
  it("creates cached content from the system prompt and strips that prompt from live requests", async () => {
    const now = 1_000_000;
    const entries: SessionCustomEntry[] = [];
    const sessionManager = makeSessionManager(entries);
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/system-cache-1",
      expireTime: new Date(now + 3_600_000).toISOString(),
    });
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn();

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    expect(wrapped).toBeTypeOf("function");
    void wrapped?.(
      makeGoogleModel(),
      {
        systemPrompt: "Follow policy.",
        messages: [],
        tools: [
          {
            name: "lookup",
            description: "Look up a value",
            parameters: { type: "object" },
          },
        ],
      } as never,
      { temperature: 0.2 } as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-goog-api-key": "gemini-api-key",
          "X-Provider": "google",
        }),
      }),
    );
    const createBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(createBody).toEqual({
      model: "models/gemini-3.1-pro-preview",
      ttl: "3600s",
      systemInstruction: {
        parts: [{ text: "Follow policy." }],
      },
    });
    expect(innerStreamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        systemPrompt: undefined,
        tools: expect.any(Array),
      }),
      expect.objectContaining({ temperature: 0.2 }),
    );
    expect(getCapturedPayload()).toMatchObject({
      cachedContent: "cachedContents/system-cache-1",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.customType).toBe("openclaw.google-prompt-cache");
    expect((entries[0]?.data as { status?: string; cachedContent?: string })?.status).toBe("ready");
  });

  it("reuses a persisted cache entry without creating a second cache", async () => {
    const now = 2_000_000;
    const entries: SessionCustomEntry[] = [];
    const sessionManager = makeSessionManager(entries);
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/system-cache-2",
      expireTime: new Date(now + 3_600_000).toISOString(),
    });

    await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: vi.fn(() => "first" as never),
    });

    fetchMock.mockClear();
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn("second");
    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now: now + 30_000,
      sessionManager,
      streamFn: innerStreamFn,
    });

    void wrapped?.(
      makeGoogleModel(),
      { systemPrompt: "Follow policy.", messages: [] } as never,
      {} as never,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(innerStreamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ systemPrompt: undefined }),
      expect.any(Object),
    );
    expect(getCapturedPayload()).toMatchObject({
      cachedContent: "cachedContents/system-cache-2",
    });
  });

  it("refreshes an about-to-expire cache entry instead of creating a new one", async () => {
    const now = 3_000_000;
    const expireSoon = new Date(now + 60_000).toISOString();
    const systemPromptDigest = crypto.createHash("sha256").update("Follow policy.").digest("hex");
    const sessionManager = makeSessionManager([
      {
        id: "entry-1",
        parentId: null,
        timestamp: new Date(now - 5_000).toISOString(),
        type: "custom",
        customType: "openclaw.google-prompt-cache",
        data: {
          status: "ready",
          timestamp: now - 5_000,
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
          modelApi: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          systemPromptDigest,
          cacheRetention: "long",
          cachedContent: "cachedContents/system-cache-3",
          expireTime: expireSoon,
        },
      },
    ]);
    const fetchMock = createCacheFetchMock({
      name: "cachedContents/system-cache-3",
      expireTime: new Date(now + 3_600_000).toISOString(),
    });
    const { streamFn: innerStreamFn, getCapturedPayload } = createCapturingStreamFn();

    const wrapped = await preparePromptCacheStream({
      fetchMock,
      now,
      sessionManager,
      streamFn: innerStreamFn,
    });

    void wrapped?.(
      makeGoogleModel(),
      { systemPrompt: "Follow policy.", messages: [] } as never,
      {} as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents/system-cache-3?updateMask=ttl",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH" });
    expect(innerStreamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ systemPrompt: undefined }),
      expect.any(Object),
    );
    expect(getCapturedPayload()).toMatchObject({
      cachedContent: "cachedContents/system-cache-3",
    });
  });

  it("stays out of the way when cachedContent is already configured explicitly", async () => {
    const fetchMock = vi.fn();

    const wrapped = await prepareGooglePromptCacheStreamFn(
      {
        apiKey: "gemini-api-key",
        extraParams: {
          cacheRetention: "long",
          cachedContent: "cachedContents/already-set",
        },
        model: makeGoogleModel(),
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
        sessionManager: makeSessionManager(),
        streamFn: vi.fn(() => "stream" as never),
        systemPrompt: "Follow policy.",
      },
      {
        buildGuardedFetch: () => fetchMock as typeof fetch,
        now: () => 0,
      },
    );

    expect(wrapped).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
