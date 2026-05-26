import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/hooks/llm-slug-generator.d.ts
/**
 * Generate a short 1-2 word filename slug from session content using LLM
 */
declare function generateSlugViaLLM(params: {
  sessionContent: string;
  cfg: OpenClawConfig;
}): Promise<string | null>;
//#endregion
export { generateSlugViaLLM };