import { expect, it } from "vitest";
import { DEFAULT_CONTEXT_TOKENS, resolveNativeOwnedRuntimeModel } from "./defaults.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

const nativeRow: ModelCatalogEntry = {
  id: "muse-spark-1.3",
  name: "Muse Spark 1.3",
  provider: "meta",
  nativeRuntime: "muse",
};
const providerRow: ModelCatalogEntry = {
  id: "muse-spark-1.3",
  name: "Muse Spark 1.3",
  provider: "meta",
  contextWindow: 1_048_576,
};

const cases: Array<{
  name: string;
  entries: ModelCatalogEntry[];
  routeVariants?: ModelCatalogEntry[];
  staticEntries?: ModelCatalogEntry[];
  contextWindow: number;
}> = [
  {
    name: "the provider catalog's window",
    entries: [providerRow],
    routeVariants: [nativeRow],
    contextWindow: 1_048_576,
  },
  {
    name: "a static provider row's window",
    entries: [nativeRow],
    staticEntries: [providerRow],
    contextWindow: 1_048_576,
  },
  {
    name: "a static window when the live provider row omits it",
    entries: [nativeRow, { ...providerRow, contextWindow: undefined }],
    staticEntries: [providerRow],
    contextWindow: 1_048_576,
  },
  {
    name: "a static window instead of a synthetic live estimate",
    entries: [nativeRow, { ...providerRow, contextWindowSource: "synthetic" }],
    staticEntries: [providerRow],
    contextWindow: 1_048_576,
  },
  {
    name: "the native row's own window",
    entries: [{ ...nativeRow, contextWindow: 65_536 }, providerRow],
    contextWindow: 65_536,
  },
  {
    name: "the default when nothing lists one",
    entries: [nativeRow],
    contextWindow: DEFAULT_CONTEXT_TOKENS,
  },
];

it.each(cases)(
  "gives a native-owned model $name",
  ({ entries, routeVariants, staticEntries, contextWindow }) => {
    const model = resolveNativeOwnedRuntimeModel({
      catalog: { entries, routeVariants: routeVariants ?? [], staticEntries },
      provider: "meta",
      modelId: "muse-spark-1.3",
      runtimeId: "muse",
    });
    expect(model?.contextWindow).toBe(contextWindow);
  },
);
