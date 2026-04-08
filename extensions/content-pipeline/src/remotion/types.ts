export interface SlideData {
  slideType: "intro" | "story" | "outro" | "title" | "step" | "code";
  title: string;
  body: string | string[];
  speakerNotes: string;
  sourceUrl?: string;
  code?: string;
  language?: string;
  durationFrames: number;
}

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface VideoProps {
  slides: SlideData[];
  audioPath: string;
  words: WordTimestamp[];
  /**
   * Per-slide background MP4 paths (relative to Remotion's public/ dir).
   * When provided for a slide, NewsVideo renders the clip as a full-bleed
   * background with only a glassmorphic title chip on top + word captions
   * at the bottom — used by the Pexels B-roll engine.
   */
  brollPaths?: string[];
  musicPath?: string;
  musicVolume?: number;
  fps?: number;
}
