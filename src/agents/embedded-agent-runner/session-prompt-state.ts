/** Transcript-backed prompt projection state cached by an embedded session lifecycle. */
import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { Message } from "../../llm/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { getOpenClawSystemUpdateKind } from "../internal-runtime-context.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import {
  prepareCacheTtlCheckpoint,
  serializeCacheTtlToolResultProjections,
  type CacheTtlCheckpoint,
  type CacheTtlProjectionInput,
} from "./cache-ttl-checkpoint.js";
import { extractAttemptPermissionNotice } from "./run/attempt-system-prompt.js";
import { buildSystemUpdateMessage } from "./run/runtime-context-prompt.js";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export type ToolResultPromptProjectionState = CacheTtlProjectionInput & {
  /** Null means an uncertain append requires a checkpoint, including for empty state. */
  cacheTtlCheckpoint?: CacheTtlCheckpoint | null;
  /** Every baseline publication, including an empty-branch restore, invalidates pending writes. */
  cacheTtlRevision?: number;
};

type EmbeddedSessionPromptState = {
  activeAttempts: number;
  toolResults: ToolResultPromptProjectionState;
  systemPrompt?: SystemPromptSeries;
  pendingSystemPrompt?: SystemPromptSeries;
  systemPromptRouteKey?: string;
  prunedImageMessages?: Set<string>;
  removedRuntimeContextKeys?: Set<string>;
  runtimeContextCarrierPositions?: number[];
};

type SystemPromptSeries = {
  prefix: string;
  hash: string;
  renderedPrefix: string;
  routeKey: string;
  historyId: string | null;
  permissionNotice?: string;
  restart: boolean;
};

