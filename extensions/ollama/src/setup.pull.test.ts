// Ollama ensureOllamaModelPulled tests.
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureOllamaModelPulled } from "./setup.js";
import {
  createDefaultOllamaConfig,
  createOllamaFetchMock,
  mockCallArg,
} from "./setup.test-helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ensureOllamaModelPulled", () => {
  it("pulls model when not available locally", async () => {
    vi.useFakeTimers();
    try {
      const progress = { update: vi.fn(), stop: vi.fn() };
      const prompter = {
        progress: vi.fn(() => progress),
      } as unknown as WizardPrompter;

      const fetchMock = createOllamaFetchMock({
        tags: ["llama3:8b"],
        pullResponse: new Response('{"status":"success"}\n', { status: 200 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: createDefaultOllamaConfig("ollama/gemma4"),
        model: "ollama/gemma4",
        prompter,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockCallArg(fetchMock, 1)).toContain("/api/pull");
      const pullInit = mockCallArg(fetchMock, 1, 1) as RequestInit | undefined;
      expect(pullInit?.signal).toBeInstanceOf(AbortSignal);
      expect(pullInit?.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(pullInit?.signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips pull when model is already available", async () => {
    const prompter = {} as unknown as WizardPrompter;

    const fetchMock = createOllamaFetchMock({ tags: ["gemma4"] });
    vi.stubGlobal("fetch", fetchMock);

    await ensureOllamaModelPulled({
      config: createDefaultOllamaConfig("ollama/gemma4"),
      model: "ollama/gemma4",
      prompter,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips pull when an untagged model is available as latest", async () => {
    const prompter = {} as unknown as WizardPrompter;

    const fetchMock = createOllamaFetchMock({ tags: ["gemma4:latest"] });
    vi.stubGlobal("fetch", fetchMock);

    await ensureOllamaModelPulled({
      config: createDefaultOllamaConfig("ollama/gemma4"),
      model: "ollama/gemma4",
      prompter,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses baseURL alias when checking and pulling models", async () => {
    const progress = { update: vi.fn(), stop: vi.fn() };
    const prompter = {
      progress: vi.fn(() => progress),
    } as unknown as WizardPrompter;

    const fetchMock = createOllamaFetchMock({
      tags: [],
      pullResponse: new Response('{"status":"success"}\n', { status: 200 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await ensureOllamaModelPulled({
      config: {
        agents: { defaults: { model: { primary: "ollama/gemma4" } } },
        models: {
          providers: {
            ollama: {
              baseURL: "http://127.0.0.1:11435",
              models: [],
            } as never,
          },
        },
      },
      model: "ollama/gemma4",
      prompter,
    });

    expect(mockCallArg(fetchMock)).toBe("http://127.0.0.1:11435/api/tags");
    expect(mockCallArg(fetchMock, 1)).toBe("http://127.0.0.1:11435/api/pull");
  });

  it("skips pull for cloud models", async () => {
    const prompter = {} as unknown as WizardPrompter;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await ensureOllamaModelPulled({
      config: createDefaultOllamaConfig("ollama/kimi-k2.5:cloud"),
      model: "ollama/kimi-k2.5:cloud",
      prompter,
    });

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
