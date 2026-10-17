// Coverage for Google prompt-cache creation, reuse, and request rewriting.
import crypto from "node:crypto";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import type { Context } from "../../llm/types.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { mintSecretSentinel, resolveSecretSentinel } from "../../secrets/sentinel.js";
import * as providerFetch from "../provider-transport-fetch.js";
import { prepareGooglePromptCacheStreamFn } from "./google-prompt-cache.js";
import {
  callArg,
  createCacheFetchMock,
  createCapturingStreamFn,
  createOversizedJsonResponse,
  createReadyGooglePromptCacheEntry,
  fetchInit,
  fetchUrl,
  makeGoogleModel,
  makeSessionManager,
  preparePromptCacheStream,
  setupPromptCache,
  type SessionCustomEntry,
  streamContext,
  streamOptions,
} from "./google-prompt-cache.test-support.js";
import { buildRuntimeContextCustomMessage } from "./run/runtime-context-prompt.js";

function invoke(
  wrapped: Awaited<ReturnType<typeof preparePromptCacheStream>>,
  context: Context = {
    systemPrompt: `Follow policy.${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
    messages: [],
  },
  options: Parameters<NonNullable<typeof wrapped>>[2] = {},
) {
  return Promise.resolve(wrapped?.(makeGoogleModel(), context, options));
}

async function setupRefresh(response?: Response) {
  const now = 3_000_000;
  const entries = [
    await createReadyGooglePromptCacheEntry({
      now,
      cachedContent: "cachedContents/refresh",
      expireTime: new Date(now + 60_000).toISOString(),
    }),
  ];
  const fetchMock = response
    ? vi.fn(async () => response)
    : createCacheFetchMock("cachedContents/refresh", new Date(now + 3_600_000).toISOString());
  return { ...(await setupPromptCache({ now, entries, fetchMock })), fetchMock };
}

describe("google prompt cache", () => {
  it("keeps one stable resource across suffix changes, tool loops, and reload", async () => {
    const entries: SessionCustomEntry[] = [];
    const fetchMock = vi.fn(async () =>
      Response.json({
        name: `cachedContents/stable-${fetchMock.mock.calls.length}`,
        expireTime: new Date(4_600_000).toISOString(),
      }),
    );
    const { streamFn, getCapturedPayload } = createCapturingStreamFn();
    const prepare = (sessionEntries = entries) =>
      preparePromptCacheStream({
        fetchMock,
        sessionManager: makeSessionManager(sessionEntries),
        streamFn,
      });
    const wrapped = expectDefined(await prepare(), "cache wrapper");
    const carrier = expectDefined(buildRuntimeContextCustomMessage("Current facts"), "carrier");
    const messages: Context["messages"] = [
      { role: "user", content: "Question", timestamp: 1 },
      {
        role: "user",
        content: `OpenClaw runtime context:\n${carrier.content}`,
        timestamp: 2,
        runtimeContext: {},
      },
    ];
    const tools = [{ name: "lookup", description: "Lookup", parameters: Type.Object({}) }];
    for (const suffix of ["Date A", "Date B", "Date B"]) {
      await wrapped(
        makeGoogleModel(),
        {
          systemPrompt: `Stable policy${SYSTEM_PROMPT_CACHE_BOUNDARY}${suffix}`,
          messages,
          tools,
        },
        {},
      );
      expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/stable-1");
      expect(streamFn.mock.lastCall?.[1].messages).toEqual([
        messages[0],
        {
          ...messages[1],
          content: `OpenClaw runtime context:\n${suffix}\n\nCurrent facts`,
        },
      ]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = fetchInit(fetchMock).body;
    if (typeof body !== "string") {
      throw new Error("Expected a JSON cache request body");
    }
    expect(JSON.parse(body).systemInstruction).toEqual({
      parts: [{ text: "Stable policy" }],
    });
    expect(messages[1]?.content).toBe(`OpenClaw runtime context:\n${carrier.content}`);
    const restarted = expectDefined(await prepare(structuredClone(entries)), "reloaded wrapper");
    const nextContext = {
      systemPrompt: `Stable policy${SYSTEM_PROMPT_CACHE_BOUNDARY}Date C`,
      messages,
      tools,
    };
    await restarted(makeGoogleModel(), nextContext, {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/stable-1");
    await restarted(
      makeGoogleModel(),
      { ...nextContext, tools: [{ ...tools[0]!, description: "New lookup" }] },
      {},
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/stable-2");
  });

  it("keeps the full inline prompt during stable-prefix failure backoff", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const { streamFn, getCapturedPayload, wrapped } = await setupPromptCache({ fetchMock });
    for (const suffix of ["Date A", "Date B"]) {
      const context = {
        systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}${suffix}`,
        messages: [],
      };
      await wrapped(makeGoogleModel(), context, {});
      expect(streamFn.mock.lastCall?.[1]).toBe(context);
      expect(getCapturedPayload()).not.toHaveProperty("cachedContent");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["api-key", "header", "project", "request-header"] as const)(
    "rebuilds cached content when the effective %s scope changes",
    async (scope) => {
      const sessionManager = makeSessionManager();
      const fetchMock = vi.fn(async () =>
        Response.json({
          name: `cachedContents/scope-${fetchMock.mock.calls.length}`,
          expireTime: new Date(4_600_000).toISOString(),
        }),
      );
      const { streamFn, getCapturedPayload } = createCapturingStreamFn();
      for (const [index, value] of ["first", "second"].entries()) {
        const model = makeGoogleModel();
        const headers: Record<string, string> =
          scope === "header" || scope === "request-header"
            ? { "x-goog-api-key": value }
            : scope === "project"
              ? { "x-goog-user-project": value }
              : {};
        const wrapped = await preparePromptCacheStream({
          apiKey: scope === "api-key" ? value : "same-key",
          fetchMock,
          sessionManager,
          streamFn,
          model: {
            ...model,
            headers: scope === "request-header" ? model.headers : { ...model.headers, ...headers },
          },
        });
        await invoke(wrapped, undefined, scope === "request-header" ? { headers } : {});
        expect(getCapturedPayload()?.cachedContent).toBe(`cachedContents/scope-${index + 1}`);
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(streamOptions(streamFn, 1).headers).toMatchObject({
        "x-goog-api-key": scope === "project" ? "same-key" : "second",
        ...(scope === "project" ? { "x-goog-user-project": "second" } : {}),
      });
    },
  );

  it("keeps boundary-free prompts inline", async () => {
    const fetchMock = vi.fn();
    const { streamFn, wrapped } = await setupPromptCache({ fetchMock });
    const context = { systemPrompt: "Complete inline policy", messages: [] };
    await wrapped(makeGoogleModel(), context, {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamFn.mock.lastCall?.[1]).toBe(context);
  });

  it("rebuilds the cache when the final prompt changes and reuses it after restart", async () => {
    const entries: SessionCustomEntry[] = [];
    const fetchMock = vi.fn(async () =>
      Response.json({
        name: `cachedContents/final-${fetchMock.mock.calls.length}`,
        expireTime: new Date(4_600_000).toISOString(),
      }),
    );
    const { streamFn, getCapturedPayload } = createCapturingStreamFn();
    const prepare = () =>
      preparePromptCacheStream({
        fetchMock,
        sessionManager: makeSessionManager(entries),
        streamFn,
      });
    const wrapped = expectDefined(await prepare(), "managed cache wrapper");
    const tool = {
      name: "lookup",
      description: "Look up a value",
      parameters: Type.Object({}),
    };
    const context = {
      systemPrompt: `hook-before\nbase\nhook-after${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
      messages: [],
      tools: [tool],
    };
    await wrapped(makeGoogleModel(), context, {});
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/final-1");

    const changedContext = {
      ...context,
      systemPrompt: `new-hook-instruction\n${context.systemPrompt}`,
    };
    await wrapped(makeGoogleModel(), changedContext, {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/final-2");

    const restarted = expectDefined(await prepare(), "restarted managed cache wrapper");
    await restarted(makeGoogleModel(), changedContext, {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/final-2");
  });
  it("parses sentinel-backed OAuth JSON before guarded cache egress", async () => {
    const fetchMock = createCacheFetchMock(
      "cachedContents/oauth-cache",
      new Date(2_000_000).toISOString(),
    );
    const oauthJson = JSON.stringify({ token: "google-oauth-token", projectId: "demo" });
    const sentinel = mintSecretSentinel(oauthJson, { label: "model-auth:google" });
    const { wrapped, sessionManager, streamFn } = await setupPromptCache({
      apiKey: sentinel,
      fetchMock,
    });

    await invoke(wrapped);

    const headers = fetchInit(fetchMock).headers as Record<string, string>;
    expect(
      resolveSecretSentinel(
        expectDefined(headers.Authorization, "headers.Authorization test invariant"),
      ),
    ).toBe("Bearer google-oauth-token");
    expect(headers["x-goog-api-key"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
    const restarted = await preparePromptCacheStream({
      apiKey: mintSecretSentinel(oauthJson, { label: "model-auth:google-reloaded" }),
      fetchMock,
      sessionManager,
      streamFn,
    });
    await invoke(restarted);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sessionManager.getEntries())).not.toContain("google-oauth-token");
    expect(JSON.stringify(sessionManager.getEntries())).not.toContain("oc-sent-v2.");
  });

  it("registers parsed OAuth headers when sentinels are disabled", async () => {
    vi.stubEnv("OPENCLAW_SECRET_SENTINELS", "off");
    const fetchMock = createCacheFetchMock(
      "cachedContents/oauth-cache",
      new Date(2_000_000).toISOString(),
    );
    const oauthJson = JSON.stringify({ token: "google-kill-switch-token", projectId: "demo" });
    const apiKey = mintSecretSentinel(oauthJson, { label: "model-auth:google" });

    try {
      const { wrapped } = await setupPromptCache({ apiKey, fetchMock });
      await invoke(wrapped);

      const headers = fetchInit(fetchMock).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer google-kill-switch-token");
      expect(
        isSecretValueRegisteredForRedaction(
          expectDefined(headers.Authorization, "headers.Authorization test invariant"),
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("creates cached content from the system prompt and strips that prompt from live requests", async () => {
    const now = 1_000_000;
    const expireTime = new Date(now + 3_600_000).toISOString();
    const systemPromptDigest = crypto.createHash("sha256").update("Follow policy.").digest("hex");
    const fetchMock = createCacheFetchMock("cachedContents/system-cache-1", expireTime);
    const providerMetadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "google",
          providers: ["google"],
          providerEndpoints: [
            {
              endpointClass: "google-generative-ai",
              hosts: ["generativelanguage.googleapis.com"],
            },
          ],
        },
      ],
    });

    const { wrapped, entries, streamFn, getCapturedPayload } = await setupPromptCache({
      fetchMock,
      now,
    });

    expect(wrapped).toBeTypeOf("function");
    expect(fetchMock).not.toHaveBeenCalled();
    await withPluginMetadataSnapshotScope(providerMetadata, () =>
      wrapped?.(
        makeGoogleModel(),
        {
          systemPrompt: `Follow policy.${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
          messages: [],
          tools: [
            {
              name: "lookup",
              description: "Look up a value",
              parameters: { type: "object" },
            },
          ],
        } as never,
        { temperature: 0.2, toolChoice: "auto" } as never,
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callArg(fetchMock, 0, 0)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents",
    );
    const createInit = fetchInit(fetchMock);
    expect(createInit.method).toBe("POST");
    const createHeaders = createInit.headers as Record<string, string>;
    expect(createHeaders).toMatchObject({
      "x-goog-api-key": "gemini-api-key",
      "X-Provider": "google",
    });
    expect(createHeaders["x-goog-api-client"]).toMatch(/^openclaw\//u);
    expect(typeof createInit.body).toBe("string");
    const createBody = JSON.parse(createInit.body as string) as Record<string, unknown>;
    expect(createBody).toEqual({
      model: "models/gemini-3.1-pro-preview",
      ttl: "3600s",
      systemInstruction: { parts: [{ text: "Follow policy." }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: "lookup",
              description: "Look up a value",
              parametersJsonSchema: { type: "object" },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    });
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(streamContext(streamFn)).toMatchObject({ systemPrompt: undefined, tools: undefined });
    expect(streamOptions(streamFn)).toMatchObject({ temperature: 0.2, toolChoice: "auto" });
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/system-cache-1");
    expect(entries).toEqual([
      {
        type: "custom",
        id: "entry-1",
        parentId: null,
        timestamp: new Date(1_000).toISOString(),
        customType: "openclaw.google-prompt-cache",
        data: {
          status: "ready",
          timestamp: now,
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
          modelApi: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          systemPromptDigest,
          cacheConfigDigest: expect.any(String),
          cacheRetention: "long",
          cachedContent: "cachedContents/system-cache-1",
          expireTime,
        },
      },
    ]);
  });

  it("reuses managed cached content when tool discovery order changes", async () => {
    const fetchMock = createCacheFetchMock("cachedContents/stable-tool-order");
    const { wrapped, entries, getCapturedPayload } = await setupPromptCache({ fetchMock });
    const tools = [
      {
        name: "zeta_lookup",
        description: "Look up the last value",
        parameters: { type: "object", properties: { value: { type: "string" } } },
      },
      {
        name: "alpha_lookup",
        description: "Look up the first value",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ];

    for (const orderedTools of [tools, tools.toReversed()]) {
      await invoke(
        wrapped,
        {
          systemPrompt: `Follow policy.${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
          messages: [],
          tools: orderedTools,
        } as never,
        { toolChoice: "auto" } as never,
      );
      expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/stable-tool-order");
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    const createBody = JSON.parse(fetchInit(fetchMock).body as string) as {
      tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
    };
    expect(createBody.tools[0]?.functionDeclarations.map((tool) => tool.name)).toEqual([
      "alpha_lookup",
      "zeta_lookup",
    ]);
  });

  it("cancels failed cache creation response bodies", async () => {
    const now = 1_500_000;
    const response = new Response("permission denied", { status: 403 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchMock = vi.fn(async () => response);
    const { wrapped, entries, streamFn } = await setupPromptCache({ fetchMock, now });

    await invoke(wrapped);

    expect(cancel).toHaveBeenCalledOnce();
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(streamContext(streamFn).systemPrompt).toBe(
      `Follow policy.${SYSTEM_PROMPT_CACHE_BOUNDARY}`,
    );
    expect(entries[0]?.data).toMatchObject({
      status: "failed",
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
    });
  });

  it("propagates writer-claim rebound from cache entry persistence", async () => {
    const now = 2_500_000;
    const takeoverError = new SessionTranscriptWriterClaimReboundError();
    const sessionManager = {
      appendCustomEntryAsync: vi.fn(async () => {
        throw takeoverError;
      }),
      getEntries: vi.fn(() => []),
    };
    const fetchMock = createCacheFetchMock(
      "cachedContents/system-cache-takeover",
      new Date(now + 3_600_000).toISOString(),
    );
    const { wrapped, streamFn } = await setupPromptCache({
      fetchMock,
      now,
      sessionManager,
    });

    await expect(invoke(wrapped)).rejects.toBe(takeoverError);
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("refreshes an about-to-expire cache entry instead of creating a new one", async () => {
    const { wrapped, streamFn, getCapturedPayload, fetchMock } = await setupRefresh();

    await invoke(wrapped);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl(fetchMock)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents/refresh?updateMask=ttl",
    );
    expect(fetchInit(fetchMock).method).toBe("PATCH");
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(streamContext(streamFn).systemPrompt).toBeUndefined();
    expect(typeof streamOptions(streamFn)).toBe("object");
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/refresh");
  });

  it("cancels failed cache refresh response bodies", async () => {
    const response = new Response("refresh denied", { status: 403 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const { wrapped, entries, getCapturedPayload } = await setupRefresh(response);

    await invoke(wrapped);

    expect(cancel).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/refresh");
  });

  it("does not bypass failed-cache backoff when the process clock is invalid", async () => {
    const systemPromptDigest = crypto.createHash("sha256").update("Follow policy.").digest("hex");
    const sessionManager = makeSessionManager();
    await sessionManager.appendCustomEntryAsync("openclaw.google-prompt-cache", {
      status: "failed",
      timestamp: 1_000,
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      modelApi: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      systemPromptDigest,
      cacheRetention: "long",
      retryAfter: Date.parse("2030-01-01T00:00:00.000Z"),
    });
    const fetchMock = createCacheFetchMock(
      "cachedContents/system-cache-invalid-clock",
      "2030-01-01T00:00:00.000Z",
    );
    const { wrapped, streamFn } = await setupPromptCache({
      fetchMock,
      now: Number.NaN,
      sessionManager,
    });

    await invoke(wrapped);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamFn).toHaveBeenCalledTimes(1);
  });

  it("bypasses automatic validation for explicit cachedContent", async () => {
    const fetchMock = vi.fn();
    vi.spyOn(providerFetch, "buildGuardedModelFetch").mockReturnValue(fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(0);

    const wrapped = await prepareGooglePromptCacheStreamFn({
      apiKey: "gemini-api-key",
      extraParams: {
        cacheRetention: "long",
        cachedContent: "cachedContents/operator?supplied#verbatim",
      },
      model: makeGoogleModel(),
      modelId: "gemini-3.1-pro-preview",
      provider: "google",
      sessionManager: makeSessionManager(),
      streamFn: vi.fn(() => "stream" as never),
    });

    expect(wrapped).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds an oversized cache-refresh response body instead of buffering it", async () => {
    const { response, cancel } = createOversizedJsonResponse();
    const { wrapped, getCapturedPayload, fetchMock } = await setupRefresh(response);

    // A failed refresh must cancel the oversized body and reuse the valid resource.
    await invoke(wrapped);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchUrl(fetchMock)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/cachedContents/refresh?updateMask=ttl",
    );
    expect(fetchInit(fetchMock).method).toBe("PATCH");
    expect(cancel).toHaveBeenCalledOnce();
    expect(getCapturedPayload()?.cachedContent).toBe("cachedContents/refresh");
  });
});
