import { createDefaultModelsPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import {
  buildQianfanProvider,
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

export const QIANFAN_DEFAULT_MODEL_REF = `qianfan/${QIANFAN_DEFAULT_MODEL_ID}`;

export const { applyConfig: applyQianfanConfig } = createDefaultModelsPresetAppliers<[]>({
  primaryModelRef: QIANFAN_DEFAULT_MODEL_REF,
  resolveParams: (cfg) => {
    const existingProvider = cfg.models?.providers?.qianfan;
    const existingBaseUrl =
      typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
    return {
      providerId: "qianfan",
      api: typeof existingProvider?.api === "string" ? existingProvider.api : "openai-completions",
      baseUrl: existingBaseUrl || QIANFAN_BASE_URL,
      defaultModels: cfg.models?.mode === "replace" ? buildQianfanProvider().models : [],
      defaultModelId: QIANFAN_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: QIANFAN_DEFAULT_MODEL_REF, alias: "QIANFAN" }],
    };
  },
});
