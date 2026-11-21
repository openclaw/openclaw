import type { ModelRuntimeVariant } from "./model-buttons.js";

/** Route label for a runtime, matching the menu's "API · …" / "Claude CLI · …" prefixes. */
function runtimeVariantLabel(provider: string, runtime: string, fallback: string): string {
  if (provider === "anthropic" || provider === "claude-cli") {
    if (runtime === "claude-cli") {
      return "Claude CLI";
    }
    if (runtime === "openclaw") {
      return "API";
    }
  }
  return fallback;
}

/**
 * Runtime variants per provider/model for the picker: the configured default
 * runtime first, then every other runtime the catalog offers for that model.
 * Models without a known default runtime or with a single runtime get none.
 */
export function buildTelegramRuntimeVariants(modelData: {
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
  runtimeChoicesByModel?: ReadonlyMap<string, readonly { id: string; label: string }[]>;
  modelRuntimeIds?: ReadonlyMap<string, string>;
}): Map<string, ModelRuntimeVariant[]> {
  const variants = new Map<string, ModelRuntimeVariant[]>();
  for (const [provider, models] of modelData.byProvider) {
    for (const model of models) {
      const key = `${provider}/${model}`;
      const defaultRuntime = modelData.modelRuntimeIds?.get(key);
      const choices = modelData.runtimeChoicesByModel?.get(key) ?? [];
      if (!defaultRuntime || choices.length === 0) {
        continue;
      }
      const labelOf = (runtime: string) =>
        runtimeVariantLabel(
          provider,
          runtime,
          choices.find((choice) => choice.id === runtime)?.label ?? runtime,
        );
      const ordered = [
        defaultRuntime,
        ...choices.map((choice) => choice.id).filter((id) => id !== defaultRuntime),
      ];
      const unique = [...new Set(ordered)];
      if (unique.length > 1) {
        variants.set(
          key,
          unique.map((runtime) => ({ runtime, label: labelOf(runtime) })),
        );
      }
    }
  }
  return variants;
}
