import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/vercel-ai-gateway/onboard.d.ts
declare const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/anthropic/claude-opus-4.6";
declare function applyVercelAiGatewayConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyVercelAiGatewayConfig as n, VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF as t };