import { buildModelAliasIndex, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig, ProviderAuthResult } from "openclaw/plugin-sdk/provider-auth";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  modelEntryWithClaudeCliRuntime,
  resolveClaudeCliAnthropicModelRefs,
  splitTrailingModelAuthProfile,
} from "./claude-model-refs.js";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS,
} from "./cli-constants.js";

type AgentDefaultsModel = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["model"];
type AgentDefaultsModels = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];

function toAnthropicModelRef(raw: string): string | null {
  return resolveClaudeCliAnthropicModelRefs(raw)?.rewriteRef ?? null;
}

function toAnthropicRuntimeRefs(raw: string): string[] {
  return resolveClaudeCliAnthropicModelRefs(raw)?.runtimeRefs ?? [];
}

function toAnthropicSelectedModelRef(raw: string): string | undefined {
  const resolved = resolveClaudeCliAnthropicModelRefs(raw);
  return resolved?.rewriteRef ?? resolved?.selectedRef;
}

function rewriteModelSelection(config: OpenClawConfig): {
  value: AgentDefaultsModel;
  primary?: string;
  runtimeRefs: string[];
  changed: boolean;
} {
  const model = config.agents?.defaults?.model;
  const selection = {
    cfg: config,
    defaultProvider: "anthropic",
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  };
  const aliasIndex = buildModelAliasIndex(selection);
  const runtimeRefs: string[] = [];
  function rewrite(raw: string): { value: string; primary?: string; changed?: boolean } {
    const configured = resolveModelRefFromString({ ...selection, aliasIndex, raw });
    if (configured?.alias) {
      // Resolve before migrating the entry map: a legacy alias row can disappear
      // when its canonical target already exists with different metadata.
      const target = configured.ref.provider + "/" + configured.ref.model;
      runtimeRefs.push(...toAnthropicRuntimeRefs(target));
      const selected = toAnthropicSelectedModelRef(target);
      if (!selected) {
        return { value: raw, primary: raw };
      }
      const { profile } = splitTrailingModelAuthProfile(raw);
      const value = profile ? selected + "@" + profile : selected;
      return { value, primary: value, changed: value !== raw };
    }
    runtimeRefs.push(...toAnthropicRuntimeRefs(raw));
    const converted = toAnthropicModelRef(raw);
    return {
      value: converted ?? raw,
      primary: converted ?? toAnthropicSelectedModelRef(raw),
      changed: Boolean(converted),
    };
  }
  if (typeof model === "string") {
    const rewritten = rewrite(model);
    return { ...rewritten, runtimeRefs, changed: Boolean(rewritten.changed) };
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return { value: model, runtimeRefs, changed: false };
  }
  const primary = typeof model.primary === "string" ? rewrite(model.primary) : undefined;
  const fallbacks = model.fallbacks?.map((entry) => rewrite(entry).value);
  const changed =
    Boolean(primary?.changed) ||
    Boolean(fallbacks?.some((entry, index) => entry !== model.fallbacks?.[index]));
  return {
    value: changed
      ? {
          ...model,
          ...(primary ? { primary: primary.value } : {}),
          ...(fallbacks ? { fallbacks } : {}),
        }
      : model,
    primary: primary?.primary,
    runtimeRefs,
    changed,
  };
}

function rewriteModelEntryMap(models: Record<string, unknown> | undefined): {
  value: Record<string, unknown> | undefined;
  migrated: string[];
  runtimeRefs: string[];
} {
  if (!models) {
    return { value: models, migrated: [], runtimeRefs: [] };
  }

  const next = { ...models };
  const migrated: string[] = [];
  const runtimeRefs: string[] = [];

  for (const [rawKey, value] of Object.entries(models)) {
    runtimeRefs.push(...toAnthropicRuntimeRefs(rawKey));
    const converted = toAnthropicModelRef(rawKey);
    if (!converted) {
      continue;
    }
    if (converted === rawKey) {
      continue;
    }
    if (!Object.hasOwn(next, converted)) {
      Object.defineProperty(next, converted, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    if (normalizeLowercaseStringOrEmpty(rawKey).startsWith(`${CLAUDE_CLI_BACKEND_ID}/`)) {
      delete next[rawKey];
    }
    migrated.push(converted);
  }

  return {
    value: migrated.length > 0 || runtimeRefs.length > 0 ? next : models,
    migrated,
    runtimeRefs,
  };
}

function seedClaudeCliAllowlist(
  models: NonNullable<AgentDefaultsModels>,
  selectedRefs: readonly string[] = [],
): NonNullable<AgentDefaultsModels> {
  const next = { ...models };
  const runtimeRefs = new Set<string>();
  for (const ref of CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS) {
    const canonicalRef = toAnthropicModelRef(ref) ?? ref;
    runtimeRefs.add(canonicalRef);
  }
  for (const ref of selectedRefs) {
    runtimeRefs.add(ref);
  }
  for (const ref of runtimeRefs) {
    const current = Object.hasOwn(next, ref) ? next[ref] : undefined;
    Object.defineProperty(next, ref, {
      value: modelEntryWithClaudeCliRuntime(current),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return next;
}

export function buildAnthropicCliMigrationResult(config: OpenClawConfig): ProviderAuthResult {
  const defaults = config.agents?.defaults;
  const rewrittenModel = rewriteModelSelection(config);
  const rewrittenModels = rewriteModelEntryMap(defaults?.models);
  const existingModels = (rewrittenModels.value ??
    defaults?.models ??
    {}) as NonNullable<AgentDefaultsModels>;
  const nextModels = seedClaudeCliAllowlist(existingModels, [
    ...rewrittenModel.runtimeRefs,
    ...rewrittenModels.runtimeRefs,
    ...rewrittenModels.migrated,
  ]);
  const defaultModel = rewrittenModel.primary ?? CLAUDE_CLI_CANONICAL_DEFAULT_MODEL_REF;

  return {
    profiles: [],
    configPatch: {
      agents: {
        defaults: {
          ...(rewrittenModel.changed ? { model: rewrittenModel.value } : {}),
          models: nextModels,
        },
      },
    },
    // Rewrites `claude-cli/*` -> `anthropic/*`; merge would keep stale keys.
    replaceDefaultModels: true,
    defaultModel,
    notes: [
      "Claude CLI auth detected; kept Anthropic model refs and selected the local Claude CLI runtime.",
      "Existing Anthropic auth profiles are kept for rollback.",
      ...(rewrittenModels.migrated.length > 0
        ? [`Migrated allowlist entries: ${rewrittenModels.migrated.join(", ")}.`]
        : []),
    ],
  };
}
