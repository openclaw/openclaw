import { describe, expect, it } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { scanOpenRouterModels } from "./model-scan.js";

/**
 * Creates a fetch mock that returns the model list for the first call,
 * then returns a successful tool-call response for probe requests.
 */
function createProbeFetchFixture(models: unknown[]): typeof fetch {
  let callCount = 0;
  return withFetchPreconnect(async (input: RequestInfo | URL) => {
    callCount++;
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // First call = model list from OpenRouter
    if (url.includes("openrouter.ai/api/v1/models")) {
      return new Response(JSON.stringify({ data: models }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Subsequent calls = probe completions (tool call or image)
    return new Response(
      JSON.stringify({
        id: "test",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_test",
                  type: "function",
                  function: { name: "ping", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  });
}

function createNoProbeFixture(models: unknown[]): typeof fetch {
  return withFetchPreconnect(
    async () =>
      new Response(JSON.stringify({ data: models }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("model-scan: model.input undefined guard", () => {
  // --- probe: false tests (sanity checks) ---

  it("handles model entries with missing modality without crashing (probe: false)", async () => {
    const fetchImpl = createNoProbeFixture([
      {
        id: "custom/no-modality",
        name: "No Modality Model",
        context_length: 8_192,
        supported_parameters: ["tools"],
        modality: null,
        pricing: { prompt: "0", completion: "0" },
      },
    ]);

    const results = await scanOpenRouterModels({ fetchImpl, probe: false });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("custom/no-modality");
    expect(results[0].image.skipped).toBe(true);
  });

  // --- probe: true tests (actually exercise line 475) ---

  it("skips image probe when model.input is undefined (probe: true)", async () => {
    const fetchImpl = createProbeFetchFixture([
      {
        id: "custom/no-modality",
        name: "No Modality Model",
        context_length: 8_192,
        supported_parameters: ["tools"],
        modality: null, // parseModality returns ["text"] — no "image"
        pricing: { prompt: "1", completion: "1" }, // non-free so probe runs
      },
    ]);

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: true,
      apiKey: "test-key",
      timeoutMs: 5_000,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("custom/no-modality");
    // Tool probe should run and succeed
    expect(results[0].tool.skipped).toBe(false);
    expect(results[0].tool.ok).toBe(true);
    // Image probe should be SKIPPED because input doesn't include "image"
    expect(results[0].image.skipped).toBe(true);
    expect(results[0].image.ok).toBe(false);
  });

  it("runs image probe when modality includes image (probe: true)", async () => {
    const fetchImpl = createProbeFetchFixture([
      {
        id: "custom/with-image",
        name: "Image Model",
        context_length: 128_000,
        supported_parameters: ["tools"],
        modality: "text+image",
        pricing: { prompt: "1", completion: "1" },
      },
    ]);

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: true,
      apiKey: "test-key",
      timeoutMs: 5_000,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("custom/with-image");
    // Both probes should run
    expect(results[0].tool.skipped).toBe(false);
    expect(results[0].image.skipped).toBe(false);
  });

  it("handles empty modality string without crashing (probe: true)", async () => {
    const fetchImpl = createProbeFetchFixture([
      {
        id: "custom/empty-modality",
        name: "Empty Modality",
        context_length: 4_096,
        supported_parameters: [],
        modality: "",
        pricing: { prompt: "1", completion: "1" },
      },
    ]);

    const results = await scanOpenRouterModels({
      fetchImpl,
      probe: true,
      apiKey: "test-key",
      timeoutMs: 5_000,
    });

    expect(results).toHaveLength(1);
    // Should not crash, image probe should be skipped
    expect(results[0].image.skipped).toBe(true);
  });
});
