// Telegram tests cover model buttons plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildModelSelectionCallbackData,
  buildModelsKeyboard,
  expandModelEntries,
  resolveModelRuntimeSelection,
  buildProviderKeyboard,
  calculateTotalPages,
  parseModelCallbackData,
  resolveModelListCallback,
  resolveModelSelection,
} from "./model-buttons.js";

describe("parseModelCallbackData", () => {
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
    ];
    for (const input of invalid) {
      expect(parseModelCallbackData(input), input).toBeNull();
    }
  });
});

describe("buildModelSelectionCallbackData", () => {
  it("preserves unambiguous provider ownership for non-legacy provider identifiers", () => {
    for (const provider of ["~", "team/provider", "研究所", "x".repeat(80)]) {
      const callback = buildModelSelectionCallbackData({ provider, model: "model" });
      expect(callback, provider).toMatch(/^mdl1~m:[A-Za-z0-9_-]{43}$/);
      expect(Buffer.byteLength(callback, "utf8"), provider).toBeLessThanOrEqual(64);
    }
  });
});

describe("opaque provider list callbacks", () => {
  it("keeps arbitrary provider identifiers selectable without exceeding Telegram's limit", () => {
    for (const provider of ["~", "team/provider", "研究所", "x".repeat(80)]) {
      const callback = buildProviderKeyboard([{ id: provider, count: 1 }])[0]?.[0]?.callback_data;
      expect(callback, provider).toMatch(/^mdl1~p:[A-Za-z0-9_-]{43}:1$/);
      expect(Buffer.byteLength(callback ?? "", "utf8"), provider).toBeLessThanOrEqual(64);
      const parsed = parseModelCallbackData(callback ?? "");
      expect(parsed?.type).toBe("list-ref");
      if (parsed?.type === "list-ref") {
        expect(resolveModelListCallback({ callback: parsed, providers: [provider] })).toEqual({
          provider,
          page: 1,
        });
        expect(
          resolveModelListCallback({ callback: parsed, providers: ["other"] }),
        ).toBeUndefined();
        expect(
          resolveModelListCallback({ callback: parsed, providers: [provider, provider] }),
        ).toBeUndefined();
      }
    }
  });
});

describe("buildModelsKeyboard", () => {
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
        models: [testCase.model, "claude-3-5-sonnet-20241022-with-suffix"],
        currentPage: 1,
        totalPages: 1,
        modelNames: "modelNames" in testCase ? testCase.modelNames : undefined,
      });

      expect(result[0]?.[0]?.text, testCase.name).toBe(`…${"b".repeat(36)}`);
      expect(result[0]?.[0]?.text.length, testCase.name).toBeLessThanOrEqual(38);
      expect(result[1]?.[0]?.text, testCase.name).toBe("claude-3-5-sonnet-20241022-with-suffix");
    }
  });

  it("does not redirect a captured button when its model moves to another provider", () => {
    const provider = "provider-with-a-long-name";
    const model = `shared-model-${"x".repeat(35)}`;
    const result = buildModelsKeyboard({
      provider,
      models: [model],
      currentPage: 1,
      totalPages: 1,
    });

    const button = result[0]?.[0];
    if (!button) {
      throw new Error("Expected a model button");
    }
    const callback = parseModelCallbackData(button.callback_data);
    expect(callback?.type).toBe("select-ref");
    if (callback?.type !== "select-ref") {
      throw new Error("Expected an opaque model callback");
    }
    expect(
      resolveModelSelection({
        callback,
        providers: [provider, "replacement-provider"],
        byProvider: new Map([
          [provider, new Set([model])],
          ["replacement-provider", new Set([model])],
        ]),
      }),
    ).toEqual({ kind: "resolved", provider, model });
    expect(
      resolveModelSelection({
        callback,
        providers: ["replacement-provider"],
        byProvider: new Map([["replacement-provider", new Set([model])]]),
      }),
    ).toEqual({ kind: "ambiguous", model: callback.digest, matchingProviders: [] });
  });
});

describe("model picker pagination contracts", () => {
  it("preserves custom page sizes for public plugin consumers", () => {
    expect(calculateTotalPages(10, 5)).toBe(2);
    expect(calculateTotalPages(11, 5)).toBe(3);
    expect(
      buildModelsKeyboard({
        provider: "openai",
        models: ["first", "second", "third"],
        currentPage: 2,
        totalPages: 2,
        pageSize: 2,
      })[0]?.[0]?.text,
    ).toBe("third");
  });
});

