import type { AssistantMessage, ImageContent, TextContent } from "@openclaw/llm-core";
import type { AgentMessage } from "../types.js";

export { err, ok } from "@openclaw/normalization-core/result";
export type { Result } from "@openclaw/normalization-core/result";

type CompactionErrorCode = "aborted" | "summarization_failed" | "invalid_session" | "unknown";

export class CompactionError extends Error {
  public code: CompactionErrorCode;

  constructor(code: CompactionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CompactionError";
    this.code = code;
  }
}

/** Internal typed signal for a completed summary response with no usable text. */
export class InvalidSummaryOutputError extends CompactionError {
  constructor(message: string) {
    super("summarization_failed", message);
  }
}

/** The provider failed the summary request; hosts classify the failed response, not this text. */
export class SummaryProviderError extends CompactionError {
  constructor(
    message: string,
    readonly response: AssistantMessage,
  ) {
    super("summarization_failed", message);
    this.name = "SummaryProviderError";
  }
}

/** Recognizes the error by name: duplicated module copies break `instanceof`. */
export function isSummaryProviderError(error: unknown): error is SummaryProviderError {
  return error instanceof Error && error.name === "SummaryProviderError" && "response" in error;
}

/** A length stop with no visible summary is deterministic for an unchanged request. */
export class SummaryOutputBudgetError extends CompactionError {
  constructor(message: string) {
    super("summarization_failed", message);
  }
}

type BranchSummaryErrorCode = "aborted" | "summarization_failed" | "invalid_session";

export class BranchSummaryError extends Error {
  public code: BranchSummaryErrorCode;

  constructor(code: BranchSummaryErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BranchSummaryError";
    this.code = code;
  }
}

interface SessionTreeEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
  appendMode?: "side";
}

export type SessionTreeEntry = SessionTreeEntryBase &
  (
    | { type: "message"; message: AgentMessage }
    | { type: "thinking_level_change"; thinkingLevel: string }
    | { type: "model_change"; provider: string; modelId: string }
    | {
        type: "compaction";
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        details?: unknown;
        fromHook?: boolean;
      }
    | {
        type: "reset";
        reason: "new" | "reset" | "idle" | "daily" | "cron-stale";
        firstKeptEntryId?: string;
      }
    | {
        type: "branch_summary";
        fromId: string;
        summary: string;
        details?: unknown;
        fromHook?: boolean;
      }
    | { type: "custom"; customType: string; data?: unknown }
    | {
        type: "custom_message";
        customType: string;
        content: string | (TextContent | ImageContent)[];
        details?: unknown;
        display: boolean;
      }
    | { type: "label"; targetId: string; label: string | undefined }
    | { type: "session_info"; name?: string }
    | { type: "leaf"; targetId: string | null; appendParentId?: string | null }
  );

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface BranchSummaryResult {
  summary: string;
  readFiles: string[];
  modifiedFiles: string[];
}
