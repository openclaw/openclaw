import type { OpenClawConfig } from "../config/config.js";
export declare const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3-pro-preview";
export declare function applyGoogleGeminiModelDefault(cfg: OpenClawConfig): {
    next: OpenClawConfig;
    changed: boolean;
};
