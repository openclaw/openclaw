import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { jsonResponse, requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureOllamaModelPulled, promptAndConfigureOllama } from "./setup.js";
import { checkOllamaCloudAuth } from "./setup.runtime.js";
import {
  configureInteractive,
  createLocalPrompter,
  createOllamaFetchMock,
  startNonInteractive,
} from "./setup.test-support.js";

const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: { url: string; init?: RequestInit; signal?: AbortSignal }) => ({
    response: await globalThis.fetch(params.url, {
      ...params.init,
      ...(params.signal ? { signal: params.signal } : {}),
    }),
    finalUrl: params.url,
    release: async () => {},
  })),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: Parameters<typeof actual.fetchWithSsrFGuard>) =>
      fetchWithSsrFGuardMock(...args),
  };
});

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mock.mock.calls.at(index)?.at(argIndex);
}

function abortReasonAsError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Request aborted", { cause: signal.reason });
}

function createDefaultOllamaConfig(primary: string) {
  return {
    agents: { defaults: { model: { primary } } },
    models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
  };
}

function ensurePulled(model: string, prompter: WizardPrompter) {
  return ensureOllamaModelPulled({ config: createDefaultOllamaConfig(model), model, prompter });
}

function pendingResponse(signal: AbortSignal | null | undefined, message: string) {
  return new Promise<Response>((_resolve, reject) => {
    if (!signal) {
      reject(new Error(message));
      return;
    }
    signal.addEventListener("abort", () => reject(abortReasonAsError(signal)), { once: true });
  });
}

