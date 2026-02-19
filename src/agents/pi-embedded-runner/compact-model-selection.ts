import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { getApiKeyForModel } from "../model-auth.js";
import {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../model-selection.js";
import { resolveModel } from "./model.js";
import { describeUnknownError } from "./utils.js";

type ResolveModelFn = typeof resolveModel;
type ResolveModelResult = ReturnType<ResolveModelFn>;
type ResolvedRuntimeModel = NonNullable<ResolveModelResult["model"]>;

export type ResolvedCompactionModel = {
  provider: string;
  modelId: string;
  model: ResolvedRuntimeModel;
  authStorage: ResolveModelResult["authStorage"];
  modelRegistry: ResolveModelResult["modelRegistry"];
  overrideUsed: boolean;
};

export function resolveCompactionOverrideModelRef(params: {
  raw: string;
  cfg?: OpenClawConfig;
  defaultProvider: string;
}):
  | {
      provider: string;
      modelId: string;
      key: string;
      source: "alias" | "provider/model";
    }
  | { error: string } {
  const raw = params.raw.trim();
  if (!raw) {
    return { error: "compaction.model is empty" };
  }
  const cfg = params.cfg;
  if (!cfg) {
    return { error: "config unavailable" };
  }
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: params.defaultProvider,
  });
  const resolved = resolveModelRefFromString({
    raw,
    defaultProvider: params.defaultProvider,
    aliasIndex,
  });
  if (!resolved) {
    return { error: `invalid model reference: ${raw}` };
  }
  if (!raw.includes("/") && !resolved.alias) {
    return {
      error: `invalid model reference: ${raw} (expected provider/model or configured alias)`,
    };
  }

  const configuredKeys = buildConfiguredAllowlistKeys({
    cfg,
    defaultProvider: params.defaultProvider,
  });
  if (!configuredKeys || configuredKeys.size === 0) {
    return {
      error: "agents.defaults.models is empty; compaction.model requires a configured model",
    };
  }

  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (!configuredKeys.has(key)) {
    return { error: `model not configured in agents.defaults.models: ${key}` };
  }
  return {
    provider: resolved.ref.provider,
    modelId: resolved.ref.model,
    key,
    source: resolved.alias ? "alias" : "provider/model",
  };
}

async function resolveAndAuthenticateCompactionModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir: string;
  authProfileId?: string;
  resolveModelFn: ResolveModelFn;
  getApiKeyForModelFn: typeof getApiKeyForModel;
}): Promise<
  { ok: true; value: Omit<ResolvedCompactionModel, "overrideUsed"> } | { ok: false; reason: string }
> {
  const { model, error, authStorage, modelRegistry } = params.resolveModelFn(
    params.provider,
    params.modelId,
    params.agentDir,
    params.cfg,
  );
  if (!model) {
    return {
      ok: false,
      reason: error ?? `Unknown model: ${params.provider}/${params.modelId}`,
    };
  }
  try {
    const apiKeyInfo = await params.getApiKeyForModelFn({
      model,
      cfg: params.cfg,
      profileId: params.authProfileId,
      agentDir: params.agentDir,
    });
    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk") {
        throw new Error(
          `No API key resolved for provider "${model.provider}" (auth mode: ${apiKeyInfo.mode}).`,
        );
      }
    } else if (model.provider === "github-copilot") {
      const { resolveCopilotApiToken } = await import("../../providers/github-copilot-token.js");
      const copilotToken = await resolveCopilotApiToken({
        githubToken: apiKeyInfo.apiKey,
      });
      authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
    } else {
      authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
    }
  } catch (err) {
    return { ok: false, reason: describeUnknownError(err) };
  }
  return {
    ok: true,
    value: {
      provider: params.provider,
      modelId: params.modelId,
      model,
      authStorage,
      modelRegistry,
    },
  };
}

export async function resolveCompactionModelForRun(params: {
  sessionProvider: string;
  sessionModelId: string;
  overrideRaw?: string;
  cfg?: OpenClawConfig;
  agentDir: string;
  authProfileId?: string;
  logInfo?: (message: string) => void;
  logWarn?: (message: string) => void;
  resolveModelFn?: ResolveModelFn;
  getApiKeyForModelFn?: typeof getApiKeyForModel;
}): Promise<{ ok: true; value: ResolvedCompactionModel } | { ok: false; reason: string }> {
  const resolveModelFn = params.resolveModelFn ?? resolveModel;
  const getApiKeyForModelFn = params.getApiKeyForModelFn ?? getApiKeyForModel;
  const sessionRef = `${params.sessionProvider}/${params.sessionModelId}`;
  const rawOverride = params.overrideRaw?.trim() ?? "";
  const selectionDefaultProvider = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      }).provider
    : params.sessionProvider;

  if (rawOverride) {
    const overrideRef = resolveCompactionOverrideModelRef({
      raw: rawOverride,
      cfg: params.cfg,
      defaultProvider: selectionDefaultProvider,
    });
    if ("error" in overrideRef) {
      params.logWarn?.(
        `[compaction] override model "${rawOverride}" ignored (${overrideRef.error}); using session model ${sessionRef}`,
      );
    } else {
      const sameProvider =
        normalizeProviderId(overrideRef.provider) === normalizeProviderId(params.sessionProvider);
      const overrideAuthProfileId = sameProvider ? params.authProfileId : undefined;
      const overrideResolved = await resolveAndAuthenticateCompactionModel({
        provider: overrideRef.provider,
        modelId: overrideRef.modelId,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authProfileId: overrideAuthProfileId,
        resolveModelFn,
        getApiKeyForModelFn,
      });
      if (overrideResolved.ok) {
        const overrideRefText = `${overrideRef.provider}/${overrideRef.modelId}`;
        params.logInfo?.(
          `[compaction] using override model ${overrideRefText} (session model: ${sessionRef})`,
        );
        return {
          ok: true,
          value: {
            ...overrideResolved.value,
            overrideUsed: true,
          },
        };
      }
      params.logWarn?.(
        `[compaction] override model ${overrideRef.provider}/${overrideRef.modelId} unavailable (${overrideResolved.reason}); using session model ${sessionRef}`,
      );
    }
  }

  const sessionResolved = await resolveAndAuthenticateCompactionModel({
    provider: params.sessionProvider,
    modelId: params.sessionModelId,
    cfg: params.cfg,
    agentDir: params.agentDir,
    authProfileId: params.authProfileId,
    resolveModelFn,
    getApiKeyForModelFn,
  });
  if (!sessionResolved.ok) {
    return { ok: false, reason: sessionResolved.reason };
  }
  return {
    ok: true,
    value: {
      ...sessionResolved.value,
      overrideUsed: false,
    },
  };
}
