import type { EnvironmentSpec, ContextBadge } from "../environment/types";

export type Brand = "cutmv" | "fulldigital";

export type HeadlineLine = {
  text: string;
  color: "white" | "green";
  underline?: boolean;
};

export type CaptionSegment = {
  from: number;
  to: number;
  text: string;
  emphasis?: string[];
};

export type CaptionConfig = {
  enabled: boolean;
  style: "hormozi_box" | "scribble_callout" | "clean_lower";
  segments: CaptionSegment[];
};

export type UIBlockSpec = {
  component: "ConfigureOutputCard" | "OutputCardStack";
  props: Record<string, unknown>;
};

// ── Legacy transition (kept for backward compat) ──
export type TransitionSpec = {
  type: "wipe" | "sweep" | "glitch" | "dipFade" | "crossfade";
  duration: number; // frames
};

// ── Easing names ──
export type EasingName =
  | "linear"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeInOutQuint"
  | "easeOutBack"
  | "easeInBack";

// ── Enhanced transition (full-screen matte) ──
export type TransitionDirection =
  | "leftToRight"
  | "rightToLeft"
  | "topToBottom"
  | "bottomToTop"
  | "diagUp"
  | "diagDown";

export type EnhancedTransitionSpec = {
  preset?: string;
  type: "wipe" | "sweep" | "glitch" | "dipFade" | "crossfade";
  coverage: "full";
  direction?: TransitionDirection;
  duration: number;
  overscanPx?: number;
  featherPx?: number;
  easing?: EasingName;
  addGlowEdge?: boolean;
  edgeGlowOpacity?: number;
  addShadow?: boolean;
  shadowOpacity?: number;
  // Glitch (legacy — remapped to dipFade at render)
  glitchSlices?: number;
  sliceJitterPx?: number;
  rgbSplit?: number;
  noiseOpacity?: number;
  // DipFade / Crossfade params
  dipColor?: string;
  out?: { opacityTo?: number; blurToPx?: number; scaleTo?: number };
  mid?: { holdFrames?: number; dipOpacity?: number };
  in?: { opacityFrom?: number; blurFromPx?: number; scaleFrom?: number };
  antiBanding?: { grainOpacity?: number; dither?: boolean };
};

// ── Element motion ──
export type ElementMotionStep = {
  preset?: string;
  type?: string;
  distancePx?: number;
  durationFrames?: number;
  easing?: EasingName;
  at: number;
  blur?: number;
  shadowPop?: boolean;
  scaleFrom?: number;
};

export type ElementMotion = {
  enter: ElementMotionStep;
  exit?: ElementMotionStep;
};

export type ElementKind =
  | "headline"
  | "subhead"
  | "uiCard"
  | "cta"
  | "accentUnderline"
  | "badge"
  | "icon"
  | "support"
  | "logo"
  | "listItem"
  | "gridItem"
  | "caption";

// ── Props timeline (UI micro-interactions) ──
export type PropsTimelineToggleState = {
  label: string;
  on: boolean;
};

export type PropsTimelineTap = {
  x: number; // px from left edge of uiCard
  y: number; // px from top edge of uiCard
};

export type PropsTimelineProps = {
  toggles?: PropsTimelineToggleState[];
  activeAspect?: number;
  pressed?: boolean;
  progress?: number;
  status?: "idle" | "processing" | "generating" | "done";
  tap?: PropsTimelineTap;
  tapTarget?: string; // semantic target e.g. "toggle.clips", "button.start", "aspect.9:16"
  checkmarks?: string[];
  highlightToggleIndex?: number;
};

export type PropsTimelineEntry = {
  at: number; // frame offset (relative to scene start)
  props: PropsTimelineProps; // sparse — only changed props
};

export type ElementDef = {
  id: string;
  kind: ElementKind;
  text?: string;
  emphasis?: boolean;
  uiPreset?: string;
  uiOptions?: Record<string, unknown>;
  slot?: string;
  templateId?: string;
  asset?: string;
  motion: ElementMotion;
  propsTimeline?: PropsTimelineEntry[];
};

// ── Background layers ──
export type BackgroundLayerType =
  | "softGradient"
  | "grain"
  | "vignette"
  | "greenBloom";

export type BackgroundLayer = {
  type: BackgroundLayerType;
  opacity: number;
  animate?: "slowDrift" | "pulse" | "subtle";
  pulse?: "subtle";
};

// ── Preset maps (top-level in spec) ──
export type TransitionPresetMap = Record<string, Omit<EnhancedTransitionSpec, "duration">>;
export type ElementMotionPresetMap = Record<string, Omit<ElementMotionStep, "at">>;

// ── Scene base fields ──
type SceneBase = {
  id: string;
  from: number;
  duration: number;
  transitionOut?: TransitionSpec;
  transitionIn?: EnhancedTransitionSpec;
  enhancedTransitionOut?: EnhancedTransitionSpec;
  elements?: ElementDef[];
  environment?: EnvironmentSpec;
  contextBadge?: ContextBadge;
  brandOverlay?: BrandOverlayConfig;
};

// ── Hook / Impact text ──
export type HookTextScene = SceneBase & {
  type: "hookText" | "impactText";
  headlineLines: HeadlineLine[];
  subhead?: string;
};

// ── UI block (original engine format) ──
export type UIBlockScene = SceneBase & {
  type: "uiBlock";
  ui: UIBlockSpec;
};

// ── UI mock (preset-based from rich specs) ──
export type UIMockScene = SceneBase & {
  type: "uiMock";
  uiPreset: string;
  uiOptions: Record<string, unknown>;
  layout?: {
    anchor?: string;
    headlineTop?: { text: string; underline?: boolean };
    reserveTopPx?: number;
    reserveBottomPx?: number;
  };
};

