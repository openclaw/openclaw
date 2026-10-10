import type {
  SessionContext as CoreSessionContext,
  SessionTreeEntry,
} from "../../../packages/agent-core/src/harness/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface NewSessionOptions {
  id?: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  /** This row consumes the raw side cursor instead of the visible leaf. */
  appendMode?: "side";
}

type CoreSessionEntry<Type extends SessionTreeEntry["type"]> = Extract<
  SessionTreeEntry,
  { type: Type }
>;

export interface SessionMessageEntry extends CoreSessionEntry<"message"> {}

export interface ThinkingLevelChangeEntry extends CoreSessionEntry<"thinking_level_change"> {}

export interface ModelChangeEntry extends CoreSessionEntry<"model_change"> {}

export interface CompactionEntry<T = unknown> extends Omit<
  CoreSessionEntry<"compaction">,
  "details"
> {
  __openclaw?: { runId?: string; itemId?: string };
  /** Context estimate after compaction, retained with its ordinary transcript marker. */
  tokensAfter?: number;
  /** Extension-specific data, such as artifact indexes or version markers. */
  details?: T;
}

export type ResetReason = CoreSessionEntry<"reset">["reason"];

export interface ResetEntry extends CoreSessionEntry<"reset"> {}

export interface BranchSummaryEntry<T = unknown> extends Omit<
  CoreSessionEntry<"branch_summary">,
  "details"
> {
  /** Extension-specific data that is not sent to the model. */
  details?: T;
}

/** Extension state that is persisted but excluded from model context. */
export interface CustomEntry<T = unknown> extends Omit<CoreSessionEntry<"custom">, "data"> {
  data?: T;
}

export interface LabelEntry extends CoreSessionEntry<"label"> {}

export interface SessionInfoEntry extends CoreSessionEntry<"session_info"> {}

/** Extension message that participates in model context. */
export interface CustomMessageEntry<T = unknown> extends Omit<
  CoreSessionEntry<"custom_message">,
  "details"
> {
  details?: T;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | ResetEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export type AppendPersistenceOptions = {
  appendIntent?: "active-branch";
  /** Synchronous fresh SQLite message assertion; never serialized into an entry. */
  beforeFreshMessageCommit?: () => void;
  config?: OpenClawConfig;
  idempotencyLookup?: "scan" | "scan-assistant" | "caller-checked";
  invalidateSerializedPrefixCache?: boolean;
};

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

export interface SessionContext extends CoreSessionContext {}

export type PreservedOpaqueFileEntry = {
  index: number;
  record: unknown;
};

export type SessionLeafControl = Extract<SessionTreeEntry, { type: "leaf" }>;
