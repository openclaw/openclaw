import type { OpenClawConfig } from "../config/config.js";
import type {
  GuardPolicySelectionConfig,
  GuardTaxonomyConfig,
} from "../config/types.agent-defaults.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { resolveAllowlistModelKey } from "./model-selection.js";

export type GuardModelCatalogEntry = {
  value: string;
  label: string;
  hint: string;
  taxonomy: Required<GuardTaxonomyConfig>;
};

const QWEN_GUARD_TAXONOMY: Required<GuardTaxonomyConfig> = {
  labels: ["Safe", "Unsafe", "Controversial"],
  categories: [
    "Violent",
    "Non-violent Illegal Acts",
    "Sexual Content or Sexual Acts",
    "PII",
    "Suicide & Self-Harm",
    "Unethical Acts",
    "Politically Sensitive Topics",
    "Copyright Violation",
    "None",
  ],
};

const LLAMA_GUARD_TAXONOMY: Required<GuardTaxonomyConfig> = {
  labels: ["safe", "unsafe"],
  categories: [
    "S1: Violent Crimes",
    "S2: Non-Violent Crimes",
    "S3: Sex-Related Crimes",
    "S4: Child Sexual Exploitation",
    "S5: Defamation",
    "S6: Specialized Advice",
    "S7: Privacy",
    "S8: Intellectual Property",
    "S9: Indiscriminate Weapons",
    "S10: Hate",
    "S11: Suicide & Self-Harm",
    "S12: Sexual Content",
    "S13: Elections",
    "S14: Code Interpreter Abuse",
  ],
};

export const GUARD_MODEL_CATALOG: GuardModelCatalogEntry[] = [
  {
    value: "chutes/Qwen/Qwen3Guard",
    label: "chutes/Qwen/Qwen3Guard",
    hint: "Qwen3Guard · Alibaba/Qwen · purpose-built safety classifier",
    taxonomy: QWEN_GUARD_TAXONOMY,
  },
  {
    value: "groq/meta-llama/llama-guard-3-8b",
    label: "groq/meta-llama/llama-guard-3-8b",
    hint: "Llama Guard 3 8B · Meta · fast inference via Groq",
    taxonomy: LLAMA_GUARD_TAXONOMY,
  },
  {
    value: "together/meta-llama/Llama-Guard-3-8B",
    label: "together/meta-llama/Llama-Guard-3-8B",
    hint: "Llama Guard 3 8B · Meta · via Together AI",
    taxonomy: LLAMA_GUARD_TAXONOMY,
  },
  {
    value: "together/meta-llama/Meta-Llama-Guard-2-8B",
    label: "together/meta-llama/Meta-Llama-Guard-2-8B",
    hint: "Llama Guard 2 8B · Meta · via Together AI",
    taxonomy: LLAMA_GUARD_TAXONOMY,
  },
  {
    value: "openrouter/meta-llama/llama-guard-3-8b",
    label: "openrouter/meta-llama/llama-guard-3-8b",
    hint: "Llama Guard 3 8B · Meta · via OpenRouter",
    taxonomy: LLAMA_GUARD_TAXONOMY,
  },
];

