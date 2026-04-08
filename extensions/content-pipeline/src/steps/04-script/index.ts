/**
 * Step 4 — Single-concept deep-dive script.
 *
 * Consumes the concept (Step 2) and related sources (Step 3) and produces a
 * 7-slide deep-dive VideoContent anchored on the picked concept.
 *
 * Pure prompt + parser live in `./prompts.ts`, unit-tested without the LLM.
 * This file is the thin wrapper that calls `generateTextWithFallback`.
 */
import { generateTextWithFallback } from "../../content/llm.js";
import type { FullArticle, PipelineConfig, SelectedConcept, VideoContent } from "../../types.js";
import { buildConceptPrompt, parseConceptScript } from "./prompts.js";

/**
 * Generate a 7-slide single-concept deep-dive script.
 *
 * Filters out sources with failed fetches / empty bodies. If all sources are
 * unusable, falls back to the seed article's summary so the pipeline still
 * produces something — Stage 2's legacy fallback in `pipeline.ts` handles the
 * case where this function itself throws.
 */
export async function generateConceptScript(
  concept: SelectedConcept,
  sources: FullArticle[],
  contentConfig: PipelineConfig["content"],
): Promise<VideoContent> {
  const usable = sources.filter((s) => s.fetchOk && s.fullText.length > 0);
  const models = [contentConfig.model, ...(contentConfig.fallbackModels ?? [])];

  console.log(
    `✍️  Stage 2 (Step 4): Writing deep-dive script from ${usable.length} source(s) (${models.length} models)...`,
  );

  const { system, prompt } = buildConceptPrompt(concept, sources, contentConfig);
  const raw = await generateTextWithFallback(models, { system, prompt });
  const video = parseConceptScript(raw);

  console.log(`  ✓ Deep-dive script: "${video.videoTitle}" (${video.slides.length} slides)`);
  return video;
}
