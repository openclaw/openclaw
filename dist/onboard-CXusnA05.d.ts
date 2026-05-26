import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/google/onboard.d.ts
declare const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
declare function applyGoogleGeminiModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
};
//#endregion
export { applyGoogleGeminiModelDefault as n, GOOGLE_GEMINI_DEFAULT_MODEL as t };