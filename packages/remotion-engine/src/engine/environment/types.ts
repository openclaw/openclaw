/**
 * Environment layer types — procedural background contexts
 * that render behind product UI to create "real workflow" feel.
 *
 * Supported: premiere_timeline, abstract_blob_noise, upload_workspace,
 * social_feed, studio_backdrop, none.
 */

// ── Premiere Timeline ──

export type PremierePresetName =
  | "music_video_dense"
  | "music_video_clean"
  | "tutorial_talkinghead"
  | "ugc_fastcuts"
  | "cinematic_sparse";

export type PremiereTimelineEnvSpec = {
  type: "premiere_timeline";
  preset?: PremierePresetName;
  seed?: number;
  layout?: {
    position?: "full" | "behindProduct";
    safeInsetPx?: number;
  };
  camera?: {
    mode?: "static" | "slowPan" | "slowPanVertical" | "breathingZoom";
    parallax?: boolean;
    driftPx?: { x: number; y: number };
    zoom?: { from: number; to: number };
  };
  timeline?: {
    tracks?: { video: number; audio: number };
    rowHeightPx?: number;
    gapPx?: number;
    rulerHeightPx?: number;
    sidebarWidthPx?: number;
    paddingPx?: number;
    theme?: "dark_pro" | "dark_min" | "dark_green";
    blur?: number;     // 0..1 → mapped to px
    vignette?: number; // 0..1
    grain?: number;    // 0..1
  };
  scroll?: {
    mode?: "follow_playhead" | "auto_scroll" | "none";
    speedPxPerFrame?: number;
    loop?: boolean;
  };
  playhead?: {
    enabled?: boolean;
    xMode?: "fixed_center" | "drifting";
    color?: string;
    glow?: string;
    widthPx?: number;
    headSizePx?: number;
  };
  content?: {
    durationSeconds?: number;
    cutsDensity?: "low" | "med" | "high";
    clipStyle?: "square" | "rounded";
    labels?: boolean;
    waveforms?: {
      enabled?: boolean;
      style?: "bars" | "line";
      opacity?: number;
    };
    markers?: {
      enabled?: boolean;
      everyBeats?: number;
      color?: string;
    };
  };
  post?: {
    blur?: number;
    vignette?: number;
    grain?: number;
  };
};

// ── Abstract Blob Noise ──

export type AbstractBlobNoiseEnvSpec = {
  type: "abstract_blob_noise";
  gradient?: [string, string];
  noise?: boolean;
  blobs?: number;
  greenAccent?: boolean;
  movement?: "slowDrift" | "pulse" | "breathe" | "static";
  blur?: number;
  vignette?: number;
};

// ── Upload Workspace ──

export type UploadWorkspaceEnvSpec = {
  type: "upload_workspace";
  blur?: number;
  vignette?: number;
  motion?: "static" | "slowPan";
};

// ── Social Feed ──

export type SocialFeedEnvSpec = {
  type: "social_feed";
  platform?: "tiktok" | "reels" | "shorts";
  blur?: number;
  vignette?: number;
  motion?: "static" | "slowScroll";
};

// ── Studio Backdrop ──

export type StudioBackdropEnvSpec = {
  type: "studio_backdrop";
  lightSweep?: boolean;
  blur?: number;
  vignette?: number;
};

// ── None ──

export type NoneEnvSpec = {
  type: "none";
};

// ── Union ──

export type EnvironmentSpec =
  | PremiereTimelineEnvSpec
  | AbstractBlobNoiseEnvSpec
  | UploadWorkspaceEnvSpec
  | SocialFeedEnvSpec
  | StudioBackdropEnvSpec
  | NoneEnvSpec;

// ── Context badge ──

export type ContextBadge = string; // e.g. "LIVE DEMO", "IN EDITOR", "EXPORT READY"
