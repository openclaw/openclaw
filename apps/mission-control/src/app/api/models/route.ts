import { NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError, isGatewayUnavailableError } from "@/lib/errors";
import {
  catalogLookup,
  MODEL_CATALOG,
  TIER_LABELS,
  TIER_ORDER,
} from "@/lib/model-catalog";

interface GatewayModel {
  id: string;
  name?: string;
  provider?: string;
  description?: string;
  canStream?: boolean;
  supportedFeatures?: string[];
  selectable?: boolean;
  modelRef?: string;
  tier?: string;
  tierRank?: number;
  badge?: string;
  label?: string;
}

function extractUsageProviders(usagePayload: unknown): Set<string> {
  const active = new Set<string>();
  if (!usagePayload || typeof usagePayload !== "object") {return active;}

  const providers = (usagePayload as { providers?: unknown[] }).providers;
  if (!Array.isArray(providers)) {return active;}

  for (const entry of providers) {
    if (!entry || typeof entry !== "object") {continue;}
    const provider = (entry as { provider?: unknown }).provider;
    if (typeof provider === "string" && provider.trim()) {
      active.add(provider.trim());
    }
  }
  return active;
}

function toModelRef(model: GatewayModel): string {
  const modelId = model.id?.trim();
  if (!modelId) {return "";}
  if (modelId.includes("/")) {return modelId;}
  const provider = model.provider?.trim();
  return provider ? `${provider}/${modelId}` : modelId;
}

/**
 * GET /api/models
 *
 * Fetches available models from the OpenClaw gateway and returns them
 * grouped by provider. This powers the model/provider selector in Settings.
 */
export const GET = withApiGuard(async () => {
  try {
    const client = getOpenClawClient();
    await client.connect();

    let result:
      | {
          models?: GatewayModel[];
          defaultModel?: string;
          defaultProvider?: string;
        }
      | null = null;
    let warning: string | null = null;
    let usagePayload: unknown = null;

    try {
      result = (await client.listModels()) as {
        models?: GatewayModel[];
        defaultModel?: string;
        defaultProvider?: string;
      };
    } catch (modelErr) {
      warning = modelErr instanceof Error ? modelErr.message : String(modelErr);
      result = { models: [] };
    }

    try {
      usagePayload = await client.getUsage();
    } catch {
      usagePayload = null;
    }

    const activeProviders = extractUsageProviders(usagePayload);
    const defaultModel = result?.defaultModel || null;
    const defaultProvider = result?.defaultProvider || null;

    const baseModels = result?.models ?? [];
    const enrichedModels = baseModels.map((model) => {
      const provider = model.provider || "";
      const selectableByProvider =
        activeProviders.size === 0 ||
        (provider ? activeProviders.has(provider) : false);
      const selectableByDefault =
        !!defaultModel &&
        (model.id === defaultModel || toModelRef(model) === defaultModel);

      // Merge curated catalog metadata (label, badge, tier, rank)
      const catalog = catalogLookup(model.id, model.provider);

      return {
        ...model,
        modelRef: toModelRef(model),
        selectable: selectableByProvider || selectableByDefault,
        ...(catalog && {
          label: catalog.label,
          badge: catalog.badge,
          tier: catalog.tier,
          tierRank: catalog.rank,
        }),
      };
    });

    const selectableModels = enrichedModels.filter((model) => model.selectable);
    const models =
      selectableModels.length > 0 ? selectableModels : enrichedModels;

    // Group models by provider
    const byProvider: Record<string, GatewayModel[]> = {};
    for (const model of models) {
      const provider = model.provider || "unknown";
      if (!byProvider[provider]) {byProvider[provider] = [];}
      byProvider[provider].push(model);
    }

    // Sort providers: prioritize well-known ones
    const providerOrder = [
      "anthropic",
      "google-antigravity",
      "google",
      "openai",
      "openai-codex",
      "deepseek",
      "mistral",
      "xai",
      "meta",
    ];
    const sortedProviders = Object.keys(byProvider).toSorted((a, b) => {
      const ai = providerOrder.indexOf(a);
      const bi = providerOrder.indexOf(b);
      if (ai >= 0 && bi >= 0) {return ai - bi;}
      if (ai >= 0) {return -1;}
      if (bi >= 0) {return 1;}
      return a.localeCompare(b);
    });

    return NextResponse.json({
      models,
      byProvider,
      providers: sortedProviders,
      defaultModel,
      defaultProvider,
      activeProviders: Array.from(activeProviders),
      allModelCount: baseModels.length,
      tierLabels: TIER_LABELS,
      tierOrder: TIER_ORDER,
      curatedCount: MODEL_CATALOG.length,
      warning,
    });
  } catch (error) {
    if (isGatewayUnavailableError(error)) {
      // When gateway is down, return curated catalog as fallback
      const fallbackModels = MODEL_CATALOG.map((entry) => ({
        id: entry.id,
        provider: entry.provider,
        modelRef: entry.id.includes("/")
          ? entry.id
          : `${entry.provider}/${entry.id}`,
        selectable: true,
        label: entry.label,
        badge: entry.badge,
        tier: entry.tier,
        tierRank: entry.rank,
      }));
      return NextResponse.json({
        models: fallbackModels,
        byProvider: {},
        providers: [],
        defaultModel: null,
        defaultProvider: null,
        activeProviders: [],
        allModelCount: fallbackModels.length,
        tierLabels: TIER_LABELS,
        tierOrder: TIER_ORDER,
        curatedCount: MODEL_CATALOG.length,
        warning:
          "Gateway is unavailable. Showing curated model list as fallback.",
        degraded: true,
      });
    }
    return handleApiError(error, "Failed to fetch models");
  }
}, ApiGuardPresets.read);
