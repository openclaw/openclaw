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

export interface PipelineConfig {
  sources: SourceConfig[];
  content: {
    model: string;
    topStories: number;
    language: string;
    tone: string;
  };
  slides: {
    width: number;
    height: number;
    theme: Record<string, string>;
    fonts: Record<string, string>;
  };
  video: {
    durationPerSlide: number;
    ttsVoice: string;
    width: number;
    height: number;
    fps: number;
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