function normalizeGuardTerms(values: string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeGuardTaxonomy(
  taxonomy: GuardTaxonomyConfig | undefined,
): Required<GuardTaxonomyConfig> | undefined {
  if (!taxonomy) {
    return undefined;
  }
  const labels = normalizeGuardTerms(taxonomy.labels);
  const categories = normalizeGuardTerms(taxonomy.categories);
  if (!labels && !categories) {
    return undefined;
  }
  return {
    labels: labels ?? [],
    categories: categories ?? [],
  };
}

export function normalizeGuardPolicySelection(
  selection: GuardPolicySelectionConfig | undefined,
): GuardPolicySelectionConfig | undefined {
  if (!selection) {
    return undefined;
  }
  const enabledLabels = normalizeGuardTerms(selection.enabledLabels);
  const enabledCategories = normalizeGuardTerms(selection.enabledCategories);
  if (!enabledLabels && !enabledCategories) {
    return undefined;
  }
  return {
    ...(enabledLabels ? { enabledLabels } : {}),
    ...(enabledCategories ? { enabledCategories } : {}),
  };
}

function normalizeGuardModelKey(modelRef: string): string | undefined {
  const trimmed = modelRef.trim();
  if (!trimmed) {
    return undefined;
  }
  return resolveAllowlistModelKey(trimmed, DEFAULT_PROVIDER) ?? trimmed;
}

export function resolveGuardCatalogEntry(modelRef: string): GuardModelCatalogEntry | undefined {
  const key = normalizeGuardModelKey(modelRef);
  if (!key) {
    return undefined;
  }
  return GUARD_MODEL_CATALOG.find(
    (entry) => normalizeGuardModelKey(entry.value)?.toLowerCase() === key.toLowerCase(),
  );
}

export function resolveKnownGuardTaxonomy(
  modelRef: string,
): Required<GuardTaxonomyConfig> | undefined {
  return resolveGuardCatalogEntry(modelRef)?.taxonomy;
}

export function resolveConfiguredGuardTaxonomy(
  cfg: OpenClawConfig | undefined,
  modelRef: string,
): Required<GuardTaxonomyConfig> | undefined {
  const key = normalizeGuardModelKey(modelRef);
  if (!cfg?.agents?.defaults?.models || !key) {
    return resolveKnownGuardTaxonomy(modelRef);
  }

  for (const [entryKey, entryValue] of Object.entries(cfg.agents.defaults.models)) {
    if (normalizeGuardModelKey(entryKey)?.toLowerCase() !== key.toLowerCase()) {
      continue;
    }
    const configured = normalizeGuardTaxonomy(entryValue?.guardTaxonomy);
    return configured ?? resolveKnownGuardTaxonomy(modelRef);
  }

  return resolveKnownGuardTaxonomy(modelRef);
}

export function resolveConfiguredGuardPolicySelection(
  cfg: OpenClawConfig | undefined,
  scope: "input" | "output",
  modelRef: string,
): GuardPolicySelectionConfig | undefined {
  const key = normalizeGuardModelKey(modelRef);
  const entries =
    scope === "input"
      ? cfg?.agents?.defaults?.inputGuardPolicy
      : cfg?.agents?.defaults?.outputGuardPolicy;
  if (!entries || !key) {
    return undefined;
  }

  for (const [entryKey, entryValue] of Object.entries(entries)) {
    if (normalizeGuardModelKey(entryKey)?.toLowerCase() !== key.toLowerCase()) {
      continue;
    }
    return normalizeGuardPolicySelection(entryValue);
  }

  return undefined;
}

export function upsertGuardTaxonomy(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  taxonomy: GuardTaxonomyConfig;
}): OpenClawConfig {
  const key = normalizeGuardModelKey(params.modelRef) ?? params.modelRef.trim();
  const normalized = normalizeGuardTaxonomy(params.taxonomy);
  if (!key || !normalized) {
    return params.cfg;
  }

  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      defaults: {
        ...params.cfg.agents?.defaults,
        models: {
          ...params.cfg.agents?.defaults?.models,
          [key]: {
            ...params.cfg.agents?.defaults?.models?.[key],
            guardTaxonomy: normalized,
          },
        },
      },
    },
  };
}

export function upsertGuardPolicySelection(params: {
  cfg: OpenClawConfig;
  scope: "input" | "output";
  modelRef: string;
  selection: GuardPolicySelectionConfig;
}): OpenClawConfig {
  const key = normalizeGuardModelKey(params.modelRef) ?? params.modelRef.trim();
  const normalized = normalizeGuardPolicySelection(params.selection) ?? {
    enabledLabels: [],
    enabledCategories: [],
  };
  if (!key) {
    return params.cfg;
  }

  const current =
    params.scope === "input"
      ? params.cfg.agents?.defaults?.inputGuardPolicy
      : params.cfg.agents?.defaults?.outputGuardPolicy;
  const next = {
    ...current,
    [key]: normalized,
  };

  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      defaults: {
        ...params.cfg.agents?.defaults,
        ...(params.scope === "input" ? { inputGuardPolicy: next } : { outputGuardPolicy: next }),
      },
    },
  };
}
