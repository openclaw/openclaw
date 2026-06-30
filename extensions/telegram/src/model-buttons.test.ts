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
      // New index-based select format (1-based index in callback data)
      ["mdl_sel_idx_anthropic_1_1", { type: "select", provider: "anthropic", page: 1, index: 1 }],
      [
        "mdl_sel_idx_amazon-bedrock_3_6",
        { type: "select", provider: "amazon-bedrock", page: 3, index: 6 },
      ],
      [
        "mdl_sel_idx_openrouter_99_8",
        { type: "select", provider: "openrouter", page: 99, index: 8 },
      ],
      // Legacy standard format (backward compat)
      [
        "mdl_sel_anthropic/claude-sonnet-4-5",
        { type: "select", provider: "anthropic", model: "claude-sonnet-4-5" },
      ],
      ["mdl_sel_openai/gpt-4/turbo", { type: "select", provider: "openai", model: "gpt-4/turbo" }],
      // Legacy compact format (backward compat)
      [
        "mdl_sel/us.anthropic.claude-3-5-sonnet-20240620-v1:0",
        { type: "select", model: "us.anthropic.claude-3-5-sonnet-20240620-v1:0" },
      ],
      [
        "mdl_sel/anthropic/claude-3-7-sonnet",
        { type: "select", model: "anthropic/claude-3-7-sonnet" },
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
      "mdl_sel/",
      "mdl_sel_idx_", // incomplete index format
      "mdl_sel_idx_only", // no separators
    ];
    for (const input of invalid) {
      expect(parseModelCallbackData(input), input).toBeNull();
    }
  });
});

describe("resolveModelSelection", () => {
  it("returns explicit provider selections unchanged", () => {
    const result = resolveModelSelection({
      callback: { type: "select", provider: "openai", model: "gpt-4.1" },
      providers: ["openai", "anthropic"],
      byProvider: new Map([
        ["openai", new Set(["gpt-4.1"])],
        ["anthropic", new Set(["claude-sonnet-4-5"])],
      ]),
    });
    expect(result).toEqual({ kind: "resolved", provider: "openai", model: "gpt-4.1" });
  });

  it("resolves index-based selection by looking up the model in the provider's list", () => {
    const result = resolveModelSelection({
      callback: { type: "select", provider: "openai", page: 1, index: 2 },
      providers: ["openai", "anthropic"],
      byProvider: new Map([
        ["openai", new Set(["gpt-4.1", "gpt-5.4", "gpt-5.3-codex-spark"])],
        ["anthropic", new Set(["claude-sonnet-4-5"])],
      ]),
    });
    // Sorted: gpt-4.1 (idx 0), gpt-5.3-codex-spark (idx 1), gpt-5.4 (idx 2)
    // Page 1, index 2 (1-based) = global idx 1 = gpt-5.3-codex-spark
    expect(result).toEqual({ kind: "resolved", provider: "openai", model: "gpt-5.3-codex-spark" });
  });

  it("resolves index across page boundaries", () => {
    const models = Array.from({ length: 20 }, (_, i) => `model-${i}`);
    // Page 2, index 2 (1-based) → global index = (2-1)*8 + (2-1) = 9
    // localeCompare sort: model-17 is the 10th element (index 9)
    const result = resolveModelSelection({
      callback: { type: "select", provider: "openai", page: 2, index: 2 },
      providers: ["openai"],
      byProvider: new Map([["openai", new Set(models)]]),
    });
    expect(result).toEqual({ kind: "resolved", provider: "openai", model: "model-17" });
  });

  it("returns ambiguous when index is out of bounds", () => {
    const result = resolveModelSelection({
      callback: { type: "select", provider: "openai", page: 9, index: 1 },
      providers: ["openai"],
      byProvider: new Map([["openai", new Set(["gpt-4.1"])]]),
    });
    expect(result.kind).toBe("ambiguous");
  });

  it("resolves compact callbacks when exactly one provider matches", () => {
    const result = resolveModelSelection({
      callback: { type: "select", model: "shared" },
      providers: ["openai", "anthropic"],
      byProvider: new Map([
        ["openai", new Set(["shared"])],
        ["anthropic", new Set(["other"])],
      ]),
    });
    expect(result).toEqual({ kind: "resolved", provider: "openai", model: "shared" });
  });

  it("returns ambiguous result when zero or multiple providers match", () => {
    const sharedByBoth = resolveModelSelection({
      callback: { type: "select", model: "shared" },
      providers: ["openai", "anthropic"],
      byProvider: new Map([
        ["openai", new Set(["shared"])],
        ["anthropic", new Set(["shared"])],
      ]),
    });
    expect(sharedByBoth).toEqual({
      kind: "ambiguous",
      model: "shared",
      matchingProviders: ["openai", "anthropic"],
    });

    const missingEverywhere = resolveModelSelection({
      callback: { type: "select", model: "missing" },
      providers: ["openai", "anthropic"],
      byProvider: new Map([
        ["openai", new Set(["gpt-4.1"])],
        ["anthropic", new Set(["claude-sonnet-4-5"])],
      ]),
    });
    expect(missingEverywhere).toEqual({
      kind: "ambiguous",
      model: "missing",
      matchingProviders: [],
    });
  });
});

