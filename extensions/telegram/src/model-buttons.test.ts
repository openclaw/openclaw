// Telegram tests cover model buttons plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildModelSelectionCallbackData,
  buildModelsKeyboard,
  buildBrowseProvidersButton,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
  type ProviderInfo,
} from "./model-buttons.js";

describe("parseModelCallbackData", () => {
  it("parses supported callback variants", () => {
    const cases = [
      ["mdl_prov", { type: "providers" }],
      ["mdl_back", { type: "back" }],
      ["mdl_list_anthropic_2", { type: "list", provider: "anthropic", page: 2 }],
      ["mdl_list_open-ai_1", { type: "list", provider: "open-ai", page: 1 }],
      ["mdl_list_hf.co_1", { type: "list", provider: "hf.co", page: 1 }],
      // Index-based select format (#98221)
      [
        "mdl_sel_anthropic_1_1_2",
        { type: "select", provider: "anthropic", page: 1, modelIndex: 1, totalCount: 2 },
      ],
      [
        "mdl_sel_openai_2_5_8",
        { type: "select", provider: "openai", page: 2, modelIndex: 5, totalCount: 8 },
      ],
      [
        "mdl_sel_hf.co_1_12_42",
        { type: "select", provider: "hf.co", page: 1, modelIndex: 12, totalCount: 42 },
      ],
      ["  mdl_prov  ", { type: "providers" }],
    ] as const;
    for (const [input, expected] of cases) {
      expect(parseModelCallbackData(input), input).toEqual(expected);
    }
  });

  it("returns null for unsupported callback variants", () => {
    const invalid = [
      "commands_page_1",
      "other_callback",
      "",
      "mdl_invalid",
      "mdl_list_",
      "mdl_list_openai_9007199254740993",
      "mdl_sel_noslash",
      "mdl_sel_",
    ];
    for (const input of invalid) {
      expect(parseModelCallbackData(input), input).toBeNull();
    }
  });
});

describe("resolveModelSelection", () => {
  it("resolves by provider and modelIndex from sorted models", () => {
    const result = resolveModelSelection({
      callback: { type: "select", provider: "openai", page: 1, modelIndex: 1, totalCount: 1 },
      providers: ["openai", "anthropic"],
      byProvider: new Map([
        ["openai", new Set(["gpt-4.1"])],
        ["anthropic", new Set(["claude-sonnet-4-5"])],
      ]),
    });
    expect(result).toEqual({ kind: "resolved", provider: "openai", model: "gpt-4.1" });
  });

  it("resolves by index into correctly sorted models", () => {
    // Models are sorted alphabetically: claude-opus-4, claude-sonnet-4
    const result = resolveModelSelection({
      callback: { type: "select", provider: "anthropic", page: 1, modelIndex: 2, totalCount: 2 },
      providers: ["anthropic"],
      byProvider: new Map([["anthropic", new Set(["claude-sonnet-4", "claude-opus-4"])]]),
    });
    expect(result).toEqual({ kind: "resolved", provider: "anthropic", model: "claude-sonnet-4" });
  });

  it("returns ambiguous when totalCount differs (stale button guard)", () => {
    const result = resolveModelSelection({
      callback: { type: "select", provider: "openai", page: 1, modelIndex: 1, totalCount: 5 },
      providers: ["openai"],
      byProvider: new Map([["openai", new Set(["gpt-4.1"])]]),
    });
    expect(result.kind).toBe("ambiguous");
  });

  it("rejects stale fingerprinted callback on same-count different-model list (#98221)", () => {
    // ["a", "bc"] and ["ab", "c"] have the same concatenated character
    // stream but different models. The delimiter in the fingerprint must
    // distinguish them so a button from the first list is rejected when
    // the provider's models change to the second list.
    const modelsA = new Set(["a", "bc"]);
    const result = resolveModelSelection({
      callback: {
        type: "select",
        provider: "p",
        page: 1,
        modelIndex: 1,
        totalCount: 2,
        fingerprint: "dead",
      },
      providers: ["p"],
      byProvider: new Map([["p", modelsA]]),
    });
    // Real fingerprint of modelsA ≠ "dead" → rejected as stale
    expect(result.kind).toBe("ambiguous");
  });

  it("returns ambiguous result when provider has no models", () => {
    const result = resolveModelSelection({
      callback: { type: "select", provider: "missing", page: 1, modelIndex: 1, totalCount: 0 },
      providers: ["openai", "anthropic"],
      byProvider: new Map([["openai", new Set(["gpt-4.1"])]]),
    });
    expect(result).toMatchObject({ kind: "ambiguous", matchingProviders: ["openai", "anthropic"] });
  });

  it("returns ambiguous result when modelIndex is out of range", () => {
    const result = resolveModelSelection({
      callback: { type: "select", provider: "openai", page: 1, modelIndex: 99, totalCount: 1 },
      providers: ["openai", "anthropic"],
      byProvider: new Map([["openai", new Set(["gpt-4.1"])]]),
    });
    expect(result.kind).toBe("ambiguous");
  });
});

