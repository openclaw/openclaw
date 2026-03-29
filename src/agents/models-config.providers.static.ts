import type { OpenClawConfig } from "../config/config.js";
export {
  ANTHROPIC_VERTEX_DEFAULT_MODEL_ID,
  buildAnthropicVertexProvider,
} from "../../extensions/anthropic-vertex/provider-catalog.js";
export {
  buildBytePlusCodingProvider,
  buildBytePlusProvider,
} from "../../extensions/byteplus/provider-catalog.js";
export { buildKimiCodingProvider } from "../../extensions/kimi-coding/provider-catalog.js";
export { buildKilocodeProvider } from "../../extensions/kilocode/provider-catalog.js";
export {
  buildMinimaxPortalProvider,
  buildMinimaxProvider,
} from "../../extensions/minimax/provider-catalog.js";
export {
  MODELSTUDIO_BASE_URL,
  MODELSTUDIO_DEFAULT_MODEL_ID,
  buildModelStudioProvider,
} from "../../extensions/modelstudio/provider-catalog.js";
export { buildMoonshotProvider } from "../../extensions/moonshot/provider-catalog.js";
export { buildNvidiaProvider } from "../../extensions/nvidia/provider-catalog.js";
export { buildOpenAICodexProvider } from "../../extensions/openai/openai-codex-catalog.js";
export { buildOpenrouterProvider } from "../../extensions/openrouter/provider-catalog.js";
export {
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
  buildQianfanProvider,
} from "../../extensions/qianfan/provider-catalog.js";
export { buildQwenPortalProvider } from "../../extensions/qwen-portal-auth/provider-catalog.js";
export { buildSyntheticProvider } from "../../extensions/synthetic/provider-catalog.js";
export { buildTogetherProvider } from "../../extensions/together/provider-catalog.js";
export {
  buildDoubaoCodingProvider,
  buildDoubaoProvider,
} from "../../extensions/volcengine/provider-catalog.js";
export {
  XIAOMI_DEFAULT_MODEL_ID,
  buildXiaomiProvider,
} from "../../extensions/xiaomi/provider-catalog.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

export const OWL_BASE_URL =
  "https://inference-web-api.mycloud.com/custom_modelo-owl-ultra-think/v1";
export const OWL_DEFAULT_MODEL_ID = "custom_model2-37b-instruct";
export const OWL_DEFAULT_CONTEXT_WINDOW = 120000;
export const OWL_DEFAULT_MAX_TOKENS = 4096;
export const OWL_DEFAULT_COST = {
  input: 0.1,
  output: 0.1,
  cacheRead: 0.05,
  cacheWrite: 0.05,
};

export function buildOwlProvider(): ProviderConfig {
  return {
    baseUrl: OWL_BASE_URL,
    api: "openai-completions",
    auth: "basic",
    models: [
      {
        id: OWL_DEFAULT_MODEL_ID,
        name: "Custom Owl Instruct",
        reasoning: true,
        input: ["text"],
        cost: OWL_DEFAULT_COST,
        contextWindow: OWL_DEFAULT_CONTEXT_WINDOW,
        maxTokens: OWL_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}
