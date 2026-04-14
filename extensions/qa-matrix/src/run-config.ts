export type QaProviderMode = "mock-openai" | "live-frontier";
export type QaProviderModeInput = QaProviderMode | "live-openai";

const DEFAULT_QA_MODELS = {
  "live-frontier": {
    primary: "openai/gpt-5.4",
    alternate: "anthropic/claude-sonnet-4-6",
  },
  "mock-openai": {
    primary: "mock-openai/gpt-5.4",
    alternate: "mock-openai/gpt-5.4-alt",
  },
} as const satisfies Record<
  QaProviderMode,
  {
    primary: string;
    alternate: string;
  }
>;

export function normalizeQaProviderMode(input: unknown): QaProviderMode {
  if (input === "mock-openai") {
    return "mock-openai";
  }
  return "live-frontier";
}

export function defaultQaModelForMode(mode: QaProviderMode, alternate = false) {
  const preset = DEFAULT_QA_MODELS[normalizeQaProviderMode(mode)];
  return alternate ? preset.alternate : preset.primary;
}
