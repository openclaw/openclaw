import type { ContextEngine } from "../../../context-engine/types.js";
import type { AssistantMessage } from "../../../llm/types.js";
import type { BootstrapMode } from "../../bootstrap-mode.js";
import type { AgentMessage } from "../../runtime/index.js";
import { normalizeUsage, type NormalizedUsage } from "../../usage.js";
import type { PromptCacheChange } from "../prompt-cache-observability.js";
import type { EmbeddedRunAttemptResult } from "./types.js";
export {
  assembleHarnessContextEngine as assembleAttemptContextEngine,
  bootstrapHarnessContextEngine as runAttemptContextEngineBootstrap,
  finalizeHarnessContextEngineTurn as finalizeAttemptContextEngineTurn,
} from "../../harness/context-engine-lifecycle.js";

/** Context-engine instance used by the embedded attempt runner. */
export type AttemptContextEngine = ContextEngine;

/** Bootstrap/context files resolved for one attempt before prompt assembly. */
export type AttemptBootstrapContext<TBootstrapFile = unknown, TContextFile = unknown> = {
  bootstrapFiles: TBootstrapFile[];
  contextFiles: TContextFile[];
};

/**
 * Resolves bootstrap/context files and records whether this attempt should mark
 * the bootstrap turn complete. The skip and record decisions intentionally
 * share inputs so lightweight or continuation turns cannot poison future runs.
 */
export async function resolveAttemptBootstrapContext<TBootstrapFile, TContextFile>(params: {
  contextInjectionMode: "always" | "continuation-skip" | "never";
  bootstrapContextMode?: string;
  bootstrapContextRunKind?: string;
  bootstrapMode?: BootstrapMode;
  sessionFile: string;
  hasCompletedBootstrapTurn: (sessionFile: string) => Promise<boolean>;
  resolveBootstrapContextForRun: () => Promise<
    AttemptBootstrapContext<TBootstrapFile, TContextFile>
  >;
}): Promise<
  AttemptBootstrapContext<TBootstrapFile, TContextFile> & {
    isContinuationTurn: boolean;
    shouldRecordCompletedBootstrapTurn: boolean;
  }
> {
  const isContinuationTurn =
    params.bootstrapMode !== "full" &&
    params.contextInjectionMode === "continuation-skip" &&
    params.bootstrapContextRunKind !== "heartbeat" &&
    (await params.hasCompletedBootstrapTurn(params.sessionFile));
  const shouldSkipBootstrapInjection =
    params.contextInjectionMode === "never" || isContinuationTurn;
  // Lightweight/heartbeat/full-mode checks mirror persistence rules so a
  // skipped or partial bootstrap turn is not recorded as completed.
  const shouldRecordCompletedBootstrapTurn =
    !shouldSkipBootstrapInjection &&
    params.bootstrapContextMode !== "lightweight" &&
    params.bootstrapContextRunKind !== "heartbeat" &&
    params.bootstrapMode === "full";

  const context = shouldSkipBootstrapInjection
    ? { bootstrapFiles: [], contextFiles: [] }
    : await params.resolveBootstrapContextForRun();

  return {
    ...context,
    isContinuationTurn,
    shouldRecordCompletedBootstrapTurn,
  };
}

/**
 * Builds compact prompt-cache metadata for attempt results and after-turn hooks.
 * Empty inputs return undefined so callers do not persist placeholder cache
 * objects in session metadata.
 */
export function buildContextEnginePromptCacheInfo(params: {
  retention?: "none" | "short" | "long";
  lastCallUsage?: NormalizedUsage;
  observation?:
    | {
        broke: boolean;
        previousCacheRead?: number;
        cacheRead?: number;
        changes?: PromptCacheChange[] | null;
      }
    | undefined;
  lastCacheTouchAt?: number | null;
}): EmbeddedRunAttemptResult["promptCache"] {
  const promptCache: NonNullable<EmbeddedRunAttemptResult["promptCache"]> = {};
  if (params.retention) {
    promptCache.retention = params.retention;
  }
  if (params.lastCallUsage) {
    promptCache.lastCallUsage = { ...params.lastCallUsage };
  }
  if (params.observation) {
    promptCache.observation = {
      broke: params.observation.broke,
      ...(typeof params.observation.previousCacheRead === "number"
        ? { previousCacheRead: params.observation.previousCacheRead }
        : {}),
      ...(typeof params.observation.cacheRead === "number"
        ? { cacheRead: params.observation.cacheRead }
        : {}),
      ...(params.observation.changes && params.observation.changes.length > 0
        ? {
            changes: params.observation.changes.map((change) => ({
              code: change.code,
              detail: change.detail,
            })),
          }
        : {}),
    };
  }
  if (typeof params.lastCacheTouchAt === "number" && Number.isFinite(params.lastCacheTouchAt)) {
    promptCache.lastCacheTouchAt = params.lastCacheTouchAt;
  }
  return Object.keys(promptCache).length > 0 ? promptCache : undefined;
}

/** Finds the newest assistant message produced after the current attempt's prompt boundary. */
export function findCurrentAttemptAssistantMessage(params: {
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
}): AssistantMessage | undefined {
  return params.messagesSnapshot
    .slice(Math.max(0, params.prePromptMessageCount))
    .toReversed()
    .find((message): message is AssistantMessage => message.role === "assistant");
}

function parsePromptCacheTouchTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/** Resolve the effective prompt-cache touch timestamp for the current assistant turn. */
export function resolvePromptCacheTouchTimestamp(params: {
  lastCallUsage?: NormalizedUsage;
  assistantTimestamp?: unknown;
  fallbackLastCacheTouchAt?: number | null;
}): number | null {
  const hasCacheUsage =
    typeof params.lastCallUsage?.cacheRead === "number" ||
    typeof params.lastCallUsage?.cacheWrite === "number";
  if (!hasCacheUsage) {
    return params.fallbackLastCacheTouchAt ?? null;
  }
  // Only cache read/write usage means the assistant timestamp touched prompt
  // cache state. Plain token usage carries the previous touch forward.
  return (
    parsePromptCacheTouchTimestamp(params.assistantTimestamp) ??
    params.fallbackLastCacheTouchAt ??
    null
  );
}

/** Builds prompt-cache metadata from the assistant produced in this loop. */
export function buildLoopPromptCacheInfo(params: {
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
  retention?: "none" | "short" | "long";
  fallbackLastCacheTouchAt?: number | null;
}): EmbeddedRunAttemptResult["promptCache"] {
  const currentAttemptAssistant = findCurrentAttemptAssistantMessage({
    messagesSnapshot: params.messagesSnapshot,
    prePromptMessageCount: params.prePromptMessageCount,
  });
  const lastCallUsage = normalizeUsage(currentAttemptAssistant?.usage);

  return buildContextEnginePromptCacheInfo({
    retention: params.retention,
    lastCallUsage,
    lastCacheTouchAt: resolvePromptCacheTouchTimestamp({
      lastCallUsage,
      assistantTimestamp: currentAttemptAssistant?.timestamp,
      fallbackLastCacheTouchAt: params.fallbackLastCacheTouchAt,
    }),
  });
}
