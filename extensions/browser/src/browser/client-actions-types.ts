import type { BrowserDownloadResult } from "./download-types.js";
import type { AnnotationItem } from "./screenshot-annotate.js";

export type BrowserActionOk = { ok: true };

/** Per-action result returned by a browser batch. */
export type BrowserBatchActionResult = {
  ok: boolean;
  error?: string;
  navigated?: true;
  url?: string;
};

/** Summary returned when a batch cannot safely continue on its original page. */
export type BrowserBatchAbort = {
  reason: "navigation" | "closed";
  afterAction: number;
  url: string;
  skipped: number;
};

export type BrowserActionTabResult = {
  ok: true;
  targetId: string;
  url?: string;
  download?: BrowserDownloadResult;
};

export type BrowserActionPathResult = {
  ok: true;
  path: string;
  targetId: string;
  url?: string;
  labels?: boolean;
  labelsCount?: number;
  labelsSkipped?: number;
  truncated?: boolean;
  /**
   * Per-ref bounding boxes when labels=true. Coordinates are in the
   * captured image's space (viewport / fullpage / element-relative).
   * Omitted when empty.
   */
  annotations?: AnnotationItem[];
};