/** Unsent preparation belongs to its attempt; an incapable route rebuilds the full prompt. */
export function beginSessionSystemPrompt(params: {
  state: EmbeddedSessionPromptState;
  routeKey: string;
  enabled: boolean;
  entries: SessionEntry[];
}): boolean {
  params.state.pendingSystemPrompt = undefined;
  if (params.enabled) {
    return false;
  }
  params.state.systemPrompt = undefined;
  params.state.systemPromptRouteKey = params.routeKey;
  const previous = params.entries.findLast(
    (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
  );
  return (
    previous?.type === "custom" &&
    isRecord(previous.data) &&
    previous.data.routeKey !== params.routeKey
  );
}

function promptSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const section of text.split(/(?=^## )/m)) {
    const lineEnd = section.indexOf("\n");
    const heading = section.startsWith("## ")
      ? section.slice(0, lineEnd < 0 ? section.length : lineEnd)
      : "";
    sections.set(heading, (sections.get(heading) ?? "") + section);
  }
  return sections;
}

function promptDelta(previous: string, current: string): string[] {
  const before = promptSections(previous);
  const sections: string[] = [];
  for (const [heading, section] of promptSections(current)) {
    if (before.get(heading) !== section) {
      sections.push(section);
    }
    before.delete(heading);
  }
  for (const heading of before.keys()) {
    sections.push(`${heading}\n(removed)`);
  }
  return sections;
}

/** Restore the admitted series; refreshed instructions append after its conversation prefix. */
export function prepareSessionSystemPrompt(params: {
  state: EmbeddedSessionPromptState;
  routeKey: string;
  systemPrompt: string;
  entries: SessionEntry[];
}) {
  const { permissionNotice, systemPrompt: renderedPrefix } = extractAttemptPermissionNotice(
    params.systemPrompt,
  );
  const historyId =
    params.entries.findLast((entry) => entry.type === "compaction" || entry.type === "reset")?.id ??
    null;
  const markerIndex = params.entries.findLastIndex(
    (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
  );
  const afterCheckpoint = params.entries.slice(markerIndex + 1);
  const orphanedUpdate =
    !params.state.pendingSystemPrompt &&
    afterCheckpoint.some((entry) => getOpenClawSystemUpdateKind(entry) === "prompt-update");
  if (orphanedUpdate) {
    // A canceled append may precede its checkpoint; retire that override before any new request.
    params.state.systemPrompt = undefined;
  }
  let series = params.state.pendingSystemPrompt ?? params.state.systemPrompt;
  if (
    !series &&
    !orphanedUpdate &&
    (!params.state.systemPromptRouteKey || params.state.systemPromptRouteKey === params.routeKey)
  ) {
    const entry = params.entries[markerIndex];
    const data = entry?.type === "custom" ? entry.data : undefined;
    if (
      isRecord(data) &&
      typeof data.prefix === "string" &&
      data.hash === sha256Hex(data.prefix) &&
      typeof data.renderedPrefix === "string" &&
      data.routeKey === params.routeKey &&
      data.historyId === historyId &&
      !afterCheckpoint.some((later) => later.type === "model_change")
    ) {
      series = {
        prefix: data.prefix,
        hash: data.hash,
        renderedPrefix: data.renderedPrefix,
        routeKey: params.routeKey,
        historyId,
        permissionNotice:
          typeof data.permissionNotice === "string" ? data.permissionNotice : undefined,
        restart: false,
      };
      params.state.systemPrompt = series;
    }
  }
  const restart = !series || series.routeKey !== params.routeKey || series.historyId !== historyId;
  const sections =
    !restart && series && series.renderedPrefix !== renderedPrefix
      ? promptDelta(
          stripSystemPromptCacheBoundary(series.renderedPrefix),
          stripSystemPromptCacheBoundary(renderedPrefix),
        )
      : [];
  if (permissionNotice && (restart || permissionNotice !== series?.permissionNotice)) {
    sections.push(permissionNotice);
  }
  const next: SystemPromptSeries = restart
    ? {
        prefix: renderedPrefix,
        hash: sha256Hex(renderedPrefix),
        renderedPrefix,
        routeKey: params.routeKey,
        historyId,
        permissionNotice,
        restart: true,
      }
    : { ...series!, renderedPrefix, permissionNotice, restart: false };
  let committed = false;
  return {
    systemPrompt: next.prefix,
    update: sections.length
      ? buildSystemUpdateMessage(
          restart
            ? sections.join("\n\n")
            : `System prompt update. The sections below replace their earlier versions; everything else in the system prompt is unchanged.\n\n${sections.join("\n\n")}`,
          "prompt-update",
          false,
        )
      : undefined,
    restart,
    commit: (restartRecorded = false) => {
      if (committed) {
        return;
      }
      committed = true;
      // An early restart marker already retired old overrides; keep this turn's new operators.
      params.state.pendingSystemPrompt = restartRecorded ? { ...next, restart: false } : next;
      params.state.systemPromptRouteKey = params.routeKey;
    },
  };
}

/** Invalidate before the write so an interrupted retirement cannot revive cached overrides. */
export async function retireSessionSystemPrompt(
  state: EmbeddedSessionPromptState,
  routeKey: string,
  appendEntry: (customType: string, data: unknown) => unknown,
): Promise<void> {
  state.systemPrompt = undefined;
  state.pendingSystemPrompt = undefined;
  state.systemPromptRouteKey = routeKey;
  await appendEntry("openclaw.system-prompt", { restart: true, routeKey });
}

export async function persistSessionSystemPrompt(
  state: EmbeddedSessionPromptState,
  appendEntry: (customType: string, data: unknown) => unknown,
): Promise<void> {
  const snapshot = state.pendingSystemPrompt ?? state.systemPrompt;
  if (!snapshot) {
    return;
  }
  const previous = state.systemPrompt;
  if (
    snapshot.restart ||
    !previous ||
    snapshot.prefix !== previous.prefix ||
    snapshot.renderedPrefix !== previous.renderedPrefix ||
    snapshot.routeKey !== previous.routeKey ||
    snapshot.historyId !== previous.historyId ||
    snapshot.permissionNotice !== previous.permissionNotice
  ) {
    try {
      await appendEntry("openclaw.system-prompt", snapshot);
    } catch (error) {
      // Rejection can follow a durable commit; keep pending work, but distrust the cached checkpoint.
      state.systemPrompt = undefined;
      throw error;
    }
  }
  state.systemPrompt = { ...snapshot, restart: false };
  state.pendingSystemPrompt = undefined;
}

const MAX_SESSION_PROMPT_STATES = 64;
const MAX_ACTIVE_PROJECT_KEYS = 4;
const SESSION_PROMPT_STATES_KEY = Symbol.for("openclaw.embeddedSessionPromptStates");
const sessionPromptStates = resolveGlobalSingleton(
  SESSION_PROMPT_STATES_KEY,
  () => new Map<string, EmbeddedSessionPromptState>(),
);
const sessionActiveProjects = resolveGlobalSingleton(
  Symbol.for("openclaw.embeddedSessionActiveProjects"),
  () => new Map<string, string[]>(),
);

export function createToolResultPromptProjectionState(
  source?: ToolResultPromptProjectionState,
): ToolResultPromptProjectionState {
  return {
    replacements: new Map(source?.replacements),
    frozen: new Set(source?.frozen),
    ambiguousBaseKeys: new Set(source?.ambiguousBaseKeys),
    sourceHashByKey: new Map(source?.sourceHashByKey),
    restoredCacheTtl: new Map(source?.restoredCacheTtl),
    ...(source
      ? { cacheTtlCheckpoint: source.cacheTtlCheckpoint, cacheTtlRevision: source.cacheTtlRevision }
      : {}),
  };
}

export function recordToolResultPromptProjection(
  state: ToolResultPromptProjectionState,
  key: string,
  message: ToolResultMessage,
  cacheTtl = state.replacements.get(key)?.cacheTtl,
): void {
  // Ordinary replay merges canonical metadata and non-text blocks. Keeping them
  // here would pin full read/web payloads after attempt teardown; TTL owns exact content.
  state.replacements.set(key, {
    cacheTtl,
    content: cacheTtl
      ? message.content
      : message.content.flatMap((block) =>
          isRecord(block) && block.type === "text" && typeof block.text === "string"
            ? [{ type: "text" as const, text: block.text }]
            : [],
        ),
  });
}

export function getEmbeddedSessionPromptState(sessionId: string): EmbeddedSessionPromptState {
  const existing = sessionPromptStates.get(sessionId);
  const current: EmbeddedSessionPromptState = existing ?? {
    activeAttempts: 0,
    toolResults: createToolResultPromptProjectionState(),
  };
  sessionPromptStates.delete(sessionId);
  sessionPromptStates.set(sessionId, current);
  if (existing) {
    return current;
  }
  for (const [key, state] of sessionPromptStates) {
    if (sessionPromptStates.size <= MAX_SESSION_PROMPT_STATES) {
      break;
    }
    if (key !== sessionId && state.activeAttempts === 0) {
      sessionPromptStates.delete(key);
    }
  }
  return current;
}

/** Overlapping cleanup keeps the next attempt's state until its own settlement. */
export function retainEmbeddedSessionPromptState(sessionId: string) {
  const state = getEmbeddedSessionPromptState(sessionId);
  state.activeAttempts++;
  let active = true;
  return {
    state,
    [Symbol.dispose]() {
      if (!active) {
        return;
      }
      active = false;
      if (--state.activeAttempts === 0 && sessionPromptStates.get(sessionId) === state) {
        sessionPromptStates.delete(sessionId);
      }
    },
  };
}

export function recordRuntimeContextProjection(
  sessionId: string,
  removed: readonly AgentMessage[] | undefined,
  converted: readonly Message[],
): boolean {
  const state = getEmbeddedSessionPromptState(sessionId);
  const keys = removed?.map((message, index) => `${index}:${message.timestamp}`);
  const positions = converted.flatMap((message, index) =>
    message.role === "user" && message.runtimeContextCarrier ? [index] : [],
  );
  const changed =
    keys?.some((key) => !state.removedRuntimeContextKeys?.has(key)) ||
    state.runtimeContextCarrierPositions?.some((position, index) => positions[index] !== position);
  if (keys) {
    state.removedRuntimeContextKeys = new Set(keys);
  }
  state.runtimeContextCarrierPositions = positions;
  return Boolean(changed);
}

export async function persistToolResultProjections(
  state: ToolResultPromptProjectionState,
  appendEntry: (customType: string, data: unknown) => Promise<unknown>,
  cacheTouch?: { timestamp: number; provider: string; modelId: string },
): Promise<void> {
  const snapshot = serializeCacheTtlToolResultProjections(state);
  const previous = state.cacheTtlCheckpoint;
  const revision = state.cacheTtlRevision ?? 0;
  if (
    previous === undefined &&
    !cacheTouch &&
    !snapshot.prunedToolResults.length &&
    !snapshot.frozenToolResults.length &&
    !snapshot.ambiguousToolResultBaseKeys.length
  ) {
    return;
  }
  const { marker, checkpoint } = prepareCacheTtlCheckpoint(snapshot, previous ?? undefined);
  if (!marker && !cacheTouch) {
    return;
  }
  let committedCheckpoint: CacheTtlCheckpoint | null = null;
  try {
    await appendEntry("openclaw.cache-ttl", { ...cacheTouch, ...marker });
    committedCheckpoint = checkpoint;
  } finally {
    // Rejection can follow a durable commit; the next write must re-establish the full base.
    // A branch restore during the write owns its new baseline.
    if ((state.cacheTtlRevision ?? 0) === revision) {
      state.cacheTtlCheckpoint = committedCheckpoint;
      state.cacheTtlRevision = revision + 1;
    }
  }
}

/** Records the prepared repository identity and snapshots this session's LRU active set. */
export function prepareEmbeddedSessionActiveProjectKeys(
  sessionId: string,
  projectKey: string | null,
): readonly string[] {
  const keys = sessionActiveProjects.get(sessionId) ?? [];
  sessionActiveProjects.delete(sessionId);
  sessionActiveProjects.set(sessionId, keys);
  pruneMapToMaxSize(sessionActiveProjects, MAX_SESSION_PROMPT_STATES);
  if (projectKey) {
    const existing = keys.indexOf(projectKey);
    if (existing >= 0) {
      keys.splice(existing, 1);
    }
    keys.unshift(projectKey);
    keys.length = Math.min(keys.length, MAX_ACTIVE_PROJECT_KEYS);
  }
  return [...keys];
}

export function clearEmbeddedSessionPromptStates(sessionIds: Iterable<string | undefined>): void {
  for (const sessionId of sessionIds) {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionPromptStates.delete(normalized);
      sessionActiveProjects.delete(normalized);
    }
  }
}
