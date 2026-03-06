import type { OpenClawConfig } from "../config/config.js";
export declare const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.3-codex";
export declare function applyOpenAICodexModelDefault(cfg: OpenClawConfig): {
    next: OpenClawConfig;
    changed: boolean;
};
