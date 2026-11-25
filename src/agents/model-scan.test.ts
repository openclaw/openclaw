import { afterEach, describe, expect, it, vi } from "vitest";
import { oversizedJsonResponse } from "../../test/helpers/provider-http.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { scanOpenRouterModels } from "./model-scan.js";

const jsonResponse = (body: BodyInit) =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const useResponse = (response: Response) =>
  vi.stubGlobal(
    "fetch",
    withFetchPreconnect(async () => response),
  );

const scan = (data: unknown[], options: Parameters<typeof scanOpenRouterModels>[0] = {}) => {
  useResponse(jsonResponse(JSON.stringify({ data })));
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
        ["meta-llama/llama4-maverick-17b-128e:free", "Llama 4 Maverick 400B"],
        ["meta-llama/llama4-scout-17b-16e:free", "Llama 4 Scout"],
        ["qwen/qwen3-30b-a3b:free", "Qwen3 30B A3B"],
        ["meta-llama/llama-70b:free", "Llama 70B"],
      ].map(([id, name]) => ({ id, name })),
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
    useResponse(response);
    await expect(scanOpenRouterModels({ probe: false })).rejects.toThrow(/HTTP 503/);

    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds an oversized catalog success body and cancels the stream", async () => {
    const { response, state } = oversizedJsonResponse();
    useResponse(response);
    await expect(scanOpenRouterModels({ probe: false })).rejects.toThrow(
      /OpenRouter \/models: JSON response exceeds 16777216 bytes/,
    );

    expect(state.canceled).toBe(true);
    expect(state.enqueuedBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it.each([
    ["body", "not json at all", /OpenRouter \/models: malformed JSON response/],
    ["envelope", "{}", /OpenRouter \/models.*malformed JSON response/],
  ] as const)("rejects a malformed catalog %s", async (_kind, body, error) => {
    useResponse(jsonResponse(body));
    await expect(scanOpenRouterModels({ probe: false })).rejects.toThrow(error);
  });

  it("requires an API key when probing", async () => {
    await withEnvAsync({ OPENROUTER_API_KEY: undefined }, async () => {
      await expect(scan([], { probe: true, apiKey: "" })).rejects.toThrow(
        /Missing OpenRouter API key/,
      );
    });
  });

  it.each(["headers", "streaming body"] as const)(
    "keeps the scan deadline while awaiting %s",
    async (stage) => {
      vi.useFakeTimers();
      let chunks = 0;
      const aborted = vi.fn();
      let interval: ReturnType<typeof setInterval> | undefined;
      let completion: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        clearInterval(interval);
        clearTimeout(completion);
      };
      vi.stubGlobal(
        "fetch",
        withFetchPreconnect(async (_input, init) => {
          if (stage === "headers") {
            return await new Promise<Response>(() => {});
          }
          const signal = init?.signal;
          if (!signal) {
            throw new Error("Expected catalog request signal");
          }
          const encoder = new TextEncoder();
          return jsonResponse(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('{"data":['));
                interval = setInterval(() => {
                  chunks++;
                  controller.enqueue(encoder.encode(" "));
                }, 5);
                completion = setTimeout(() => {
                  stop();
                  controller.enqueue(encoder.encode("]}"));
                  controller.close();
                }, 25);
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted();
                    stop();
                    controller.error(signal.reason);
                  },
                  { once: true },
                );
              },
              cancel: stop,
            }),
          );
        }),
      );
      const pending = expect(scanOpenRouterModels({ probe: false, timeoutMs: 20 })).rejects.toThrow(
        /timed out/i,
      );
      await vi.advanceTimersByTimeAsync(19);
      if (stage === "streaming body") {
        expect(chunks).toBe(3);
        expect(aborted).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(6);
      await pending;
      if (stage === "streaming body") {
        expect(aborted).toHaveBeenCalledOnce();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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
