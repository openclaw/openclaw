/**
 * Shared built-in session tool input/detail contracts.
 *
 * Keeps tool factories, renderers, and callers aligned on typed payload and metadata shapes.
 */
import type { Static } from "typebox";
import type {
  bashSchema,
  editSchema,
  EditToolOutputSchema,
  findSchema,
  grepSchema,
  lsSchema,
  ReadToolContinuationSchema,
  readToolInputSchema,
  readToolOutputSchema,
  readTruncationOutputSchema,
  writeSchema,
  WriteToolOutputSchema,
} from "./tool-schemas.js";
import type { TruncationResult } from "./truncate.js";

export { ReadToolContinuationSchema } from "./tool-schemas.js";

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export function formatFullOutputFooter(path: string): string {
  return `Full output: ${path}`;
}

export type EditToolInput = Static<typeof editSchema>;
export type EditToolDetails = Static<typeof EditToolOutputSchema>;
export type FindToolInput = Static<typeof findSchema>;

// Keep one text payload; duplicate truncation content can exceed Code Mode value bounds.
export interface FindToolDetails {
  content: string;
  truncation?: Omit<TruncationResult, "content">;
  resultLimitReached?: number;
}

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
  content: string;
  truncation?: Omit<TruncationResult, "content">;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}

export type LsToolInput = Static<typeof lsSchema>;

export interface LsToolDetails {
  content: string;
  nextAfter?: string;
}

export type ReadToolInput = Static<typeof readToolInputSchema>;
export type ReadToolTruncationDetails = Static<typeof readTruncationOutputSchema>;

export type ReadToolContinuation = Static<typeof ReadToolContinuationSchema>;

export type ReadToolDetails = Static<typeof readToolOutputSchema>;
export type WriteToolInput = Static<typeof writeSchema>;
export type WriteToolDetails = Static<typeof WriteToolOutputSchema>;
