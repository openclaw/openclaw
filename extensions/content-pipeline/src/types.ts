// ── Shared types for the content pipeline ──

export interface Article {
  title: string;
  url: string;
  source: string;
  summary: string;
  score: number;
  published: Date;
}

export interface SlideContent {
  slideType: "intro" | "story" | "outro" | "title" | "step" | "code";
  title: string;
  body: string;
  speakerNotes: string;
  sourceUrl?: string;
  code?: string;
  language?: string;
}

export interface VideoContent {
  videoTitle: string;
  videoDescription: string;
  tags: string[];
  slides: SlideContent[];
}

export interface AudioSegment {
  audioPath: string;
  srtPath: string;
  durationSeconds: number;
}

export interface VideoResult {
  landscapePath: string;
  portraitPath: string;
  durationSeconds: number;
  subtitlePath: string;
}

export interface UploadResult {
  platform: string;
  url?: string;
  status: "success" | "error" | "skipped";
  error?: string;
}

export interface PipelineRun {
  id: string;
  pipelineType: "news" | "tutorial";
  status: "idle" | "running" | "done" | "error";
  currentStage: string;
  startedAt: Date;
  finishedAt?: Date;
  outputDir: string;
  error?: string;
}

export type StageEvent = {
  runId: string;
  stage: string;
  status: "started" | "completed" | "error";
  message: string;
  timestamp: Date;
};

export interface SourceConfig {
  name: string;
  type: "rss" | "scrape";
  url: string;
  maxItems: number;
}

// ── Step 2: Concept selection ──

export interface ConceptScore {
  /** How important the story is for the audience to know (1-10) */
  necessity: number;
  /** Hook / clickability / viral potential (1-10) */
  attractiveness: number;
  /** Fresh angle vs. recycled (1-10) */
  novelty: number;
  /** Enough material to sustain a 2-3 min single-concept video (1-10) */
  depth: number;
  /** Weighted sum (computed locally, not from LLM) */
  total: number;
}

export interface ScoredArticle {
  article: Article;
  score: ConceptScore;
  /** Optional LLM rationale, kept for debug + Discord display */
  reasoning?: string;
}

export interface SelectedConcept {
  /** Canonical concept title (LLM-normalized) */
  title: string;
  /** 1-sentence concept summary */
  theme: string;
  /** 5-10 lowercase keywords for related-source matching downstream */
  keywords: string[];
  /** The highest-scoring article — drives related-source discovery */
  seedArticle: Article;
  /** All candidates with their scores, sorted desc by total */
  scored: ScoredArticle[];
}

export interface ScoreWeights {
  necessity?: number;
  attractiveness?: number;
  novelty?: number;
  depth?: number;
}

// ── Step 3: Related sources ──

export interface FullArticle extends Article {
  /** Extracted body text, capped at content.maxFullTextChars (default 3000) */
  fullText: string;
  /** Whether the HTTP fetch + extraction succeeded */
  fetchOk: boolean;
  /** Number of concept.keywords matched in title + summary (debug + ranking) */
  keywordMatches: number;
  /** Optional fetch error message for debugging */
  fetchError?: string;
}

/**
 * Video engine selector (Step 6).
 *
 * - "remotion": React-based slide rendering (default, always works, free)
 * - "pexels":   Pexels stock B-roll + TTS overlay (free, no GPU, real footage)
 * - "ltx":      LTX-Video local AI generation via diffusers MPS (free, slow on Mac)
 * - "hybrid":   Remotion intro/outro + Pexels for story slides
 *
 * Legacy values "wan2gp" / "cloud" remain for backward compat but are deprecated:
 * - "wan2gp" is upstream-broken on MPS (https://github.com/Wan-Video/Wan2.1/issues/175)
 * - "cloud"  was a paid path; use "ltx" or "pexels" instead (user is free-only)
 */
export type VideoEngine = "remotion" | "pexels" | "ltx" | "hybrid" | "wan2gp" | "cloud";

export interface Wan2gpConfig {
  /** [Deprecated] Path to Wan2GP installation. Replaced by LTX-Video — kept for type compat. */
  path: string;
  /** Model size — historically Wan, now used as a label for the LTX-Video clip target */
  model: "1.3B" | "14B";
  /** Output resolution */
  resolution: "480p" | "720p";
  /** Seconds per generated clip */
  clipDuration: number;
  /** Max parallel clip generations */
  concurrency: number;
}