describe("runtime variants", () => {
  const runtimeVariants = new Map([
    [
      "anthropic/claude-opus-5-5",
      [
        { runtime: "openclaw", label: "API" },
        { runtime: "claude-cli", label: "Claude CLI" },
      ],
    ],
    [
      "anthropic/claude-opus-4-8",
      [
        { runtime: "claude-cli", label: "Claude CLI" },
        { runtime: "openclaw", label: "API" },
      ],
    ],
  ]);
  const baseModelNames = new Map([
    ["anthropic/claude-opus-5-5", "Claude Opus 5.5"],
    ["anthropic/claude-opus-4-8", "Claude Opus 4.8"],
    ["anthropic/claude-haiku-4-5", "Claude Haiku 4.5"],
  ]);
  const byProvider = new Map([
    ["anthropic", new Set(["claude-haiku-4-5", "claude-opus-4-8", "claude-opus-5-5"])],
  ]);

  const runtimeCallbackData = (
    model: string,
    runtime: string,
    variants: ReadonlyMap<string, readonly { runtime: string; label: string }[]>,
  ) =>
    buildModelsKeyboard({
      provider: "anthropic",
      models: [model],
      currentPage: 1,
      totalPages: 1,
      runtimeVariants: variants,
    })
      .flat()
      .find((button) =>
        (variants.get(`anthropic/${model}`) ?? []).some(
          (variant) => variant.runtime === runtime && button.text.startsWith(`${variant.label} · `),
        ),
      )?.callback_data ?? "";

  it("round-trips runtime selection callbacks", () => {
    const data = runtimeCallbackData("claude-opus-5-5", "claude-cli", runtimeVariants);
    expect(data).toBe("mdl_rt_claude-cli_anthropic/claude-opus-5-5");
    expect(parseModelCallbackData(data)).toEqual({
      type: "select-runtime",
      provider: "anthropic",
      model: "claude-opus-5-5",
      runtime: "claude-cli",
    });
  });

  it("uses an opaque callback when the readable one does not fit", () => {
    const model = `claude-${"x".repeat(60)}`;
    const variants = new Map([
      [
        `anthropic/${model}`,
        [
          { runtime: "openclaw", label: "API" },
          { runtime: "claude-cli", label: "Claude CLI" },
        ],
      ],
    ]);
    const data = runtimeCallbackData(model, "claude-cli", variants);
    expect(data.startsWith("mdl1~r:")).toBe(true);
    const parsed = parseModelCallbackData(data);
    expect(parsed?.type).toBe("select-runtime-ref");
    expect(
      resolveModelRuntimeSelection({
        callback: parsed as Extract<NonNullable<typeof parsed>, { type: "select-runtime-ref" }>,
        providers: ["anthropic"],
        byProvider: new Map([["anthropic", new Set([model])]]),
        runtimeVariants: variants,
      }),
    ).toEqual({ provider: "anthropic", model, runtime: "claude-cli" });
  });

  it("rejects runtimes the picker did not offer", () => {
    expect(
      resolveModelRuntimeSelection({
        callback: {
          type: "select-runtime",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          runtime: "claude-cli",
        },
        providers: ["anthropic"],
        byProvider,
        runtimeVariants,
      }),
    ).toBeUndefined();
  });

  it("shows one button per runtime and marks the active pair", () => {
    const models = ["claude-haiku-4-5", "claude-opus-4-8", "claude-opus-5-5"];
    expect(expandModelEntries("anthropic", models, runtimeVariants)).toHaveLength(5);
    const rows = buildModelsKeyboard({
      provider: "anthropic",
      models,
      currentModel: "anthropic/claude-opus-5-5",
      currentRuntime: "claude-cli",
      currentPage: 1,
      totalPages: 1,
      modelNames: new Map([["anthropic/claude-haiku-4-5", "API · Claude Haiku 4.5"]]),
      runtimeVariants,
      baseModelNames,
    });
    const labels = rows.flat().map((button) => button.text);
    expect(labels).toEqual([
      "API · Claude Haiku 4.5",
      "Claude CLI · Claude Opus 4.8",
      "API · Claude Opus 4.8",
      "API · Claude Opus 5.5",
      "Claude CLI · Claude Opus 5.5 ✓",
      "<< Back",
    ]);
    expect(rows.flat()[4]?.callback_data).toBe("mdl_rt_claude-cli_anthropic/claude-opus-5-5");
  });

  it("marks the default runtime when the session has no runtime pin", () => {
    const rows = buildModelsKeyboard({
      provider: "anthropic",
      models: ["claude-opus-5-5"],
      currentModel: "anthropic/claude-opus-5-5",
      currentPage: 1,
      totalPages: 1,
      runtimeVariants,
      baseModelNames,
    });
    expect(
      rows
        .flat()
        .map((button) => button.text)
        .slice(0, 2),
    ).toEqual(["API · Claude Opus 5.5 ✓", "Claude CLI · Claude Opus 5.5"]);
  });

  it("keeps the runtime prefix when a long model name is truncated", () => {
    const model = "claude-opus-5-5-extended-context-preview";
    const variants = new Map([
      [
        `anthropic/${model}`,
        [
          { runtime: "openclaw", label: "API" },
          { runtime: "claude-cli", label: "Claude CLI" },
        ],
      ],
    ]);
    const labels = buildModelsKeyboard({
      provider: "anthropic",
      models: [model],
      currentPage: 1,
      totalPages: 1,
      runtimeVariants: variants,
      baseModelNames: new Map([
        [`anthropic/${model}`, "Claude Opus 5.5 Extended Context Preview Edition"],
      ]),
    })
      .flat()
      .map((button) => button.text)
      .slice(0, 2);
    expect(labels[0]?.startsWith("API · …")).toBe(true);
    expect(labels[1]?.startsWith("Claude CLI · …")).toBe(true);
    expect(labels[0]).not.toBe(labels[1]);
    for (const label of labels) {
      expect(label?.length).toBeLessThanOrEqual(38);
    }
  });
});
