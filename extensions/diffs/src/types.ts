import type { FileContents, FileDiffMetadata, SupportedLanguages } from "@pierre/diffs";

export const DIFF_LAYOUTS = ["unified", "split"] as const;
export const DIFF_MODES = ["view", "image", "both"] as const;
export const DIFF_THEMES = ["light", "dark"] as const;
export const DIFF_INDICATORS = ["bars", "classic", "none"] as const;

export type DiffLayout = (typeof DIFF_LAYOUTS)[number];
export type DiffMode = (typeof DIFF_MODES)[number];
export type DiffTheme = (typeof DIFF_THEMES)[number];
export type DiffIndicators = (typeof DIFF_INDICATORS)[number];

export type DiffPresentationDefaults = {
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
  layout: DiffLayout;
  showLineNumbers: boolean;
  diffIndicators: DiffIndicators;
  wordWrap: boolean;
  background: boolean;
  theme: DiffTheme;
};

export type DiffToolDefaults = DiffPresentationDefaults & {
  mode: DiffMode;
};

export type BeforeAfterDiffInput = {
  kind: "before_after";
  before: string;
  after: string;
  path?: string;
  lang?: string;
  title?: string;
};

export type PatchDiffInput = {
  kind: "patch";
  patch: string;
  title?: string;
};

export type DiffInput = BeforeAfterDiffInput | PatchDiffInput;

export type DiffRenderOptions = {
  presentation: DiffPresentationDefaults;
  expandUnchanged: boolean;
};

export type DiffViewerOptions = {
  theme: {
    light: "pierre-light";
    dark: "pierre-dark";
  };
  diffStyle: DiffLayout;
  diffIndicators: DiffIndicators;
  disableLineNumbers: boolean;
  expandUnchanged: boolean;
  themeType: DiffTheme;
  backgroundEnabled: boolean;
  overflow: "scroll" | "wrap";
  unsafeCSS: string;
};

export type DiffViewerPayload = {
  prerenderedHTML: string;
  options: DiffViewerOptions;
  langs: SupportedLanguages[];
  oldFile?: FileContents;
  newFile?: FileContents;
  fileDiff?: FileDiffMetadata;
};

export type RenderedDiffDocument = {
  html: string;
  imageHtml: string;
  title: string;
  fileCount: number;
  inputKind: DiffInput["kind"];
};

export type DiffArtifactMeta = {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  title: string;
  inputKind: DiffInput["kind"];
  fileCount: number;
  viewerPath: string;
  htmlPath: string;
  imagePath?: string;
};

export const DIFF_ARTIFACT_ID_PATTERN = /^[0-9a-f]{20}$/;
export const DIFF_ARTIFACT_TOKEN_PATTERN = /^[0-9a-f]{48}$/;
