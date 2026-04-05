import crypto from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
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
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    headers: { "X-Provider": "google" },
    reasoning: true,
  } satisfies Model<"google-generative-ai">;
}

describe("google prompt cache", () => {
  it("creates cached content from the system prompt and strips that prompt from live requests", async () => {
    const now = 1_000_000;
    const entries: SessionCustomEntry[] = [];
    const sessionManager = makeSessionManager(entries);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "cachedContents/system-cache-1",
          expireTime: new Date(now + 3_600_000).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    let capturedPayload: Record<string, unknown> | undefined;
    const innerStreamFn = vi.fn(
      (
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        const payload: Record<string, unknown> = {};
        void options?.onPayload?.(payload, model);
        capturedPayload = payload;
        return "stream" as never;
      },
    );

    const wrapped = await prepareGooglePromptCacheStreamFn(
      {
        apiKey: "gemini-api-key",
        extraParams: { cacheRetention: "long" },
        model: makeGoogleModel(),
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
        sessionManager,
        streamFn: innerStreamFn,
        systemPrompt: "Follow policy.",
      },
      {
        buildGuardedFetch: () => fetchMock as typeof fetch,
        now: () => now,
      },
    );

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
    expect(capturedPayload).toMatchObject({
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "cachedContents/system-cache-2",
          expireTime: new Date(now + 3_600_000).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await prepareGooglePromptCacheStreamFn(
      {
        apiKey: "gemini-api-key",
        extraParams: { cacheRetention: "long" },
        model: makeGoogleModel(),
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
        sessionManager,
        streamFn: vi.fn(() => "first" as never),
        systemPrompt: "Follow policy.",
      },
      {
        buildGuardedFetch: () => fetchMock as typeof fetch,
        now: () => now,
      },
    );

    fetchMock.mockClear();
    let capturedPayload: Record<string, unknown> | undefined;
    const innerStreamFn = vi.fn(
      (
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        const payload: Record<string, unknown> = {};
        void options?.onPayload?.(payload, model);
        capturedPayload = payload;
        return "second" as never;
      },
    );
    const wrapped = await prepareGooglePromptCacheStreamFn(
      {
        apiKey: "gemini-api-key",
        extraParams: { cacheRetention: "long" },
        model: makeGoogleModel(),
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
        sessionManager,
        streamFn: innerStreamFn,
        systemPrompt: "Follow policy.",
      },
      {
        buildGuardedFetch: () => fetchMock as typeof fetch,
        now: () => now + 30_000,
      },
    );

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
    expect(capturedPayload).toMatchObject({
      cachedContent: "cachedContents/system-cache-2",
    });
  });

  it("refreshes an about-to-expire cache entry instead of creating a new one", async () => {
    const now = 3_000_000;
    const expireSoon = new Date(now + 60_000).toISOString();
    const systemPromptDigest = crypto.createHash("sha256").update("Follow policy.").digest("hex");
    const sessionManager = makeSessionManager([
      {
        type: "custom",
        id: "entry-1",
        parentId: null,
        timestamp: new Date(now - 5_000).toISOString(),
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "cachedContents/system-cache-3",
          expireTime: new Date(now + 3_600_000).toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    let capturedPayload: Record<string, unknown> | undefined;
    const innerStreamFn = vi.fn(
      (
        model: Parameters<StreamFn>[0],
        _context: Parameters<StreamFn>[1],
        options: Parameters<StreamFn>[2],
      ) => {
        const payload: Record<string, unknown> = {};
        void options?.onPayload?.(payload, model);
        capturedPayload = payload;
        return "stream" as never;
      },
    );

    const wrapped = await prepareGooglePromptCacheStreamFn(
      {
        apiKey: "gemini-api-key",
        extraParams: { cacheRetention: "long" },
        model: makeGoogleModel(),
        modelId: "gemini-3.1-pro-preview",
        provider: "google",
        sessionManager,
        streamFn: innerStreamFn,
        systemPrompt: "Follow policy.",
      },
      {
        buildGuardedFetch: () => fetchMock as typeof fetch,
        now: () => now,
      },
    );

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
    expect(capturedPayload).toMatchObject({
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
