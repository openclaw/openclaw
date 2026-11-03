import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createProviderModelCatalogIdNormalizer } from "../plugins/provider-model-routes.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";

/** Native Completions video is an authored provider capability, outside canonical Model.input. */
export function configuredModelSupportsNativeVideo(params: {
  cfg?: OpenClawConfig;
  provider: string;
  modelId: string;
  api?: string;
}): boolean {
  const providerConfig = resolveMergedModelProviderConfig(params.cfg, params.provider);
  const model = findConfiguredProviderModel(
    providerConfig,
    params.provider,
    splitTrailingAuthProfile(params.modelId).model,
    createProviderModelCatalogIdNormalizer(params.provider),
  );
  return (
    (params.api ?? model?.api ?? providerConfig?.api) === "openai-completions" &&
    (model?.input.includes("video") ?? false)
  );
}
