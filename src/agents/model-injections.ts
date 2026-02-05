import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelCatalogEntry } from "./model-catalog.js";

type InjectedModelSpec = {
  provider: string;
  id: string;
  name: string;
  basedOn?: {
    provider: string;
    id: string;
  };
};

// Keep this list tiny + explicit. Anything here is treated as "known good" even if
// upstream (pi-ai) hasn't shipped it yet.
const INJECTED_MODELS: InjectedModelSpec[] = [
  {
    provider: "anthropic",
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    basedOn: { provider: "anthropic", id: "claude-opus-4-5" },
  },
];

export function injectModelCatalogEntries(entries: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const out = [...entries];
  const has = (provider: string, id: string) =>
    out.some((entry) => entry.provider === provider && entry.id === id);

  for (const injected of INJECTED_MODELS) {
    if (has(injected.provider, injected.id)) {
      continue;
    }

    const base =
      injected.basedOn &&
      out.find(
        (entry) => entry.provider === injected.basedOn.provider && entry.id === injected.basedOn.id,
      );

    // Only inject when we can anchor off something already in the catalog.
    // This avoids polluting tests (or edge cases) where only a subset of providers is present.
    if (injected.basedOn && !base) {
      continue;
    }

    out.push({
      id: injected.id,
      name: injected.name,
      provider: injected.provider,
      contextWindow: base?.contextWindow,
      reasoning: base?.reasoning,
      input: base?.input,
    });
  }

  return out;
}

export function resolveInjectedModelFromRegistry(params: {
  provider: string;
  modelId: string;
  find: (provider: string, modelId: string) => Model<Api> | null;
}): Model<Api> | null {
  const provider = params.provider.trim();
  const modelId = params.modelId.trim();
  const injected = INJECTED_MODELS.find(
    (entry) => entry.provider === provider && entry.id === modelId,
  );
  if (!injected) {
    return null;
  }

  const base = injected.basedOn && params.find(injected.basedOn.provider, injected.basedOn.id);
  if (base) {
    return {
      ...base,
      id: injected.id,
      name: injected.name,
    };
  }

  // Last-resort fallback if the "basedOn" model isn't available in the registry.
  // This keeps the model selectable, but avoids pretending we know exact pricing/limits.
  return {
    id: injected.id,
    name: injected.name,
    api: "anthropic-messages",
    provider: injected.provider,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  } as Model<Api>;
}
