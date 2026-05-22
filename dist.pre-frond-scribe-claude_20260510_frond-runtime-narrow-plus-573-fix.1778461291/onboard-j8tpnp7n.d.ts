import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
//#region extensions/google/onboard.d.ts
declare const GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-2.5-flash";
declare function applyGoogleGeminiModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
};
//#endregion
export { applyGoogleGeminiModelDefault as n, GOOGLE_GEMINI_DEFAULT_MODEL as t };