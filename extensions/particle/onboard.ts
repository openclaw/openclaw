import {
  buildManifestModelProviderConfig,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const defaultModelRef = readManifestProviderDefaultModelRef(manifest, "particle")!;

export const { applyConfig: applyParticleConfig } = createProviderConnectionPresetAppliers<[]>({
  primaryModelRef: defaultModelRef,
  resolveParams: () => {
    const provider = buildManifestModelProviderConfig({
      providerId: "particle",
      catalog: manifest.modelCatalog.providers.particle,
    });
    return {
      providerId: "particle",
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      catalogModels: () => provider.models,
      aliases: [{ modelRef: defaultModelRef, alias: "Particle-1" }],
    };
  },
});
