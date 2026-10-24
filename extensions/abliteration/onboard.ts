import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { ABLITERATION_DEFAULT_MODEL_REF, buildAbliterationProvider } from "./models.js";

const abliterationProvider = buildAbliterationProvider();

const abliterationPreset = {
  primaryModelRef: ABLITERATION_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "abliteration",
    api: "openai-completions",
    baseUrl: abliterationProvider.baseUrl,
    catalogModels: () => abliterationProvider.models,
    aliases: [{ modelRef: ABLITERATION_DEFAULT_MODEL_REF, alias: "Abliterated Large Flash" }],
  }),
} satisfies Parameters<typeof createProviderConnectionPresetAppliers<[]>>[0];

export const { applyConfig: applyAbliterationConnectionConfig } =
  createProviderConnectionPresetAppliers(abliterationPreset);
