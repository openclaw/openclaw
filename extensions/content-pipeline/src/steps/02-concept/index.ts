/**
 * Step 2 — Concept selection.
 *
 * Takes the candidate pool from Step 1 and picks one concept to anchor the
 * video, scored on necessity / attractiveness / novelty / depth.
 *
 * The pure logic (prompt + parse + weighted total) lives in `./scoring.ts`
 * so it can be unit tested without an LLM. This file is the thin wrapper
 * that calls `generateTextWithFallback()` and assembles the final
 * SelectedConcept artifact.
 */
import { generateTextWithFallback } from "../../content/llm.js";
import type {
  Article,
  PipelineConfig,
  ScoredArticle,
  ScoreWeights,
  SelectedConcept,
} from "../../types.js";
import { buildPrompt, computeWeightedTotal, parseScoringResponse } from "./scoring.js";

export interface SelectConceptOpts {
  /** Override score weights (defaults to contentConfig.scoreWeights) */
  weights?: ScoreWeights;
}

/**
 * Score the candidate pool with one batched LLM call and return the picked
 * concept + every candidate's score.
 *
 * Uses the same `generateTextWithFallback()` chain as the script generator
 * so we share rate-limit and key-rotation behavior.
 */
export async function selectConcept(
  articles: Article[],
  contentConfig: PipelineConfig["content"],
  opts: SelectConceptOpts = {},
): Promise<SelectedConcept> {
  if (articles.length === 0) {
    throw new Error("selectConcept: empty article pool — nothing to score");
  }

  const models = [contentConfig.model, ...(contentConfig.fallbackModels ?? [])];
  console.log(`🎯 Stage 1.5: Scoring ${articles.length} candidates (${models.length} models)...`);

  const { system, prompt } = buildPrompt(articles);
  const raw = await generateTextWithFallback(models, { system, prompt });
  const parsed = parseScoringResponse(raw, articles);

  const weights = opts.weights ?? contentConfig.scoreWeights;

  // Build scored list and sort by weighted total
  const scored: ScoredArticle[] = articles.map((article, i) => {
    const rawScore = parsed.rawScores[i];
    const total = computeWeightedTotal(rawScore, weights);
    return {
      article,
      score: { ...rawScore, total },
      reasoning: parsed.reasonings[i],
    };
  });

  scored.sort((a, b) => {
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    if (b.article.score !== a.article.score) return b.article.score - a.article.score;
    return b.article.published.getTime() - a.article.published.getTime();
  });

  // Pick seed: trust LLM's pickedIndex if valid, otherwise highest weighted total
  const llmPickedIdx = parsed.concept.pickedIndex;
  const llmPickValid =
    Number.isInteger(llmPickedIdx) && llmPickedIdx >= 0 && llmPickedIdx < articles.length;
  const seedArticle = llmPickValid ? articles[llmPickedIdx] : scored[0].article;

  const concept: SelectedConcept = {
    title: parsed.concept.title || seedArticle.title,
    theme: parsed.concept.theme || seedArticle.summary.slice(0, 200),
    keywords: parsed.concept.keywords,
    seedArticle,
    scored,
  };

  console.log(
    `  ✓ Picked: "${concept.title}" — top score ${scored[0].score.total} (${scored[0].article.source})`,
  );
  return concept;
}