export interface PexelsConfig {
  /** Env var name holding the Pexels API key (default PEXELS_API_KEY) */
  apiKeyEnv?: string;
  /** Search size hint */
  size?: "small" | "medium" | "large";
  /** Per-search results to inspect */
  perPage?: number;
}

export interface SubtitlesConfig {
  /** Whisper engine to use. Currently "whisper.cpp" only. */
  engine?: "whisper.cpp";
  /** Path to the GGML model file */
  modelPath?: string;
  /** whisper-cli binary name (defaults to "whisper-cli" via brew) */
  bin?: string;
}

export interface CloudVideoConfig {
  /** [Deprecated] Cloud provider for video generation — paid, not currently used */
  provider: "fal" | "google" | "replicate";
  /** Model identifier */
  model: string;
  /** API key env var name (reads from process.env) */
  apiKeyEnv?: string;
}

export interface PipelineConfig {
  sources: SourceConfig[];
  content: {
    model: string;
    fallbackModels?: string[];
    topStories: number;
    language: string;
    tone: string;
    /** Candidate pool size after dedup + per-source cap (Step 1, default 30) */
    poolSize?: number;
    /** Max articles per source in the candidate pool (Step 1, default 3) */
    maxPerSource?: number;
    /** Score weights for concept selection (Step 2, default 1:1:1:1) */
    scoreWeights?: ScoreWeights;
    /** Number of related sources to fetch per concept (Step 3, default 5) */
    relatedSources?: number;
    /** Max chars per fetched article body (Step 3, default 3000) */
    maxFullTextChars?: number;
    /** Script mode (Step 4): "single-concept" uses the deep-dive path (default), "multi-story" uses the legacy Top-N recap */
    mode?: "single-concept" | "multi-story";
  };
  keyManager?: {
    google?: {
      serviceAccountPath: string;
      projectIds: string[];
      maxKeysPerProject?: number;
    };
    openrouter?: {
      managementKey: string;
      keyPrefix?: string;
    };
  };
  slides: {
    width: number;
    height: number;
    theme: Record<string, string>;
    fonts: Record<string, string>;
  };
  video: {
    /** Video engine: "remotion" (slides) | "pexels" (B-roll) | "ltx" (local AI) | "hybrid" */
    engine: VideoEngine;
    durationPerSlide: number;
    width: number;
    height: number;
    fps: number;
    /** Pexels B-roll engine config (Step 6) */
    pexels?: PexelsConfig;
    /** Subtitle / word-timestamp engine config (Step 6) — defaults to whisper.cpp */
    subtitles?: SubtitlesConfig;
    /** LTX-Video local AI generation config (Step 6) — uses Wan2gpConfig shape for back-compat */
    ltx?: Wan2gpConfig;
    /** [Deprecated] Wan2GP local AI video generation config */
    wan2gp?: Wan2gpConfig;
    /** [Deprecated] Cloud video generation config (paid fallback) */
    cloud?: CloudVideoConfig;
    /** Whether to use LLM to optimize prompts for video generation */
    optimizePrompts?: boolean;
    /** TTS engine config (Step 5) — split per engine so voice names don't collide */
    tts?: {
      engine?: "kokoro" | "edge-tts";
      kokoro?: {
        voice?: string; // e.g. "af_heart"
        speed?: number; // default 1.0
      };
      edgeTts?: {
        voice?: string; // e.g. "en-US-AndrewNeural"
      };
      /** Sentence-level chunking — default true. If false, whole speaker notes go in one TTS call. */
      chunkBySentence?: boolean;
    };
    /** Legacy flat fields kept as fallbacks — read only when `tts` is not set */
    ttsEngine?: "kokoro" | "edge-tts";
    ttsVoice?: string;
    ttsSpeed?: number;
  };
  upload: {
    youtube: { enabled: boolean; privacy: string; categoryId: string; tags: string[] };
    tiktok: { enabled: boolean; cookiesPath: string };
    facebook: { enabled: boolean; pageId: string };
  };
  bot: {
    enabled: boolean;
    port: number;
    allowedUserIds: string[];
  };
}
