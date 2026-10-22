import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { scanOpenRouterModels } from "./model-scan.js";

const jsonResponse = (body: BodyInit) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const createFetchFixture = (payload: unknown): typeof fetch =>
  withFetchPreconnect(async () => jsonResponse(JSON.stringify(payload)));

const scan = (data: unknown[], options: Parameters<typeof scanOpenRouterModels>[0] = {}) => {
  vi.stubGlobal("fetch", createFetchFixture({ data }));
  return scanOpenRouterModels({ probe: false, ...options });
};

describe("scanOpenRouterModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("lists free models without probing", async () => {
    const results = await scan([
      {
        id: "acme/free-by-pricing",
        name: "Free By Pricing",
        context_length: 16_384,
        max_completion_tokens: 1024,
        supported_parameters: ["tools", "tool_choice", "temperature"],
        modality: "text",
        pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
        created_at: 1_700_000_000,
      },
      { id: "acme/free-by-suffix:free" },
      {
        id: "acme/paid",
        pricing: { prompt: "0.000001", completion: "0.000002" },
      },
    ]);

    expect(results.map((entry) => entry.id)).toEqual([
      "acme/free-by-pricing",
      "acme/free-by-suffix:free",
    ]);

    expect(results[0]).toMatchObject({
      contextLength: 16_384,
      maxCompletionTokens: 1024,
      supportsToolsMeta: true,
      supportedParametersCount: 3,
      isFree: true,
      tool: { skipped: true },
      image: { skipped: true },
    });
  });

  it("keeps independently sized MoE models when filtering by minimum parameters", async () => {
    const results = await scan(
      [
        {
          id: "meta-llama/llama4-maverick-17b-128e:free",
          name: "Llama 4 Maverick 400B",
        },
        {
          id: "meta-llama/llama4-scout-17b-16e:free",
          name: "Llama 4 Scout",
        },
        { id: "qwen/qwen3-30b-a3b:free", name: "Qwen3 30B A3B" },
        { id: "meta-llama/llama-70b:free", name: "Llama 70B" },
      ],
      { minParamB: 100 },
    );

    expect(results.map(({ id, inferredParamB }) => ({ id, inferredParamB }))).toEqual([
      { id: "meta-llama/llama4-maverick-17b-128e:free", inferredParamB: 400 },
    ]);
  });

  it("uses OpenRouter top-provider limits for scan metadata", async () => {
    const [result] = await scan([
      {
        id: "acme/provider-limited:free",
        context_length: 32_768,
        top_provider: { context_length: 16_384, max_completion_tokens: 4096 },
      },
    ]);
    expect(result).toMatchObject({ contextLength: 16_384, maxCompletionTokens: 4096 });
  });

  it("drops out-of-range OpenRouter created_at timestamps", async () => {
    const [result] = await scan([
      { id: "acme/free-invalid-created:free", created_at: 8_640_000_000_000_001 },
    ]);

    expect(result?.createdAtMs).toBeNull();
  });

  it("cancels catalog error response bodies", async () => {
    const response = new Response("unavailable", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchImpl = withFetchPreconnect(async () => response);

    vi.stubGlobal("fetch", fetchImpl);
    await expect(scanOpenRouterModels({ probe: false })).rejects.toThrow(/HTTP 503/);

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds an oversized catalog success body and cancels the stream", async () => {
    // An unbounded provider stream must be cancelled at the byte cap.
    const cancel = vi.fn(async () => undefined);
    let pullCount = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20); // 64 KiB of spaces
    const fetchImpl = withFetchPreconnect(async () =>
      jsonResponse(
        new ReadableStream({
          start(controller) {
            // Valid JSON array prefix so the body would parse if ever read in full.
            controller.enqueue(new TextEncoder().encode('{"data":['));
          },
          pull(controller) {
            pullCount += 1;
            controller.enqueue(chunk);
          },
          cancel,
        }),
      ),
    );

    vi.stubGlobal("fetch", fetchImpl);
    await expect(scanOpenRouterModels({ probe: false })).rejects.toThrow(
      /OpenRouter \/models: JSON response exceeds 16777216 bytes/,
    );

    expect(cancel).toHaveBeenCalledOnce();
    expect(pullCount).toBeGreaterThan(0);
    expect(pullCount).toBeLessThan(16 * 1024 * 1024); // nowhere near draining forever
  });

  it.each([
    ["body", "not json at all", /OpenRouter \/models: malformed JSON response/],
    ["envelope", "{}", /OpenRouter \/models.*malformed JSON response/],
  ] as const)("rejects a malformed catalog %s", async (_kind, body, error) => {
    const fetchImpl = withFetchPreconnect(async () => jsonResponse(body));
    vi.stubGlobal("fetch", fetchImpl);
    await expect(scanOpenRouterModels({ probe: false })).rejects.toThrow(error);
  });

  it("requires an API key when probing", async () => {
    await withEnvAsync({ OPENROUTER_API_KEY: undefined }, async () => {
      await expect(scan([], { probe: true, apiKey: "" })).rejects.toThrow(
        /Missing OpenRouter API key/,
      );
    });
  });

  it("applies the scan timeout before the OpenRouter catalog responds", async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = async () =>
      await new Promise<Response>(() => {
        // Deliberately ignore cancellation to prove the timeout race settles independently.
      });

    vi.stubGlobal("fetch", fetchImpl);
    const pending = expect(scanOpenRouterModels({ probe: false, timeoutMs: 1 })).rejects.toThrow(
      /OpenRouter model scan timed out/,
    );

    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });

  it("keeps the catalog timeout active while reading a streaming body", async () => {
    vi.useFakeTimers();
    const timeoutMs = 20;
    const chunkIntervalMs = 5;
    const encoder = new TextEncoder();
    let chunkCount = 0;
    let abortCount = 0;

    const fetchImpl = withFetchPreconnect(async (_input, init) => {
      const signal = typeof init === "object" && init ? init.signal : undefined;
      if (!signal) {
        throw new Error("Expected catalog request signal");
      }
      let interval: ReturnType<typeof setInterval> | undefined;
      let completionTimer: ReturnType<typeof setTimeout> | undefined;
      return jsonResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"data":['));
            interval = setInterval(() => {
              chunkCount += 1;
              controller.enqueue(encoder.encode(" "));
            }, chunkIntervalMs);
            completionTimer = setTimeout(() => {
              clearInterval(interval);
              controller.enqueue(encoder.encode("]}"));
              controller.close();
            }, timeoutMs + chunkIntervalMs);
            signal.addEventListener(
              "abort",
              () => {
                abortCount += 1;
                clearInterval(interval);
                clearTimeout(completionTimer);
                controller.error(signal.reason);
              },
              { once: true },
            );
          },
          cancel() {
            clearInterval(interval);
            clearTimeout(completionTimer);
          },
        }),
      );
    });

    vi.stubGlobal("fetch", fetchImpl);
    const pending = expect(scanOpenRouterModels({ probe: false, timeoutMs })).rejects.toThrow(
      /timed out/i,
    );

    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect({ chunkCount, abortCount }).toEqual({ chunkCount: 3, abortCount: 0 });

    await vi.advanceTimersByTimeAsync(chunkIntervalMs + 1);
    await pending;
    expect({ abortCount, timers: vi.getTimerCount() }).toEqual({ abortCount: 1, timers: 0 });
  });

  it("caps oversized scan timeouts before scheduling catalog aborts", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    await scan([], { timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000 });

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("does not match provider filters across provider id variants", async () => {
    const results = await scan(
      ["z.ai/glm-5", "openai/gpt-5"].map((id) => ({
        id,
        pricing: { prompt: "0", completion: "0" },
      })),
      { providerFilter: "z-ai" },
    );

    expect(results.map((entry) => entry.id)).toEqual([]);
  });
});
