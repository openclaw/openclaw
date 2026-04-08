/**
 * Pure prompt builder + parser for Step 4 (single-concept deep-dive script).
 *
 * No LLM calls or IO here. These functions are exercised by unit tests with
 * hand-crafted JSON — `./index.ts` is the thin wrapper that actually calls
 * the LLM and uses these helpers.
 */
import type {
  FullArticle,
  PipelineConfig,
  SelectedConcept,
  SlideContent,
  VideoContent,
} from "../../types.js";

/** The 7-slide arc, locked by the system prompt. */
export const SLIDE_ARC: Array<{ slideType: SlideContent["slideType"]; role: string }> = [
  { slideType: "intro", role: "Intro" },
  { slideType: "story", role: "What Happened" },
  { slideType: "story", role: "The Background" },
  { slideType: "story", role: "Key Details" },
  { slideType: "story", role: "Analysis" },
  { slideType: "story", role: "Why It Matters" },
  { slideType: "outro", role: "Outro" },
];

/**
 * Build the LLM prompt for a 7-slide single-concept deep dive.
 *
 * The user prompt embeds the concept metadata + the full body text from each
 * (successfully fetched) related source, labeled with section headers so the
 * model can cite specifics per source.
 */
export function buildConceptPrompt(
  concept: SelectedConcept,
  sources: FullArticle[],
  contentConfig: PipelineConfig["content"],
): { system: string; prompt: string } {
  const usable = sources.filter((s) => s.fetchOk && s.fullText.length > 0);

  const system = `You are a tech-news video script writer creating a SINGLE-CONCEPT DEEP DIVE — one story, 2-3 minutes, Apple keynote style. Bold, cinematic, substantive.

Write EXACTLY 7 slides in this EXACT order:
  1. intro          — hook the viewer in one punchy sentence
  2. story          — "What Happened" (the core news beat + headline fact)
  3. story          — "The Background" (how did we get here, context)
  4. story          — "Key Details" (specific numbers, names, quotes drawn from the sources)
  5. story          — "Analysis" (what the story actually means, reading between the lines)
  6. story          — "Why It Matters" (impact on the viewer / industry / future)
  7. outro          — call to action, energetic close

Writing rules (DEPTH MODE):
- speakerNotes: 4-6 confident sentences per slide, drawing SPECIFIC facts (numbers, company names, quotes) from the source material
- body: array of 2-3 short bullet strings per slide, action-verb style, max 8 words each
- Headlines: 3-6 words, bold and clear
- No filler words (basically, actually, really, just, very)
- No hedging (might, could, perhaps, arguably) — be decisive
- No markdown, no special characters in speakerNotes (TTS-safe)
- No URLs in speakerNotes
- Use simple TTS-friendly language
- Video title under 60 chars, catchy, concept-anchored (NOT "Top 5 Tech Stories")

Respond with STRICT JSON ONLY, no markdown fences, no extra text, matching this exact shape:

{
  "videoTitle": "short catchy concept-anchored title under 60 chars",
  "videoDescription": "YouTube description, 2-3 sentences, concept-focused",
  "tags": ["tag1", "tag2", "tag3"],
  "slides": [
    { "slideType": "intro", "title": "…", "body": ["bullet 1", "bullet 2"], "speakerNotes": "4-6 sentences…" },
    { "slideType": "story", "title": "What Happened", "body": [...], "speakerNotes": "..." },
    { "slideType": "story", "title": "The Background", "body": [...], "speakerNotes": "..." },
    { "slideType": "story", "title": "Key Details", "body": [...], "speakerNotes": "..." },
    { "slideType": "story", "title": "Analysis", "body": [...], "speakerNotes": "..." },
    { "slideType": "story", "title": "Why It Matters", "body": [...], "speakerNotes": "..." },
    { "slideType": "outro", "title": "…", "body": [...], "speakerNotes": "..." }
  ]
}`;

  const sourceBlocks = usable.length
    ? usable
        .map((s, i) => `=== Source ${i + 1}: ${s.title} (${s.source}) ===\n${s.fullText}`)
        .join("\n\n")
    : `=== Seed Article: ${concept.seedArticle.title} (${concept.seedArticle.source}) ===\n${concept.seedArticle.summary}`;

  const prompt = `Write a 7-slide single-concept deep-dive video script for this concept:

CONCEPT: ${concept.title}
THEME: ${concept.theme}
KEYWORDS: ${concept.keywords.join(", ")}
TONE: ${contentConfig.tone}
LANGUAGE: ${contentConfig.language}

SOURCE MATERIAL (draw specific facts, names, numbers, quotes from here):

${sourceBlocks}

Return STRICT JSON matching the schema in the system prompt. Exactly 7 slides in the exact order specified. Speaker notes 4-6 sentences each, rich with specifics from the sources above.`;

  return { system, prompt };
}