describe("buildModelSelectionCallbackData", () => {
  it("returns index-based callback data in expected format", () => {
    expect(buildModelSelectionCallbackData({ provider: "openai", page: 1, index: 1 })).toBe(
      "mdl_sel_idx_openai_1_1",
    );
    expect(buildModelSelectionCallbackData({ provider: "amazon-bedrock", page: 3, index: 6 })).toBe(
      "mdl_sel_idx_amazon-bedrock_3_6",
    );
    expect(buildModelSelectionCallbackData({ provider: "openrouter", page: 12, index: 8 })).toBe(
      "mdl_sel_idx_openrouter_12_8",
    );
  });

  it("always returns a valid callback data under 64 bytes regardless of model name length", () => {
    // Even with the longest provider name and high page/index values, the
    // callback data stays well within Telegram's 64-byte limit.
    const cb = buildModelSelectionCallbackData({
      provider: "amazon-bedrock",
      page: 99,
      index: 7,
    });
    expect(Buffer.byteLength(cb, "utf8")).toBeLessThanOrEqual(64);
    // The format is consistent: mdl_sel_idx_{provider}_{page}_{index}
    expect(cb).toMatch(/^mdl_sel_idx_/);
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
      expect(result[0]?.[0]?.callback_data).toBe("mdl_sel_idx_anthropic_1_1");
      expect(result[1]?.[0]?.text).toBe("claude-opus-4");
      expect(result[1]?.[0]?.callback_data).toBe("mdl_sel_idx_anthropic_1_2");
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
    // callback_data uses index-based format
    expect(result[0]?.[0]?.callback_data).toBe("mdl_sel_idx_nexos_1_1");
    expect(result[1]?.[0]?.callback_data).toBe("mdl_sel_idx_nexos_1_2");
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

  it("uses index-based callback data regardless of model name length", () => {
    const model = "us.anthropic.claude-3-5-sonnet-20240620-v1:0";
    const result = buildModelsKeyboard({
      provider: "amazon-bedrock",
      models: [model],
      currentPage: 1,
      totalPages: 1,
    });

    // Index-based format always used, regardless of model name length
    expect(result[0]?.[0]?.callback_data).toBe("mdl_sel_idx_amazon-bedrock_1_1");
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
    expect(totalPages).toBe(19); // 150 / 8 = 18.75 -> 19 pages

    // Test first page
    const firstPage = buildModelsKeyboard({
      provider: "openrouter",
      models,
      currentPage: 1,
      totalPages,
    });
    expect(firstPage.length).toBe(10); // 8 models + pagination + back
    expect(firstPage[0]?.[0]?.text).toBe("model-0");
    expect(firstPage[7]?.[0]?.text).toBe("model-7");

    // Test last page
    const lastPage = buildModelsKeyboard({
      provider: "openrouter",
      models,
      currentPage: 19,
      totalPages,
    });
    // Last page has 150 - (18 * 8) = 6 models
    expect(lastPage.length).toBe(8); // 6 models + pagination + back
    expect(lastPage[0]?.[0]?.text).toBe("model-144");
  });

  it("all callback_data stays within 64-byte limit", () => {
    // Realistic OpenRouter model IDs
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

  it("renders all models regardless of name length (no silent drops)", () => {
    // This test verifies the fix for Issue #98221: previously, models with
    // callback_data > 64 bytes were silently dropped.
    const models = [
      "short-model",
      "this-is-an-extremely-long-model-name-that-definitely-exceeds-the-sixty-four-byte-limit",
      "another-short",
    ];
    const result = buildModelsKeyboard({
      provider: "openrouter",
      models,
      currentPage: 1,
      totalPages: 1,
    });

    // All 3 models should be rendered (3 model rows + back)
    const modelButtons = result.filter((row) => !row[0]?.callback_data.startsWith("mdl_back"));
    expect(modelButtons.length).toBe(3);
    expect(modelButtons[0]?.[0]?.text).toBe("short-model");
    expect(modelButtons[1]?.[0]?.text).toBe("…ely-exceeds-the-sixty-four-byte-limit");
    expect(modelButtons[2]?.[0]?.text).toBe("another-short");
  });
});
