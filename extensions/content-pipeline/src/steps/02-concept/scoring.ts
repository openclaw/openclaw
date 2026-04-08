/**
 * Pure scoring helpers for Step 2 (concept selection).
 *
 * No LLM calls or IO live here — that's in `./index.ts`. Keeping the math
 * and parsing pure makes them trivial to unit test.
 */
import type { Article, ConceptScore, ScoreWeights } from "../../types.js";

/** What the LLM returns per-article (no `total` — we compute that locally). */
export type RawScore = Omit<ConceptScore, "total">;

export interface ParsedConcept {
  title: string;
  theme: string;
  keywords: string[];
  /** LLM's pick — may be out of range; caller falls back to highest total */
  pickedIndex: number;
}

export interface ParsedScoringResponse {
  rawScores: RawScore[];
  reasonings: Array<string | undefined>;
  concept: ParsedConcept;
}

/** Clamp a score into [1, 10]. Non-numeric input collapses to 1. */
function clampScore(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(10, Math.round(n)));
}

/**
 * Compute the weighted total. Each weight defaults to 1, so the unweighted
 * max total is 40 (4 dims × 10).
 */
export function computeWeightedTotal(raw: RawScore, weights?: ScoreWeights): number {
  const w = {
    necessity: weights?.necessity ?? 1,
    attractiveness: weights?.attractiveness ?? 1,
    novelty: weights?.novelty ?? 1,
    depth: weights?.depth ?? 1,
  };
  return (
    raw.necessity * w.necessity +
    raw.attractiveness * w.attractiveness +
    raw.novelty * w.novelty +
    raw.depth * w.depth
  );
}

/**
 * Build the LLM prompt that grades all candidates in one batch call.
 * The system prompt locks the JSON shape so the parser can rely on it.
 */
export function buildPrompt(articles: Article[]): { system: string; prompt: string } {
  const system = `You are a tech-news editor scoring articles for a daily YouTube video.

For each candidate article, give 4 scores (1-10 each):
- necessity:     how important the audience NEEDS to know this story (1=trivia, 10=must-know)
- attractiveness: how clickable / viral the headline feels (1=dry, 10=irresistible hook)
- novelty:       how fresh / not-recycled the angle is (1=repeated, 10=brand new)
- depth:         how much material exists for a 2-3 min single-concept video (1=one-liner, 10=rich)

Then pick the SINGLE best concept to build a video around — the one with the strongest overall combination. Extract a normalized concept title, a one-sentence theme, and 5-10 SHORT, SINGLE-WORD lowercase keywords for finding related sources (specific concrete nouns, NOT phrases — e.g. "hackers" not "iran linked hackers", "datacenter" not "data centers in space").

Respond with STRICT JSON only, no markdown fences, no extra text, in this EXACT compact shape (one line per candidate, no reasoning text):

{
  "candidates": [
    { "i": 0, "n": 8, "a": 7, "v": 6, "d": 9 }
  ],
  "concept": {
    "pickedIndex": 0,
    "title": "Short canonical concept title",
    "theme": "One-sentence summary of the concept",
    "keywords": ["lowercase", "keyword", "list"]
  }
}

Use the short field names (i, n, a, v, d) — index, necessity, attractiveness, novelty, depth.`;

  const list = articles
    .map(
      (a, i) =>
        `${i}. [${a.source}] ${a.title}
   ${(a.summary ?? "").slice(0, 280).replace(/\s+/g, " ").trim()}`,
    )
    .join("\n\n");

  const prompt = `Score these ${articles.length} candidate articles and pick the single best concept:

${list}

Return STRICT JSON with one entry per article (indices 0..${articles.length - 1}) plus a concept block. No prose, no markdown.`;

  return { system, prompt };
}

/**
 * Parse the LLM JSON response into typed scored articles + concept metadata.
 *
 * Defensive: clamps scores into [1,10], lowercases + dedupes keywords, and
 * never throws on out-of-range pickedIndex (the caller falls back to
 * highest weighted total in that case).
 */
export function parseScoringResponse(raw: string, articles: Article[]): ParsedScoringResponse {
  // Find the first { ... } block — works even if the model emits a prefix.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Concept scoring response had no JSON object: ${raw.slice(0, 200)}`);
  }
  const json = raw.slice(start, end + 1);

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Concept scoring response was not valid JSON: ${(err as Error).message}\n${json.slice(0, 300)}`,
    );
  }

  const obj = (data ?? {}) as {
    candidates?: Array<Record<string, unknown>>;
    concept?: {
      pickedIndex?: unknown;
      title?: unknown;
      theme?: unknown;
      keywords?: unknown;
    };
  };

  // Index → raw score map; missing entries get a neutral 5/5/5/5 fallback.
  // Accepts both compact field names (i/n/a/v/d) used by the prompt and the
  // long field names (index/necessity/attractiveness/novelty/depth) for back-compat.
  const byIndex = new Map<number, { score: RawScore; reasoning?: string }>();
  for (const c of obj.candidates ?? []) {
    const idxRaw = c.i ?? c.index;
    const idx = typeof idxRaw === "number" ? idxRaw : Number(idxRaw);
    if (!Number.isInteger(idx) || idx < 0 || idx >= articles.length) continue;
    byIndex.set(idx, {
      score: {
        necessity: clampScore(c.n ?? c.necessity),
        attractiveness: clampScore(c.a ?? c.attractiveness),
        novelty: clampScore(c.v ?? c.novelty),
        depth: clampScore(c.d ?? c.depth),
      },
      reasoning: typeof c.reasoning === "string" ? c.reasoning : undefined,
    });
  }

  const rawScores: RawScore[] = [];
  const reasonings: Array<string | undefined> = [];
  for (let i = 0; i < articles.length; i++) {
    const found = byIndex.get(i);
    if (found) {
      rawScores.push(found.score);
      reasonings.push(found.reasoning);
    } else {
      // Neutral fallback so the article still flows through
      rawScores.push({ necessity: 5, attractiveness: 5, novelty: 5, depth: 5 });
      reasonings.push(undefined);
    }
  }

  // Concept block — every field defensive
  const conceptIn = obj.concept ?? {};
  const pickedIndexRaw =
    typeof conceptIn.pickedIndex === "number"
      ? conceptIn.pickedIndex
      : Number(conceptIn.pickedIndex);
  const pickedIndex = Number.isInteger(pickedIndexRaw) ? pickedIndexRaw : -1;

  const title = typeof conceptIn.title === "string" ? conceptIn.title.trim() : "";
  const theme = typeof conceptIn.theme === "string" ? conceptIn.theme.trim() : "";

  const rawKeywords = Array.isArray(conceptIn.keywords) ? conceptIn.keywords : [];
  const seenKw = new Set<string>();
  const keywords: string[] = [];
  for (const k of rawKeywords) {
    if (typeof k !== "string") continue;
    const norm = k.trim().toLowerCase();
    if (!norm) continue;
    if (seenKw.has(norm)) continue;
    seenKw.add(norm);
    keywords.push(norm);
  }

  return {
    rawScores,
    reasonings,
    concept: { title, theme, keywords, pickedIndex },
  };
}