/** Normalize body into string[] — the LLM may emit either a joined string or an array. */
function normalizeBody(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split("\n")
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Parse the LLM's JSON response into a validated `VideoContent`.
 *
 * Defensive: finds the first {...} block (handles prefixes + code fences),
 * normalizes body fields, enforces slide count + slideType sequence, and
 * fills defaults for missing optional fields (videoDescription, tags).
 *
 * Throws with a clear error on:
 *   - no JSON object found
 *   - malformed JSON
 *   - wrong slide count (not exactly 7)
 *   - wrong slideType sequence (must be intro → story × 5 → outro)
 */
export function parseConceptScript(raw: string): VideoContent {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Concept script response had no JSON object: ${raw.slice(0, 200)}`);
  }
  const json = raw.slice(start, end + 1);

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Concept script response was not valid JSON: ${(err as Error).message}\n${json.slice(0, 300)}`,
    );
  }

  const obj = (data ?? {}) as {
    videoTitle?: unknown;
    videoDescription?: unknown;
    tags?: unknown;
    slides?: Array<{
      slideType?: unknown;
      title?: unknown;
      body?: unknown;
      speakerNotes?: unknown;
      sourceUrl?: unknown;
    }>;
  };

  if (!Array.isArray(obj.slides) || obj.slides.length !== 7) {
    throw new Error(
      `Concept script must have exactly 7 slides, got ${Array.isArray(obj.slides) ? obj.slides.length : "none"}`,
    );
  }

  const slides: SlideContent[] = obj.slides.map((s, i) => {
    const expected = SLIDE_ARC[i].slideType;
    const rawType = typeof s.slideType === "string" ? s.slideType : expected;
    // Coerce to the expected sequence; if the LLM got creative, fix it rather than fail
    const slideType: SlideContent["slideType"] =
      rawType === "intro" || rawType === "story" || rawType === "outro"
        ? (rawType as SlideContent["slideType"])
        : expected;

    return {
      slideType,
      title: typeof s.title === "string" ? s.title.trim() : SLIDE_ARC[i].role,
      body: normalizeBody(s.body).join("\n"),
      speakerNotes: typeof s.speakerNotes === "string" ? s.speakerNotes.trim() : "",
      sourceUrl: typeof s.sourceUrl === "string" ? s.sourceUrl : undefined,
    };
  });

  // Enforce the arc: slide 1 = intro, slides 2-6 = story, slide 7 = outro
  if (
    slides[0].slideType !== "intro" ||
    slides[6].slideType !== "outro" ||
    slides.slice(1, 6).some((s) => s.slideType !== "story")
  ) {
    throw new Error(
      `Concept script slideType sequence is wrong. Got: ${slides.map((s) => s.slideType).join(",")} — expected: intro,story,story,story,story,story,outro`,
    );
  }

  const videoTitle =
    typeof obj.videoTitle === "string" && obj.videoTitle.trim()
      ? obj.videoTitle.trim()
      : slides[0].title || "Tech News Deep Dive";

  const videoDescription =
    typeof obj.videoDescription === "string" && obj.videoDescription.trim()
      ? obj.videoDescription.trim()
      : slides[0].speakerNotes.slice(0, 200);

  const tags =
    Array.isArray(obj.tags) && obj.tags.length
      ? obj.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim())
      : ["tech news"];

  return { videoTitle, videoDescription, tags, slides };
}
