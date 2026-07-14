import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeMediaProviderId } from "../media-understanding/provider-id.js";
import type { ImageCompressionModelPolicy, ImageCompressionPolicy } from "../media/web-media.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "../plugins/manifest-contract-eligibility.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { resolveModelAsync } from "./embedded-agent-runner/model.js";
import {
  bundledStaticCatalogProviderUsesRuntimeAugment,
  resolveBundledStaticCatalogModel,
} from "./embedded-agent-runner/model.static-catalog.js";
import type { ImageCompressionModelCandidate } from "./image-compression-policy.types.js";

export type ImageCompressionPolicyDeps = {
  resolveBundledStaticCatalogModel: typeof resolveBundledStaticCatalogModel;
  resolveModelAsync: typeof resolveModelAsync;
};

const defaultImageCompressionPolicyDeps: ImageCompressionPolicyDeps = {
  resolveBundledStaticCatalogModel,
  resolveModelAsync,
};

function imageCompressionPolicyHasDimensionLimit(policy: ImageCompressionModelPolicy): boolean {
  return typeof policy.maxSidePx === "number" || typeof policy.maxPixels === "number";
}

function imageCompressionModelPolicyHasAnyLimit(policy: ImageCompressionModelPolicy): boolean {
  return (
    typeof policy.maxBytes === "number" ||
    typeof policy.maxSidePx === "number" ||
    typeof policy.maxPixels === "number" ||
    typeof policy.preferredSidePx === "number"
  );
}

function mergeImageCompressionPolicies(params: {
  runtimePolicy: ImageCompressionModelPolicy;
  staticPolicy: ImageCompressionModelPolicy;
}): ImageCompressionModelPolicy {
  return {
    ...params.runtimePolicy,
    ...params.staticPolicy,
  };
}

function resolveBundledStaticCompressionModelPolicy(params: {
  cfg?: OpenClawConfig;
  deps: ImageCompressionPolicyDeps;
  provider: string;
  model: string;
  workspaceDir?: string;
}): ImageCompressionModelPolicy {
  const model = params.deps.resolveBundledStaticCatalogModel({
    provider: params.provider,
    modelId: params.model,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    includeRuntimeDiscovery: true,
  });
  return model?.mediaInput?.image ?? {};
}

function providerUsesRuntimeModelAugment(params: {
  cfg?: OpenClawConfig;
  provider: string;
  workspaceDir?: string;
}): boolean {
  const provider = normalizeMediaProviderId(params.provider);
  if (!provider) {
    return false;
  }
  if (bundledStaticCatalogProviderUsesRuntimeAugment({ provider })) {
    return true;
  }
  const config = params.cfg ?? {};
  const snapshot = loadManifestMetadataSnapshot({
    config,
    env: process.env,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  });
  return snapshot.plugins.some((plugin) => {
    const ownsProvider =
      plugin.providers.some((candidate) => normalizeMediaProviderId(candidate) === provider) ||
      Boolean(plugin.modelCatalog?.providers?.[provider]);
    if (!ownsProvider) {
      return false;
    }
    const runtimeAugment =
      plugin.modelCatalog?.runtimeAugment === true ||
      (plugin.origin !== "bundled" &&
        plugin.providers.some((candidate) => normalizeMediaProviderId(candidate) === provider));
    if (!runtimeAugment) {
      return false;
    }
    return isManifestPluginAvailableForControlPlane({
      snapshot,
      plugin,
      config,
    });
  });
}

async function resolveCompressionModelPolicyWithHooks(params: {
  cfg?: OpenClawConfig;
  deps: ImageCompressionPolicyDeps;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
  skipProviderRuntimeHooks: boolean;
}): Promise<ImageCompressionModelPolicy> {
  try {
    const resolved = await params.deps.resolveModelAsync(
      params.provider,
      params.model,
      params.agentDir,
      params.cfg,
      {
        allowBundledStaticCatalogFallback: true,
        skipProviderRuntimeHooks: params.skipProviderRuntimeHooks,
        skipAgentDiscovery: true,
        workspaceDir: params.workspaceDir,
      },
    );
    return (resolved.model as ProviderRuntimeModel | undefined)?.mediaInput?.image ?? {};
  } catch {
    return {};
  }
}

