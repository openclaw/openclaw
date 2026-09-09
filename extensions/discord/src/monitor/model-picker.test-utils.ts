// Discord helper module supports model picker utils behavior.
import type {
  ModelsProviderData,
  ModelsRuntimeChoice,
} from "openclaw/plugin-sdk/models-provider-runtime";

export function createModelsProviderData(
  entries: Record<string, string[]>,
  opts?: { defaultProviderOrder?: "insertion" | "sorted" },
): ModelsProviderData {
  const byProvider = new Map<string, Set<string>>();
  for (const [provider, models] of Object.entries(entries)) {
    byProvider.set(provider, new Set(models));
  }
  const providers = Object.keys(entries).toSorted();
  const insertionProvider = Object.keys(entries)[0];
  const defaultProvider =
    opts?.defaultProviderOrder === "sorted"
      ? (providers[0] ?? "openai")
      : (insertionProvider ?? "openai");
  const builtin = {
    id: "openclaw",
    label: "OpenClaw Default",
    description: "Use the built-in OpenClaw runtime.",
  };
  const runtimeChoicesByProvider = new Map(providers.map((provider) => [provider, [builtin]]));
  const runtimeChoicesByModel = new Map(
    [...byProvider].flatMap(([provider, models]) =>
      [...models].map<[string, ModelsRuntimeChoice[]]>((model) => [
        `${provider}/${model}`,
        [builtin],
      ]),
    ),
  );
  return {
    runtimeChoicesByProvider,
    runtimeChoicesByModel,
    isCurrent: () => true,
    byProvider,
    providers,
    resolvedDefault: {
      provider: defaultProvider,
      model: entries[defaultProvider]?.[0] ?? "gpt-4o",
    },
    modelNames: new Map<string, string>(),
  };
}

/** Uniform model facts for fixtures that do not vary runtime eligibility by model. */
export function setFixtureRuntimeChoices(
  data: ModelsProviderData,
  choices: Map<string, ModelsRuntimeChoice[]>,
) {
  const byProvider = data.runtimeChoicesByProvider;
  const byModel = data.runtimeChoicesByModel;
  if (!byProvider || !byModel) {
    throw new Error("Expected complete model-runtime fixture facts");
  }
  for (const [provider, runtimes] of choices) {
    const models = data.byProvider.get(provider);
    if (!models) {
      throw new Error("Unknown fixture provider");
    }
    byProvider.set(provider, runtimes);
    for (const model of models) {
      byModel.set(`${provider}/${model}`, runtimes);
    }
  }
}
