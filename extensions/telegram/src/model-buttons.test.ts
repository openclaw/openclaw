import { describe, expect, it } from "vitest";
import {
  buildModelSelectionCallbackData,
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  parseModelCallbackData,
  resolveModelListCallback,
  resolveModelSelection,
} from "./model-buttons.js";

function keyboard(
  provider: string,
  models: string[],
  options: Partial<Parameters<typeof buildModelsKeyboard>[0]> = {},
) {
  return buildModelsKeyboard({ provider, models, currentPage: 1, totalPages: 1, ...options });
}

describe("model buttons", () => {
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
  it("preserves unambiguous provider ownership for non-legacy provider identifiers", () => {
    for (const provider of ["~", "team/provider", "研究所", "x".repeat(80)]) {
      const callback = buildModelSelectionCallbackData({ provider, model: "model" });
      expect(callback, provider).toMatch(/^mdl1~m:[A-Za-z0-9_-]{43}$/);
      expect(Buffer.byteLength(callback, "utf8"), provider).toBeLessThanOrEqual(64);
    }
  });
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
  it("does not split surrogate pairs when truncating model labels", () => {
    const longLabel = `a😀${"b".repeat(36)}`;
    const untruncated = "claude-3-5-sonnet-20241022-with-suffix";
    for (const model of [longLabel, "short-model-id"]) {
      const result = keyboard("test", [model, untruncated], {
        modelNames: model === longLabel ? undefined : new Map([[`test/${model}`, longLabel]]),
      });
      expect(result[0]?.[0]?.text, model).toBe(`…${"b".repeat(36)}`);
      expect(result[0]?.[0]?.text.length, model).toBeLessThanOrEqual(38);
      expect(result[1]?.[0]?.text, model).toBe(untruncated);
    }
  });

  it("does not redirect a captured button when its model moves to another provider", () => {
    const provider = "provider-with-a-long-name";
    const model = `shared-model-${"x".repeat(35)}`;
    const button = keyboard(provider, [model])[0]?.[0];
    if (!button) {
      throw new Error("Expected a model button");
    }
    const callback = parseModelCallbackData(button.callback_data);
    expect(callback?.type).toBe("select-ref");
    if (callback?.type !== "select-ref") {
      throw new Error("Expected an opaque model callback");
    }
    const resolve = (providers: string[]) =>
      resolveModelSelection({
        callback,
        providers,
        byProvider: new Map(providers.map((id) => [id, new Set([model])])),
      });
    expect(resolve([provider, "replacement-provider"])).toEqual({
      kind: "resolved",
      provider,
      model,
    });
    expect(resolve(["replacement-provider"])).toEqual({
      kind: "ambiguous",
      model: callback.digest,
      matchingProviders: [],
    });
  });
  it("preserves custom page sizes for public plugin consumers", () => {
    expect(calculateTotalPages(10, 5)).toBe(2);
    expect(calculateTotalPages(11, 5)).toBe(3);
    expect(
      keyboard("openai", ["first", "second", "third"], {
        currentPage: 2,
        totalPages: 2,
        pageSize: 2,
      })[0]?.[0]?.text,
    ).toBe("third");
  });
});
