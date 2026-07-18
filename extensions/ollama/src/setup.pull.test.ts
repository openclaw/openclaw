// Ollama ensureOllamaModelPulled tests.
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { requestUrl, requestBodyText, jsonResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureOllamaModelPulled } from "./setup.js";
import {
  createDefaultOllamaConfig,
  createOllamaFetchMock,
  mockCall,
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

  it("fails stalled model pull streams after an idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const progress = { update: vi.fn(), stop: vi.fn() };
      const prompter = {
        progress: vi.fn(() => progress),
      } as unknown as WizardPrompter;
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/tags")) {
          return jsonResponse({ models: [] });
        }
        if (url.endsWith("/api/pull")) {
          return new Response(new ReadableStream<Uint8Array>(), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const pullPromise = ensureOllamaModelPulled({
        config: createDefaultOllamaConfig("ollama/gemma4"),
        model: "ollama/gemma4",
        prompter,
      }).catch((err: unknown) => err);

      await vi.waitFor(() => expect(mockCallArg(fetchMock, 1)).toContain("/api/pull"));

      await vi.advanceTimersByTimeAsync(300_000);
      const pullError = await pullPromise;
      expect(pullError).toBeInstanceOf(Error);
      expect((pullError as Error).name).toBe("WizardCancelledError");
      expect((pullError as Error).message).toBe("Failed to download selected Ollama model");
      expect(progress.stop).toHaveBeenCalledWith(
        "Failed to download gemma4: Ollama pull stalled: no data received for 300s",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a non-advancing drip with a no-progress timeout", async () => {
    vi.useFakeTimers();
    try {
      const progress = { update: vi.fn(), stop: vi.fn() };
      const prompter = {
        progress: vi.fn(() => progress),
      } as unknown as WizardPrompter;
      const encoder = new TextEncoder();
      let dripTimer: ReturnType<typeof setInterval> | undefined;
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/tags")) {
          return jsonResponse({ models: [] });
        }
        if (url.endsWith("/api/pull")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                dripTimer = setInterval(() => {
                  controller.enqueue(encoder.encode('{"status":"pulling manifest"}\n'));
                }, 40);
              },
              cancel() {
                if (dripTimer !== undefined) {
                  clearInterval(dripTimer);
                  dripTimer = undefined;
                }
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const pullPromise = ensureOllamaModelPulled({
        config: createDefaultOllamaConfig("ollama/gemma4"),
        model: "ollama/gemma4",
        prompter,
        streamNoProgressTimeoutMs: 1_000,
        // Keep idle well above the drip interval so only no-progress can win.
        streamIdleTimeoutMs: 10_000,
      }).catch((err: unknown) => err);

      await vi.waitFor(() => expect(mockCallArg(fetchMock, 1)).toContain("/api/pull"));
      await vi.advanceTimersByTimeAsync(1_000);
      const pullError = await pullPromise;
      expect(pullError).toBeInstanceOf(Error);
      expect((pullError as Error).name).toBe("WizardCancelledError");
      expect((pullError as Error).message).toBe("Failed to download selected Ollama model");
      expect(progress.stop).toHaveBeenCalledWith(
        "Failed to download gemma4: Ollama pull stalled: no progress for 1s",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows advancing completed progress past the shortened no-progress timeout", async () => {
    vi.useFakeTimers();
    try {
      const progress = { update: vi.fn(), stop: vi.fn() };
      const prompter = {
        progress: vi.fn(() => progress),
      } as unknown as WizardPrompter;
      const encoder = new TextEncoder();
      let completed = 0;
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/tags")) {
          return jsonResponse({ models: [] });
        }
        if (url.endsWith("/api/pull")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                progressTimer = setInterval(() => {
                  completed += 100;
                  controller.enqueue(
                    encoder.encode(
                      `{"status":"downloading","total":10000,"completed":${completed}}\n`,
                    ),
                  );
                  if (completed >= 10000) {
                    controller.enqueue(encoder.encode('{"status":"success"}\n'));
                    controller.close();
                    if (progressTimer !== undefined) {
                      clearInterval(progressTimer);
                      progressTimer = undefined;
                    }
                  }
                }, 200);
              },
              cancel() {
                if (progressTimer !== undefined) {
                  clearInterval(progressTimer);
                  progressTimer = undefined;
                }
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const pullPromise = ensureOllamaModelPulled({
        config: createDefaultOllamaConfig("ollama/gemma4"),
        model: "ollama/gemma4",
        prompter,
        // Shorter than the full advancing download (10000/100 * 200ms = 20s).
        streamNoProgressTimeoutMs: 1_000,
        streamIdleTimeoutMs: 10_000,
      });

      await vi.waitFor(() => expect(mockCallArg(fetchMock, 1)).toContain("/api/pull"));
      // Past several no-progress windows while completed keeps advancing.
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pullPromise).resolves.toBeUndefined();
      expect(progress.stop).toHaveBeenCalledWith("Downloaded gemma4");
      expect(progress.stop).not.toHaveBeenCalledWith(expect.stringContaining("no progress for"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows status-only finalization past the shortened no-progress timeout", async () => {
    vi.useFakeTimers();
    try {
      const progress = { update: vi.fn(), stop: vi.fn() };
      const prompter = {
        progress: vi.fn(() => progress),
      } as unknown as WizardPrompter;
      const encoder = new TextEncoder();
      let completed = 0;
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/tags")) {
          return jsonResponse({ models: [] });
        }
        if (url.endsWith("/api/pull")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                let step = 0;
                const statusPhases = [
                  "verifying sha256 digest",
                  "writing manifest",
                  "pulling manifest",
                  "checking blob",
                  "cleanup",
                ];
                progressTimer = setInterval(() => {
                  if (step < 5) {
                    completed += 2000;
                    controller.enqueue(
                      encoder.encode(
                        `{"status":"downloading","total":10000,"completed":${completed}}\n`,
                      ),
                    );
                  } else {
                    const phaseIdx = step - 5;
                    if (phaseIdx < statusPhases.length) {
                      controller.enqueue(
                        encoder.encode(`{"status":"${statusPhases[phaseIdx]}"}\n`),
                      );
                    } else {
                      // Spent >statusPhases.length status-only steps past the 500ms
                      // budget; healthy finalization survives because distinct status
                      // transitions reset the watchdog each step.
                      controller.enqueue(encoder.encode('{"status":"success"}\n'));
                      controller.close();
                      if (progressTimer !== undefined) {
                        clearInterval(progressTimer);
                        progressTimer = undefined;
                      }
                    }
                  }
                  step++;
                }, 160);
              },
              cancel() {
                if (progressTimer !== undefined) {
                  clearInterval(progressTimer);
                  progressTimer = undefined;
                }
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const pullPromise = ensureOllamaModelPulled({
        config: createDefaultOllamaConfig("ollama/gemma4"),
        model: "ollama/gemma4",
        prompter,
        streamNoProgressTimeoutMs: 500,
        streamIdleTimeoutMs: 10_000,
      });

      await vi.waitFor(() => expect(mockCallArg(fetchMock, 1)).toContain("/api/pull"));
      // Past several no-progress windows; status-only transitions keep the watchdog alive.
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pullPromise).resolves.toBeUndefined();
      expect(progress.stop).toHaveBeenCalledWith("Downloaded gemma4");
      expect(progress.stop).not.toHaveBeenCalledWith(expect.stringContaining("no progress for"));
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