// ── UI mock montage (cross-fade between two UI presets) ──
export type UIMockMontageScene = SceneBase & {
  type: "uiMockMontage";
  uiPreset: string;
  uiOptions: {
    modules: { preset: string; weight: number }[];
    [key: string]: unknown;
  };
  layout?: {
    anchor?: string;
    headlineTop?: { text: string; underline?: boolean };
    reserveTopPx?: number;
    reserveBottomPx?: number;
  };
};

// ── Feature list (vertical bullet list) ──
export type FeatureListScene = SceneBase & {
  type: "featureList";
  title: { text: string; emphasis: boolean };
  title2?: { text: string; emphasis: boolean };
  items: string[];
  layout?: { anchor?: string; itemUnderline?: boolean; maxWidthPx?: number };
  motion?: { preset?: string; staggerFrames?: number };
};

// ── Feature grid (2-column grid with icons) ──
export type FeatureGridScene = SceneBase & {
  type: "featureGrid";
  title: { text: string; emphasis: boolean };
  items: { label: string; icon: string }[];
  layout?: { anchor?: string; columns?: number; maxWidthPx?: number };
  motion?: { preset?: string; staggerFrames?: number };
};

// ── Step scene (numbered step with supporting text) ──
export type StepSceneSpec = SceneBase & {
  type: "stepScene";
  step: { label: string; text: string };
  support?: string;
};

// ── CTA endcard (logo + headline + button + footer) ──
export type CtaEndcardScene = SceneBase & {
  type: "ctaEndcard";
  logo?: { usePrimaryLogo?: boolean; sizePx?: number };
  headline: { text: string; emphasis: boolean };
  headline2?: { text: string; emphasis: boolean };
  subhead?: string;
  cta: { text: string; style: string };
  footer?: string;
};

// ── CTA end (original engine format) ──
export type CtaEndScene = SceneBase & {
  type: "ctaEnd";
  cta: {
    primary: string;
    secondary: string;
    button: string;
    logoMinWidthPct: number;
  };
};

// ── Blank scene (empty — used for logoOnly outro window) ──
export type BlankScene = SceneBase & {
  type: "blank";
};

export type SceneSpec =
  | HookTextScene
  | UIBlockScene
  | UIMockScene
  | UIMockMontageScene
  | FeatureListScene
  | FeatureGridScene
  | StepSceneSpec
  | CtaEndcardScene
  | CtaEndScene
  | BlankScene;

export type DemoCadence = {
  frameCount: number;
  beats: number[];
};

export type CursorConfig = {
  enabled: boolean;
  style?: "arrow_white" | "classic_arrow";
  alwaysVisible?: boolean;
  idleBehavior?: "subtleDrift" | "activeHover" | "hide";
  scale?: number;
  shadow?: number;
  profile?: "FAST_CLICKY" | "GENTLE" | "default";
};

export type BrandLockupConfig = {
  topLogoMode?: "proceduralTiles" | "svgStatic";
  topLogoScale?: number;
  topLogoY?: number;
};

// ── Brand overlay per-scene config ──
export type BrandOverlayHeroConfig = {
  enabled: boolean;
  yOffset?: number;
  placement?: "aboveHeadline" | "topSafe" | "center";
  scale?: number;
};

export type BrandOverlayBugConfig = {
  enabled: boolean;
  corner?: "tl" | "tr" | "bl" | "br";
  opacity?: number;
  scale?: number;
};

export type BrandOverlayEndcardConfig = {
  enabled: boolean;
  style?: "lockupA" | "lockupB" | "logoOnly";
};

export type BrandOverlayConfig = {
  hero?: BrandOverlayHeroConfig;
  bug?: BrandOverlayBugConfig;
  endcard?: BrandOverlayEndcardConfig;
};

// ── Hero mark asset identifier ──
export type HeroMarkId = "fd_logo_2025_white" | "fd_logo_new" | "procedural";

// ── Brand system spec-level config ──
export type BrandSystemConfig = {
  bug?: {
    enabled: boolean;
    corner?: "tl" | "tr" | "bl" | "br";
    opacity?: number;
    scale?: number;
  };
  hero?: {
    enabled: boolean;
    heroMark?: HeroMarkId;
    openFrames?: number;
    closeFrames?: number;
    placement?: "aboveHeadline" | "topSafe" | "center";
    yOffset?: number;
    xOffset?: number;
    scale?: number;
    size?: number;
  };
  endcard?: {
    enabled: boolean;
    style?: "lockupA" | "lockupB" | "logoOnly";
    showLastFrames?: number; // show lockup in last N frames (default 60)
    bottomOffset?: number;   // px from bottom edge (default 72)
    heroMark?: HeroMarkId;   // logo mark for logoOnly mode (default fd_logo_new)
    size?: number;           // logo size for logoOnly mode (default 140)
  };
};

export type MotionSpec = {
  brand: Brand;
  compositionId: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  seed: number;
  assets: {
    primaryLogo: string;
    demoFrameDir?: string;
  };
  style: {
    bg: string;
    grain: number;
    vignette: boolean;
    green: string;
    black: string;
    card: string;
  };
  scenes: SceneSpec[];
  captions?: CaptionConfig;
  demoCadence?: DemoCadence;
  cursor?: CursorConfig;
  brandLockup?: BrandLockupConfig;
  brandSystem?: BrandSystemConfig;
  backgroundLayers?: BackgroundLayer[];
  transitionPresets?: TransitionPresetMap;
  elementMotionPresets?: ElementMotionPresetMap;
};
