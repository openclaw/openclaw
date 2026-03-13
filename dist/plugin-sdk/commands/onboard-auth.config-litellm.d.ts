import type { OpenClawConfig } from "../config/config.js";
export declare const LITELLM_BASE_URL = "http://localhost:4000";
export declare const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
export declare function applyLitellmProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyLitellmConfig(cfg: OpenClawConfig): OpenClawConfig;