describe("buildModelSelectionCallbackData", () => {
  it("builds fixed-length index-based callback with fingerprint (#98221)", () => {
    const models5 = ["gpt-4", "gpt-4.1", "gpt-5", "claude-3", "gemini-2"];
    const cb1 = buildModelSelectionCallbackData({
      provider: "openai",
      page: 1,
      modelIndex: 1,
      totalCount: 5,
      models: models5,
    });
    expect(cb1).toMatch(/^mdl_sel_openai_1_1_5_[a-f0-9]{4}$/);
    const models42 = Array.from({ length: 42 }, (_, i) => `model-${i}`);
    const cb2 = buildModelSelectionCallbackData({
      provider: "anthropic",
      page: 3,
      modelIndex: 12,
      totalCount: 42,
      models: models42,
    });
    expect(cb2).toMatch(/^mdl_sel_anthropic_3_12_42_[a-f0-9]{4}$/);
    // Never embeds model name — always fits 64 bytes
    const cb3 = buildModelSelectionCallbackData({
      provider: "a",
      page: 1,
      modelIndex: 1,
      totalCount: 1,
      models: ["x"],
    });
    expect(cb3.length).toBeLessThan(64);
  });
});

describe("fingerprint delimiter disambiguation (#98221)", () => {
  it("produces different callback_data for same-character-stream model lists", () => {
    // ["a", "bc"] and ["ab", "c"] both concatenate to "abc" but represent
    // different model sets. The delimiter in computeModelListFingerprint
    // must produce different fingerprints for these two lists.
    const cb1 = buildModelSelectionCallbackData({
      provider: "p",
      page: 1,
      modelIndex: 1,
      totalCount: 2,
      models: ["a", "bc"],
    });
    const cb2 = buildModelSelectionCallbackData({
      provider: "p",
      page: 1,
      modelIndex: 1,
      totalCount: 2,
      models: ["ab", "c"],
    });
    expect(cb1).not.toBe(cb2);
    // Both still under 64 bytes
    expect(Buffer.byteLength(cb1, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(cb2, "utf8")).toBeLessThanOrEqual(64);
  });
});

describe("buildProviderKeyboard", () => {
  it("lays out providers in two-column rows", () => {
    const cases = [
      {
        name: "empty input",
        input: [],
        expected: [],
      },
      {
        name: "single provider",
        input: [{ id: "anthropic", count: 5 }],
        expected: [[{ text: "anthropic (5)", callback_data: "mdl_list_anthropic_1" }]],
      },
      {
        name: "exactly one full row",
        input: [
          { id: "anthropic", count: 5 },
          { id: "openai", count: 8 },
        ],
        expected: [
          [
            { text: "anthropic (5)", callback_data: "mdl_list_anthropic_1" },
            { text: "openai (8)", callback_data: "mdl_list_openai_1" },
          ],
        ],
      },
      {
        name: "wraps overflow to second row",
        input: [
          { id: "anthropic", count: 5 },
          { id: "openai", count: 8 },
          { id: "google", count: 3 },
        ],
        expected: [
          [
            { text: "anthropic (5)", callback_data: "mdl_list_anthropic_1" },
            { text: "openai (8)", callback_data: "mdl_list_openai_1" },
          ],
          [{ text: "google (3)", callback_data: "mdl_list_google_1" }],
        ],
      },
    ] as const satisfies Array<{
      name: string;
      input: ProviderInfo[];
      expected: ReturnType<typeof buildProviderKeyboard>;
    }>;

    for (const testCase of cases) {
      expect(buildProviderKeyboard(testCase.input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("buildModelsKeyboard", () => {
  it("shows back button for empty models", () => {
    const result = buildModelsKeyboard({
      provider: "anthropic",
      models: [],
      currentPage: 1,
      totalPages: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.[0]?.text).toBe("<< Back");
    expect(result[0]?.[0]?.callback_data).toBe("mdl_back");
  });

  it("renders model rows and optional current-model indicator", () => {
    const cases = [
      {
        name: "no current model",
        currentModel: undefined,
        firstText: "claude-sonnet-4",
      },
      {
        name: "current model marked",
        currentModel: "anthropic/claude-sonnet-4",
        firstText: "claude-sonnet-4 ✓",
      },
      {
        name: "legacy bare model id fallback still marks current model",
        currentModel: "claude-sonnet-4",
        firstText: "claude-sonnet-4 ✓",
      },
    ] as const;
    for (const testCase of cases) {
      const result = buildModelsKeyboard({
        provider: "anthropic",
        models: ["claude-sonnet-4", "claude-opus-4"],
        currentModel: testCase.currentModel,
        currentPage: 1,
        totalPages: 1,
      });
      // 2 model rows + back button
      expect(result, testCase.name).toHaveLength(3);
      expect(result[0]?.[0]?.text).toBe(testCase.firstText);
      expect(result[0]?.[0]?.callback_data).toMatch(/^mdl_sel_anthropic_1_1_2_[a-f0-9]{4}$/);
      expect(result[1]?.[0]?.text).toBe("claude-opus-4");
      expect(result[1]?.[0]?.callback_data).toMatch(/^mdl_sel_anthropic_1_2_2_[a-f0-9]{4}$/);
      expect(result[2]?.[0]?.text).toBe("<< Back");
    }
  });

  it("uses modelNames for display text when provided", () => {
    const modelNames = new Map([
      ["nexos/a1b2c3d4-e5f6-7890-abcd-ef1234567890", "Claude Sonnet 4"],
      ["nexos/claude-opus-4", "Claude Opus 4"],
    ]);
    const result = buildModelsKeyboard({
      provider: "nexos",
      models: ["a1b2c3d4-e5f6-7890-abcd-ef1234567890", "claude-opus-4"],
      currentPage: 1,
      totalPages: 1,
      modelNames,
    });
    // 2 model rows + back button
    expect(result).toHaveLength(3);
    expect(result[0]?.[0]?.text).toBe("Claude Sonnet 4");
    expect(result[1]?.[0]?.text).toBe("Claude Opus 4");
    // callback_data uses index format, not model ID (#98221)
    expect(result[0]?.[0]?.callback_data).toMatch(/^mdl_sel_nexos_1_1_2_[a-f0-9]{4}$/);
  });

  it("falls back to model ID when modelNames does not contain an entry", () => {
    const modelNames = new Map([["anthropic/known-id", "Known Model"]]);
    const result = buildModelsKeyboard({
      provider: "anthropic",
      models: ["known-id", "unknown-id"],
      currentPage: 1,
      totalPages: 1,
      modelNames,
    });
    expect(result[0]?.[0]?.text).toBe("Known Model");
    expect(result[1]?.[0]?.text).toBe("unknown-id");
  });

  it("prefixes provider in fallback label for nested provider-local ids (OpenRouter)", () => {
    const result = buildModelsKeyboard({
      provider: "openrouter",
      models: ["openai/gpt-5.4-mini"],
      currentPage: 1,
      totalPages: 1,
    });
    expect(result[0]?.[0]?.text).toBe("openrouter/openai/gpt-5.4-mini");
  });

  it("marks nested provider-local id as current when full ref matches", () => {
    const result = buildModelsKeyboard({
      provider: "openrouter",
      models: ["openai/gpt-5.4-mini"],
      currentModel: "openrouter/openai/gpt-5.4-mini",
      currentPage: 1,
      totalPages: 1,
    });
    expect(result[0]?.[0]?.text).toBe("openrouter/openai/gpt-5.4-mini ✓");
  });

  it("uses provider-scoped modelNames keys to avoid cross-provider collisions", () => {
    const modelNames = new Map([
      ["openai/shared-id", "OpenAI Shared"],
      ["anthropic/shared-id", "Anthropic Shared"],
    ]);

    const openaiResult = buildModelsKeyboard({
      provider: "openai",
      models: ["shared-id"],
      currentPage: 1,
      totalPages: 1,
      modelNames,
    });
    const anthropicResult = buildModelsKeyboard({
      provider: "anthropic",
      models: ["shared-id"],
      currentPage: 1,
      totalPages: 1,
      modelNames,
    });

    expect(openaiResult[0]?.[0]?.text).toBe("OpenAI Shared");
    expect(anthropicResult[0]?.[0]?.text).toBe("Anthropic Shared");
  });

  it("does not mark same-id models from other providers as current", () => {
    const result = buildModelsKeyboard({
      provider: "openai",
      models: ["gpt-5.4", "gpt-5.3-codex-spark"],
      currentModel: "github-copilot/gpt-5.4",
      currentPage: 1,
      totalPages: 1,
    });

    const texts = result.flat().map((button) => button.text);
    expect(texts).toContain("gpt-5.4");
    expect(texts).not.toContain("gpt-5.4 ✓");
  });

  it("renders pagination controls for first, middle, and last pages", () => {
    const cases = [
      {
        name: "first page",
        params: { currentPage: 1, models: ["model1", "model2"] },
        expectedPagination: ["1/3", "Next ▶"],
      },
      {
        name: "middle page",
        params: {
          currentPage: 2,
          models: ["model1", "model2", "model3", "model4", "model5", "model6"],
        },
        expectedPagination: ["◀ Prev", "2/3", "Next ▶"],
      },
      {
        name: "last page",
        params: {
          currentPage: 3,
          models: ["model1", "model2", "model3", "model4", "model5", "model6"],
        },
        expectedPagination: ["◀ Prev", "3/3"],
      },
    ] as const;
    for (const testCase of cases) {
      const result = buildModelsKeyboard({
        provider: "anthropic",
        models: [...testCase.params.models],
        currentPage: testCase.params.currentPage,
        totalPages: 3,
        pageSize: 2,
      });
      // 2 model rows + pagination row + back button
      expect(result, testCase.name).toHaveLength(4);
      expect(result[2]?.map((button) => button.text)).toEqual(testCase.expectedPagination);
    }
  });

  it("keeps short display IDs untouched and truncates overly long IDs", () => {
    const cases = [
      {
        name: "max-length display",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022-with-suffix",
        expected: "claude-3-5-sonnet-20241022-with-suffix",
      },
      {
        name: "overly long display",
        provider: "a",
        model: "this-model-name-is-long-enough-to-need-truncation-abcd",
        startsWith: "…",
        maxLength: 38,
      },
    ] as const;
    for (const testCase of cases) {
      const result = buildModelsKeyboard({
        provider: testCase.provider,
        models: [testCase.model],
        currentPage: 1,
        totalPages: 1,
      });
      const text = result[0]?.[0]?.text;
      if ("expected" in testCase) {
        expect(text, testCase.name).toBe(testCase.expected);
      } else {
        expect(text?.startsWith(testCase.startsWith), testCase.name).toBe(true);
        expect(text?.length, testCase.name).toBeLessThanOrEqual(testCase.maxLength);
      }
    }
  });

  it("does not split surrogate pairs when truncating model labels", () => {
    const longLabel = `a😀${"b".repeat(36)}`;
    const cases = [
      {
        name: "model ID fallback",
        model: longLabel,
      },
      {
        name: "configured display name",
        model: "short-model-id",
        modelNames: new Map([["test/short-model-id", longLabel]]),
      },
    ] as const;

    for (const testCase of cases) {
      const result = buildModelsKeyboard({
        provider: "test",
        models: [testCase.model],
        currentPage: 1,
        totalPages: 1,
        modelNames: "modelNames" in testCase ? testCase.modelNames : undefined,
      });

      expect(result[0]?.[0]?.text, testCase.name).toBe(`…${"b".repeat(36)}`);
    }
  });
});

describe("buildBrowseProvidersButton", () => {
  it("returns browse providers button", () => {
    const result = buildBrowseProvidersButton();
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
    expect(result[0]?.[0]?.text).toBe("Browse providers");
    expect(result[0]?.[0]?.callback_data).toBe("mdl_prov");
  });
});

describe("getModelsPageSize", () => {
  it("returns default page size", () => {
    expect(getModelsPageSize()).toBe(8);
  });
});

describe("calculateTotalPages", () => {
  it("calculates pages correctly", () => {
    expect(calculateTotalPages(0)).toBe(0);
    expect(calculateTotalPages(1)).toBe(1);
    expect(calculateTotalPages(8)).toBe(1);
    expect(calculateTotalPages(9)).toBe(2);
    expect(calculateTotalPages(16)).toBe(2);
    expect(calculateTotalPages(17)).toBe(3);
  });

  it("uses custom page size", () => {
    expect(calculateTotalPages(10, 5)).toBe(2);
    expect(calculateTotalPages(11, 5)).toBe(3);
  });
});

describe("large model lists (OpenRouter-scale)", () => {
  it("handles 100+ models with pagination", () => {
    const models = Array.from({ length: 150 }, (_, i) => `model-${i}`);
    const totalPages = calculateTotalPages(models.length);
    expect(totalPages).toBe(19);

    const firstPage = buildModelsKeyboard({
      provider: "openrouter",
      models,
      currentPage: 1,
      totalPages,
    });
    expect(firstPage.length).toBe(10); // 8 models + pagination + back
    expect(firstPage[0]?.[0]?.text).toBe("model-0");
    expect(firstPage[7]?.[0]?.text).toBe("model-7");

    const lastPage = buildModelsKeyboard({
      provider: "openrouter",
      models,
      currentPage: 19,
      totalPages,
    });
    expect(lastPage.length).toBe(8); // 6 models + pagination + back
    expect(lastPage[0]?.[0]?.text).toBe("model-144");
  });

  it("all callback_data stays within 64-byte limit (#98221)", () => {
    // Realistic model IDs — all should create valid callbacks now
    const models = [
      "anthropic/claude-3-5-sonnet-20241022",
      "google/gemini-2.0-flash-thinking-exp:free",
      "deepseek/deepseek-r1-distill-llama-70b",
      "meta-llama/llama-3.3-70b-instruct:nitro",
      "nousresearch/hermes-3-llama-3.1-405b:extended",
    ];
    const result = buildModelsKeyboard({
      provider: "openrouter",
      models,
      currentPage: 1,
      totalPages: 1,
    });

    for (const row of result) {
      for (const button of row) {
        const bytes = Buffer.byteLength(button.callback_data, "utf8");
        expect(bytes).toBeLessThanOrEqual(64);
      }
    }
  });

  it("never drops models due to callback_data limit (#98221)", () => {
    // The exact scenario from the bug report
    const longModel = "xentriom/gemma-4-12B-agentic-fable5-composer2.5-v2:latest";
    const models = ["short-model-1", longModel, "short-model-2"];
    const result = buildModelsKeyboard({
      provider: "ollama",
      models,
      currentPage: 1,
      totalPages: 1,
    });

    // All 3 models should appear (no silent drops)
    const modelButtons = result.filter((row) => !row[0]?.callback_data.startsWith("mdl_back"));
    expect(modelButtons.length).toBe(3);
    expect(modelButtons[0]?.[0]?.text).toBe("short-model-1");
    expect(modelButtons[1]?.[0]?.text).toBe("…-agentic-fable5-composer2.5-v2:latest");
    expect(modelButtons[2]?.[0]?.text).toBe("short-model-2");

    // All callback_data is under 64 bytes
    for (const row of result) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });
});