async function resolveCompressionModelPolicy(params: {
  cfg?: OpenClawConfig;
  deps: ImageCompressionPolicyDeps;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<ImageCompressionModelPolicy> {
  const configuredStaticPolicy = await resolveCompressionModelPolicyWithHooks({
    ...params,
    skipProviderRuntimeHooks: true,
  });
  const staticPolicy = mergeImageCompressionPolicies({
    runtimePolicy: resolveBundledStaticCompressionModelPolicy(params),
    staticPolicy: configuredStaticPolicy,
  });
  if (
    imageCompressionPolicyHasDimensionLimit(staticPolicy) ||
    !providerUsesRuntimeModelAugment({
      cfg: params.cfg,
      provider: params.provider,
      workspaceDir: params.workspaceDir,
    })
  ) {
    return staticPolicy;
  }
  const runtimePolicy = await resolveCompressionModelPolicyWithHooks({
    ...params,
    skipProviderRuntimeHooks: false,
  });
  return mergeImageCompressionPolicies({ runtimePolicy, staticPolicy });
}

function configuredMaxSidePolicy(
  cfg: OpenClawConfig | undefined,
): ImageCompressionModelPolicy | null {
  const configured = cfg?.agents?.defaults?.imageMaxDimensionPx;
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) {
    return null;
  }
  return { maxSidePx: Math.floor(configured) };
}

export async function resolveModelAwareImageCompressionPolicy(params: {
  cfg?: OpenClawConfig;
  modelCandidates: readonly ImageCompressionModelCandidate[];
  imageCount?: number;
  agentDir?: string;
  workspaceDir?: string;
  includeConfiguredMaxSide?: boolean;
  includeImageCountWithoutPolicy?: boolean;
  preserveEmptyModelPolicies?: boolean;
  deps?: Partial<ImageCompressionPolicyDeps>;
}): Promise<ImageCompressionPolicy | undefined> {
  const deps: ImageCompressionPolicyDeps = {
    resolveBundledStaticCatalogModel:
      params.deps?.resolveBundledStaticCatalogModel ??
      defaultImageCompressionPolicyDeps.resolveBundledStaticCatalogModel,
    resolveModelAsync:
      params.deps?.resolveModelAsync ?? defaultImageCompressionPolicyDeps.resolveModelAsync,
  };
  const resolvedModels = await Promise.all(
    params.modelCandidates.map(async (candidate) =>
      resolveCompressionModelPolicy({
        cfg: params.cfg,
        deps,
        provider: candidate.provider,
        model: candidate.model,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      }),
    ),
  );
  const modelPolicies = params.preserveEmptyModelPolicies
    ? resolvedModels
    : resolvedModels.filter(imageCompressionModelPolicyHasAnyLimit);
  const configuredPolicy = params.includeConfiguredMaxSide
    ? configuredMaxSidePolicy(params.cfg)
    : null;
  const models = configuredPolicy ? [configuredPolicy, ...modelPolicies] : modelPolicies;
  const quality = params.cfg?.agents?.defaults?.imageQuality;
  const imageCount =
    typeof params.imageCount === "number" && Number.isFinite(params.imageCount)
      ? Math.max(1, Math.floor(params.imageCount))
      : undefined;
  const includeImageCount =
    imageCount !== undefined &&
    (params.includeImageCountWithoutPolicy !== false || Boolean(quality) || models.length > 0);
  if (!quality && models.length === 0 && !includeImageCount) {
    return undefined;
  }
  return {
    ...(quality ? { quality } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(includeImageCount ? { imageCount } : {}),
  };
}
