import { createAliasOnlyPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";

export const OPENROUTER_DEFAULT_MODEL_REF = "openrouter/auto";
export const {
  applyProviderConfig: applyOpenrouterProviderConfig,
  applyConfig: applyOpenrouterConfig,
} = createAliasOnlyPresetAppliers({
  modelRef: OPENROUTER_DEFAULT_MODEL_REF,
  alias: "OpenRouter",
});