describe("ollama setup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fetchWithSsrFGuardMock.mockClear();
  });

  it("Docker setup hints the host Ollama endpoint and uses it for blank input", async () => {
    vi.stubEnv("OPENCLAW_DOCKER_SETUP", "1");
    const text = vi.fn().mockResolvedValueOnce("");
    const { result, fetchMock } = await configureInteractive({ tags: ["llama3:8b"] }, { text });

    const baseUrlPrompt = mockCallArg(text) as {
      initialValue?: string;
      placeholder?: string;
      validate: (value: string) => string | undefined;
    };
    expect(baseUrlPrompt.initialValue).toBeUndefined();
    expect(baseUrlPrompt).toMatchObject({
      message: "Ollama base URL",
      placeholder: "http://host.docker.internal:11434",
    });
    expect(baseUrlPrompt.validate("https://ollama.com")).toContain("--auth-choice ollama-cloud");
    expect(mockCallArg(fetchMock)).toBe("http://host.docker.internal:11434/api/tags");
    expect(result.config.models?.providers?.ollama?.baseUrl).toBe(
      "http://host.docker.internal:11434",
    );
  });

  it("puts hybrid cloud model suggestions after the local default when signed in", async () => {
    const { result } = await configureInteractive(
      {
        tags: ["llama3:8b"],
        meResponse: jsonResponse({ user: "signed-in" }),
      },
      { select: vi.fn().mockResolvedValueOnce("cloud-local") },
    );
    const modelIds = result.config.models?.providers?.ollama?.models?.map((m) => m.id);

    expect(modelIds).toEqual([
      "gemma4",
      "minimax-m2.7:cloud",
      "minimax-m3:cloud",
      "kimi-k3:cloud",
      "glm-5.2:cloud",
      "llama3:8b",
    ]);
    expect(result.config.models?.providers?.ollama?.baseUrl).toBe("http://127.0.0.1:11434");
    expect(result.config.models?.providers?.ollama?.apiKey).toBe("ollama-local");
  });

  it("reports the configured host when the retry is still unreachable", async () => {
    const prompter = createLocalPrompter();
    prompter.confirm = vi.fn().mockResolvedValueOnce(true);
    const fetchMock = createOllamaFetchMock({ tagsError: new Error("down") });
    vi.stubGlobal("fetch", fetchMock);

    await expect(promptAndConfigureOllama({ cfg: {}, prompter })).rejects.toThrow(
      "Ollama is still not reachable at http://127.0.0.1:11434",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cloud + local mode falls back to local models when ollama signin is missing", async () => {
    const { result, prompter } = await configureInteractive(
      {
        tags: ["llama3:8b"],
        meResponse: new Response(JSON.stringify({ signin_url: "https://ollama.com/signin" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      },
      { select: vi.fn().mockResolvedValueOnce("cloud-local") },
    );

    expect(result.config.models?.providers?.ollama?.models?.map((m) => m.id)).toEqual([
      "gemma4",
      "llama3:8b",
    ]);
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("https://ollama.com/signin"),
      "Ollama Cloud + Local",
    );
  });

  it("offers and streams a recommended pull when no installed model supports tools", async () => {
    const progress = { update: vi.fn(), stop: vi.fn() };
    const { result, prompter, fetchMock } = await configureInteractive(
      {
        tags: ["llama3:8b"],
        show: { "gemma4:e4b": 131072 },
        capabilities: {
          "llama3:8b": ["generate"],
          "gemma4:e4b": ["tools"],
        },
        pullResponse: new Response(
          [
            '{"status":"pulling sha256:12345678","total":100,"completed":50}',
            '{"status":"pulling sha256:12345678","total":100,"completed":100}',
            '{"status":"success"}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
      },
      {
        confirm: vi.fn().mockResolvedValueOnce(true),
        progress: vi.fn(() => progress),
      },
    );

    expect(prompter.confirm).toHaveBeenCalledOnce();
    expect(prompter.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
    const pullCall = fetchMock.mock.calls.find((call) => requestUrl(call[0]).endsWith("/api/pull"));
    expect(pullCall).toBeDefined();
    expect(JSON.parse(requestBodyText(pullCall?.[1]?.body))).toEqual({ model: "gemma4:e4b" });
    expect(progress.update).toHaveBeenCalledWith("Downloading gemma4:e4b - pulling part - 50%");
    expect(progress.stop).toHaveBeenCalledWith("Downloaded gemma4:e4b");
    expect(
      result.config.models?.providers?.ollama?.models?.find((model) => model.id === "gemma4:e4b"),
    ).toMatchObject({
      contextWindow: 131072,
      compat: { supportsTools: true },
    });
    expect(result.defaultModel).toBe("ollama/gemma4:e4b");
  });

  it("does not pull the recommended Ollama model when declined", async () => {
    const { prompter, fetchMock } = await configureInteractive(
      {
        tags: ["llama3:8b"],
        capabilities: { "llama3:8b": ["generate"] },
      },
      { confirm: vi.fn().mockResolvedValueOnce(false) },
    );

    expect(prompter.confirm).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).not.toContain(
      "http://127.0.0.1:11434/api/pull",
    );
  });

  it("skips a broken model and continues setup when one inspection fails", async () => {
    const prompter = createLocalPrompter({ confirm: vi.fn() });
    const baseFetch = createOllamaFetchMock({
      tags: ["broken:20b", "gemma4:e4b"],
      capabilities: { "gemma4:e4b": ["tools"] },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (requestUrl(input).endsWith("/api/show")) {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        if (body.model === "broken:20b") {
          return new Response("boom", { status: 500 });
        }
      }
      return await baseFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(expect.stringContaining("broken:20b"), "Ollama");
    expect(
      result.config.models?.providers?.ollama?.models?.find((model) => model.id === "gemma4:e4b"),
    ).toMatchObject({ compat: { supportsTools: true } });
    expect(
      result.config.models?.providers?.ollama?.models?.find((model) => model.id === "broken:20b"),
    ).toMatchObject({ compat: { supportsTools: false } });
  });

  it("checks all installed Ollama models before offering a recommended pull", async () => {
    const tags = Array.from({ length: 201 }, (_, index) => `model-${index}`);
    const capabilities = Object.fromEntries(
      tags.map((name, index) => [name, index === 200 ? ["tools"] : ["generate"]]),
    );
    const { result, prompter } = await configureInteractive(
      { tags, capabilities },
      { confirm: vi.fn() },
    );

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(
      result.config.models?.providers?.ollama?.models?.find((model) => model.id === "model-200"),
    ).toMatchObject({ compat: { supportsTools: true } });
  });

  it("aborts the exhaustive tools-capability scan with the setup session", async () => {
    const controller = new AbortController();
    const prompter = createLocalPrompter({ confirm: vi.fn() });
    const tags = Array.from({ length: 201 }, (_, index) => `model-${index}`);
    const capabilities = Object.fromEntries(tags.map((name) => [name, ["generate"]]));
    const baseFetch = createOllamaFetchMock({ tags, capabilities });
    const scanStarted = createDeferred<void>();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(requestBodyText(init.body)) as { model?: string }) : {};
      if (!requestUrl(input).endsWith("/api/show") || body.model !== "model-200") {
        return await baseFetch(input, init);
      }
      scanStarted.resolve();
      return await pendingResponse(init?.signal, "expected tools scan abort signal");
    });
    vi.stubGlobal("fetch", fetchMock);

    const setup = promptAndConfigureOllama({ cfg: {}, prompter, signal: controller.signal });
    await scanStarted.promise;
    controller.abort();

    await expect(setup).rejects.toMatchObject({ name: "AbortError" });
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("aborts a recommended Ollama pull when the setup session is cancelled", async () => {
    const controller = new AbortController();
    const progress = { update: vi.fn(), stop: vi.fn() };
    const prompter = createLocalPrompter({
      confirm: vi.fn().mockResolvedValueOnce(true),
      progress: vi.fn(() => progress),
    });
    const baseFetch = createOllamaFetchMock({
      tags: ["llama3:8b"],
      capabilities: { "llama3:8b": ["generate"] },
    });
    const pullStarted = createDeferred<void>();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (!requestUrl(input).endsWith("/api/pull")) {
        return await baseFetch(input, init);
      }
      pullStarted.resolve();
      return await pendingResponse(init?.signal, "expected pull abort signal");
    });
    vi.stubGlobal("fetch", fetchMock);

    const setup = promptAndConfigureOllama({ cfg: {}, prompter, signal: controller.signal });
    await pullStarted.promise;
    controller.abort();

    await expect(setup).rejects.toThrow("Failed to download recommended Ollama model");
    expect(progress.stop).toHaveBeenCalledWith(expect.stringContaining("Failed to download"));
  });

  describe("ensureOllamaModelPulled", () => {
    describe("pull timers", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      function startPull(fetchMock: ReturnType<typeof createOllamaFetchMock>) {
        const progress = { update: vi.fn(), stop: vi.fn() };
        const prompter = { progress: vi.fn(() => progress) } as unknown as WizardPrompter;
        vi.stubGlobal("fetch", fetchMock);
        return { progress, fetchMock, run: () => ensurePulled("ollama/gemma4", prompter) };
      }

      it("pulls model when not available locally", async () => {
        const { fetchMock, run } = startPull(
          createOllamaFetchMock({
            tags: ["llama3:8b"],
            pullResponse: new Response('{"status":"success"}\n', { status: 200 }),
          }),
        );
        await run();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(mockCallArg(fetchMock, 1)).toContain("/api/pull");
        const pullInit = mockCallArg(fetchMock, 1, 1) as RequestInit | undefined;
        expect(pullInit?.signal).toBeInstanceOf(AbortSignal);
        expect(pullInit?.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(pullInit?.signal?.aborted).toBe(false);
      });

      it("fails stalled model pull streams after an idle timeout", async () => {
        const { progress, fetchMock, run } = startPull(
          vi.fn(async (input: string | URL | Request) => {
            const url = requestUrl(input);
            if (url.endsWith("/api/tags")) {
              return jsonResponse({ models: [] });
            }
            if (url.endsWith("/api/pull")) {
              return new Response(new ReadableStream<Uint8Array>(), { status: 200 });
            }
            throw new Error(`Unexpected fetch: ${url}`);
          }),
        );
        const pullPromise = run().catch((err: unknown) => err);
        await vi.waitFor(() => expect(mockCallArg(fetchMock, 1)).toContain("/api/pull"));
        await vi.advanceTimersByTimeAsync(300_000);
        const pullError = await pullPromise;
        expect(pullError).toBeInstanceOf(Error);
        expect((pullError as Error).name).toBe("WizardCancelledError");
        expect((pullError as Error).message).toBe("Failed to download selected Ollama model");
        expect(progress.stop).toHaveBeenCalledWith(
          "Failed to download gemma4: Ollama pull stalled: no data received for 300s",
        );
      });
    });

    it("skips pull when an untagged model is available as latest", async () => {
      const prompter = {} as unknown as WizardPrompter;

      const fetchMock = createOllamaFetchMock({ tags: ["gemma4:latest"] });
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: createDefaultOllamaConfig("ollama/gemma4"),
        model: "ollama/Gemma4",
        prompter,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("skips pull for cloud models", async () => {
      const prompter = {} as unknown as WizardPrompter;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await ensurePulled("ollama/kimi-k2.5:cloud", prompter);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips when model is not an ollama model", async () => {
      const prompter = {} as unknown as WizardPrompter;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: {
          agents: { defaults: { model: { primary: "openai/gpt-4o" } } },
        },
        model: "openai/gpt-4o",
        prompter,
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("keeps ollama.com out of the local provider in non-interactive setup", async () => {
    const { fetchMock, configure } = startNonInteractive({ tags: ["kimi-k3"] });

    await expect(
      configure({ customBaseUrl: "https://ollama.com", customModelId: "kimi-k3" }),
    ).rejects.toThrow("--auth-choice ollama-cloud");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes ollama/ prefix in non-interactive custom model download", async () => {
    const { fetchMock, configure } = startNonInteractive({
      tags: [],
      show: { "llama3.2:latest": 16_384 },
      capabilities: { "llama3.2:latest": ["completion", "tools", "vision", "thinking"] },
      pullResponse: new Response('{"status":"success"}\n', { status: 200 }),
    });
    const result = await configure({ customModelId: "  OLLAMA/llama3.2:latest  " });

    const pullRequest = mockCallArg(fetchMock, 1, 1) as RequestInit | undefined;
    expect(JSON.parse(requestBodyText(pullRequest?.body))).toEqual({ model: "llama3.2:latest" });
    expect(result.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.2:latest" });
    expect(result.models?.providers?.ollama?.models).toEqual([
      expect.objectContaining({
        id: "llama3.2:latest",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 16_384,
        contextTokens: 16_384,
        compat: expect.objectContaining({ supportsTools: true }),
      }),
    ]);
  });

  it("accepts cloud model kimi-k2.5:cloud in non-interactive mode without pulling", async () => {
    const modelId = "kimi-k2.5:cloud";

    const { fetchMock, configure } = startNonInteractive({ tags: [] });
    const result = await configure({ customModelId: modelId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.models?.providers?.ollama?.models?.map((model) => model.id)).toContain(modelId);
    expect(result.agents?.defaults?.model).toEqual({ primary: `ollama/${modelId}` });
  });

  it("propagates unreachable guidance to the caller without exiting", async () => {
    const { configure, runtime, nextConfig } = startNonInteractive({
      tagsError: new Error("connect ECONNREFUSED"),
    });

    await expect(
      configure({ customBaseUrl: "http://127.0.0.1:11435", customModelId: "llama3.2:latest" }),
    ).rejects.toThrow(
      [
        "Ollama could not be reached at http://127.0.0.1:11435.",
        "Start or restart the Ollama server for this address.",
        "If Ollama is not installed on that machine, download it at https://ollama.com/download",
      ].join("\n"),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(nextConfig).toEqual({});
  });
});

describe("checkOllamaCloudAuth", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockClear();
  });

  it("bounds oversized 401 body and cancels the stream", async () => {
    const oversized = oversizedJsonResponse({ chunkCount: 64, chunkSize: 1024 * 1024 });

    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(oversized.response.body, {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
      finalUrl: "https://ollama.com/api/me",
      release: async () => {},
    });

    await expect(checkOllamaCloudAuth("https://ollama.com")).resolves.toEqual({
      signedIn: false,
      signinUrl: undefined,
    });

    expect(oversized.getReadCount()).toBeLessThan(64);
    expect(oversized.wasCanceled()).toBe(true);
  });
});

describe("Ollama non-interactive onboarding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an explicitly selected embedding-only model despite advertised tools", async () => {
    const { configure, runtime, nextConfig } = startNonInteractive(
      {
        tags: ["embedding-model"],
        capabilities: { "embedding-model": ["embedding", "tools"] },
        fallbackCapabilities: true,
      },
      { agents: { defaults: { model: { primary: "ollama/qwen3:1.7b" } } } },
    );
    await expect(configure({ customModelId: "embedding-model" })).rejects.toThrow(
      "Ollama model embedding-model only supports embeddings. Choose a chat model instead.",
    );
    expect(nextConfig).toEqual({
      agents: { defaults: { model: { primary: "ollama/qwen3:1.7b" } } },
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("does not persist unavailable local models when the model pull ends before success", async () => {
    const { body, error } = {
      body: '{"status":"pulling manifest"}\n',
      error: "Failed to download missing-model: pull stream ended before success",
    };

    const { configure, runtime, nextConfig } = startNonInteractive({
      tags: [],
      pullResponse: new Response(body, { status: 200 }),
      fallbackCapabilities: true,
    });

    await expect(configure({ customModelId: "missing-model" })).rejects.toThrow(
      [
        "No Ollama chat models are available at http://127.0.0.1:11434.",
        "Pull a chat model first, then re-run setup.",
      ].join("\n"),
    );
    expect(runtime.error).toHaveBeenCalledWith(error);
    expect(runtime.log).not.toHaveBeenCalledWith("Downloaded missing-model");
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(nextConfig).toEqual({});
  });

  it("handles embedding models before chat when a requested download fails", async () => {
    const embeddingNames = Array.from({ length: 201 }, (_, index) => `embedding-${index}`);
    const { configure, runtime } = startNonInteractive(
      {
        fallbackCapabilities: true,
        tags: [...embeddingNames, "qwen2.5-coder:7b"],
        capabilities: {
          ...Object.fromEntries(embeddingNames.map((name) => [name, ["embedding", "tools"]])),
          "qwen2.5-coder:7b": ["tools"],
        },
        pullResponse: new Response('{"error":"disk full"}\n', { status: 200 }),
      },
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.6-luna",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
        },
      },
    );
    const result = await configure({ customModelId: "missing-model" });
    expect(runtime.error).toHaveBeenCalledWith("Download failed: disk full");
    expect(result.agents?.defaults?.model).toEqual({
      primary: "ollama/qwen2.5-coder:7b",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
    expect(result.models?.providers?.ollama?.apiKey).toBe("ollama-local");
  });

  it("uses the smallest capable discovered model as the non-interactive default", async () => {
    const { fetchMock, configure } = startNonInteractive({
      fallbackCapabilities: true,
      tags: [],
      tagModels: [
        { name: "qwen3:4b-instruct", size: 2_497_293_803 },
        { name: "gemma4:latest", size: 9_608_350_718 },
        { name: "llama3.2:latest", size: 2_019_393_189 },
      ],
      show: {
        "qwen3:4b-instruct": 262_144,
        "gemma4:latest": 131_072,
        "llama3.2:latest": 131_072,
      },
      capabilities: {
        "qwen3:4b-instruct": ["completion", "tools", "thinking"],
        "gemma4:latest": ["completion", "tools", "thinking"],
        "llama3.2:latest": ["completion", "tools"],
      },
    });
    const result = await configure();

    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).not.toContain(
      "http://127.0.0.1:11434/api/pull",
    );
    expect(result.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.2:latest" });
  });

  it("preserves the capabilities of an explicitly selected model beyond the discovery limit", async () => {
    const modelId = "gemma4:e2b";
    const { configure } = startNonInteractive({
      fallbackCapabilities: true,
      tags: [...Array.from({ length: 200 }, (_, index) => `other-${index}`), modelId],
      show: { [modelId]: 131_072 },
      capabilities: { [modelId]: ["completion", "tools", "vision", "thinking"] },
    });
    const result = await configure({ customModelId: modelId });

    expect(result.agents?.defaults?.model).toEqual({ primary: `ollama/${modelId}` });
    expect(
      result.models?.providers?.ollama?.models?.find((model) => model.id === modelId),
    ).toMatchObject({
      id: modelId,
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 131_072,
      contextTokens: 32_768,
      compat: { supportsTools: true },
    });
  });
});
