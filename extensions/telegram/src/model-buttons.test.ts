import assert from "node:assert/strict";
import { expect, it } from "vitest";
import {
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

it("returns null for unsupported callback variants", () => {
  for (const input of ["", "mdl_list_openai_9007199254740993", "mdl_sel_noslash", "mdl_sel/"]) {
    expect(parseModelCallbackData(input), input).toBeNull();
  }
});
it("keeps arbitrary provider identifiers selectable without exceeding Telegram's limit", () => {
  for (const provider of ["~", "x".repeat(80)]) {
    const callback = buildProviderKeyboard([{ id: provider, count: 1 }])[0]?.[0]?.callback_data;
    const parsed = parseModelCallbackData(callback ?? "");
    assert(parsed?.type === "list-ref");
    const resolve = (providers: string[]) =>
      resolveModelListCallback({ callback: parsed, providers });
    expect(resolve([provider])).toEqual({ provider, page: 1 });
    expect(resolve(["other"])).toBeUndefined();
    expect(resolve([provider, provider])).toBeUndefined();
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
    expect(result[1]?.[0]?.text, model).toBe(untruncated);
  }
});

it.each(["~", "provider-with-a-long-name"])(
  "does not redirect a captured %s button to another provider",
  (provider) => {
    const model = `shared-model-${"x".repeat(35)}`;
    const callback = parseModelCallbackData(
      keyboard(provider, [model])[0]?.[0]?.callback_data ?? "",
    );
    assert(callback?.type === "select-ref");
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
  },
);
it("preserves custom page sizes for public plugin consumers", () => {
  expect([calculateTotalPages(10, 5), calculateTotalPages(11, 5)]).toEqual([2, 3]);
  expect(
    keyboard("openai", ["first", "second", "third"], {
      currentPage: 2,
      totalPages: 2,
      pageSize: 2,
    })[0]?.[0]?.text,
  ).toBe("third");
});
