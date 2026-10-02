/** Transcript-backed prompt projection state cached by an embedded session lifecycle. */
import {
  splitSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "@openclaw/ai/internal/shared";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { Message } from "../../llm/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { getOpenClawSystemUpdateKind } from "../internal-runtime-context.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { extractAttemptPermissionNotice } from "./run/attempt-system-prompt.js";
import { buildSystemUpdateMessage } from "./run/runtime-context-prompt.js";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export type ToolResultPromptProjectionState = {
  replacements: Map<string, { content: ToolResultMessage["content"]; cacheTtl?: "soft" | "hard" }>;
  frozen: Set<string>;
  ambiguousBaseKeys: Set<string>;
  sourceHashByKey: Map<string, string>;
  /** Cache-TTL marks read from the transcript marker; the projection owner materializes them on the next replay. */
  restoredCacheTtl: Map<string, RestoredCacheTtlMark>;
  lastWrittenSnapshotHash?: string;
};

type RestoredCacheTtlMark = { mode: "soft" } | { mode: "hard"; placeholder: string };

type EmbeddedSessionPromptState = {
  activeProjectKeys: string[];
  toolResults: ToolResultPromptProjectionState;
  sentUserTurnIds: Set<string>;
  systemPrompt?: SystemPromptSeries;
  pendingSystemPrompt?: SystemPromptSeries;
  systemPromptRouteKey?: string;
  persistedSystemPrompt?: string;
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
  const after = promptSections(current);
  return [
    ...[...after].flatMap(([heading, section]) =>
      before.get(heading) === section ? [] : [section],
    ),
    ...[...before.keys()].flatMap((heading) =>
      after.has(heading) ? [] : [`${heading}\n(removed)`],
    ),
  ];
}

/** Restore only a matching effective prompt; a changed restart input begins a fresh series. */
export function prepareSessionSystemPrompt(params: {
  state: EmbeddedSessionPromptState;
  routeKey: string;
  systemPrompt: string;
  entries: SessionEntry[];
}) {
  const { permissionNotice, systemPrompt: prompt } = extractAttemptPermissionNotice(
    params.systemPrompt,
  );
  const split = splitSystemPromptCacheBoundary(prompt);
  const renderedPrefix = split?.stablePrefix ?? prompt;
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
    params.state.persistedSystemPrompt = undefined;
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
      data.renderedPrefix === renderedPrefix &&
      data.routeKey === params.routeKey &&
      data.historyId === historyId &&
      !afterCheckpoint.some((later) => later.type === "model_change")
    ) {
      series = {
        prefix: data.prefix,
        hash: data.hash,
        renderedPrefix,
        routeKey: params.routeKey,
        historyId,
        permissionNotice:
          typeof data.permissionNotice === "string" ? data.permissionNotice : undefined,
        restart: false,
      };
    }
  }
  const restart = !series || series.routeKey !== params.routeKey || series.historyId !== historyId;
  const sections = !restart && series ? promptDelta(series.renderedPrefix, renderedPrefix) : [];
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
    systemPrompt: split
      ? `${next.prefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${split.dynamicSuffix}`
      : next.prefix,
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
  state.persistedSystemPrompt = undefined;
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
  const fingerprint = JSON.stringify({ ...snapshot, restart: false });
  if (snapshot.restart || state.persistedSystemPrompt !== fingerprint) {
    try {
      await appendEntry("openclaw.system-prompt", snapshot);
    } catch (error) {
      // Rejection can follow a durable commit; keep pending work, but distrust the cached checkpoint.
      state.systemPrompt = undefined;
      state.persistedSystemPrompt = undefined;
      throw error;
    }
  }
  state.persistedSystemPrompt = fingerprint;
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

export function createToolResultPromptProjectionState(): ToolResultPromptProjectionState {
  return {
    replacements: new Map(),
    frozen: new Set<string>(),
    ambiguousBaseKeys: new Set<string>(),
    sourceHashByKey: new Map<string, string>(),
    restoredCacheTtl: new Map(),
  };
}

export function cloneToolResultPromptProjectionState(
  state: ToolResultPromptProjectionState,
): ToolResultPromptProjectionState {
  return {
    replacements: new Map(state.replacements),
    frozen: new Set(state.frozen),
    ambiguousBaseKeys: new Set(state.ambiguousBaseKeys),
    sourceHashByKey: new Map(state.sourceHashByKey),
    restoredCacheTtl: new Map(state.restoredCacheTtl),
    lastWrittenSnapshotHash: state.lastWrittenSnapshotHash,
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

/** TTL trims are re-derived; ordinary trims retain only text, never images or tool metadata. */
export function serializeCacheTtlToolResultProjections(state: ToolResultPromptProjectionState) {
  const marks = new Map(state.restoredCacheTtl);
  for (const [key, projection] of state.replacements) {
    if (projection.cacheTtl === "soft") {
      marks.set(key, { mode: "soft" });
    } else if (projection.cacheTtl === "hard") {
      const placeholder = projection.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      marks.set(key, { mode: "hard", placeholder });
    }
  }
  return {
    prunedToolResults: [...marks].map(([key, mark]) => Object.assign({ key }, mark)),
    ambiguousToolResultBaseKeys: [...state.ambiguousBaseKeys],
    frozenToolResults: [...state.sourceHashByKey].flatMap(([key, sourceHash]) => {
      if (!state.frozen.has(key)) {
        return [];
      }
      const projection = state.replacements.get(key);
      return [
        {
          key,
          sourceHash,
          ...(!projection?.cacheTtl && projection
            ? {
                texts: projection.content.flatMap((block) =>
                  block.type === "text" ? [block.text] : [],
                ),
              }
            : {}),
        },
      ];
    }),
  };
}

export function getEmbeddedSessionPromptState(sessionId: string): EmbeddedSessionPromptState {
  const existing = sessionPromptStates.get(sessionId);
  if (existing) {
    sessionPromptStates.delete(sessionId);
    sessionPromptStates.set(sessionId, existing);
    return existing;
  }
  const created: EmbeddedSessionPromptState = {
    activeProjectKeys: [],
    toolResults: createToolResultPromptProjectionState(),
    sentUserTurnIds: new Set(),
  };
  sessionPromptStates.set(sessionId, created);
  pruneMapToMaxSize(sessionPromptStates, MAX_SESSION_PROMPT_STATES);
  return created;
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

export function hashToolResultProjectionSnapshot(
  snapshot: ReturnType<typeof serializeCacheTtlToolResultProjections>,
): string {
  return sha256Hex(JSON.stringify(snapshot));
}

export async function persistToolResultProjections(
  state: ToolResultPromptProjectionState,
  appendEntry: (customType: string, data: unknown) => Promise<unknown>,
): Promise<void> {
  if (state.frozen.size === 0) {
    return;
  }
  const snapshot = serializeCacheTtlToolResultProjections(state);
  const hash = hashToolResultProjectionSnapshot(snapshot);
  if (hash === state.lastWrittenSnapshotHash) {
    return;
  }
  await appendEntry("openclaw.cache-ttl", snapshot);
  // A failed owned write must leave the snapshot eligible for persistence.
  state.lastWrittenSnapshotHash = hash;
}

/** Records the prepared repository identity and snapshots this session's LRU active set. */
export function prepareEmbeddedSessionActiveProjectKeys(
  sessionId: string,
  projectKey: string | null,
): readonly string[] {
  const state = getEmbeddedSessionPromptState(sessionId);
  if (projectKey) {
    const existing = state.activeProjectKeys.indexOf(projectKey);
    if (existing >= 0) {
      state.activeProjectKeys.splice(existing, 1);
    }
    state.activeProjectKeys.unshift(projectKey);
    state.activeProjectKeys.length = Math.min(
      state.activeProjectKeys.length,
      MAX_ACTIVE_PROJECT_KEYS,
    );
  }
  return [...state.activeProjectKeys];
}

export function clearEmbeddedSessionPromptStates(sessionIds: Iterable<string | undefined>): void {
  for (const sessionId of sessionIds) {
    const normalized = sessionId?.trim();
    if (normalized) {
      sessionPromptStates.delete(normalized);
    }
  }
}

export function markSessionUserTurnsSent(
  state: EmbeddedSessionPromptState,
  messages: AgentMessage[],
): void {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const idempotencyKey = (message as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof idempotencyKey === "string" && idempotencyKey.length > 0) {
      state.sentUserTurnIds.add(idempotencyKey);
    }
  }
}

export function hasSessionUserTurnBeenSent(
  state: EmbeddedSessionPromptState,
  message: AgentMessage | undefined,
): boolean | undefined {
  if (!message || message.role !== "user") {
    return undefined;
  }
  const idempotencyKey = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof idempotencyKey === "string" && idempotencyKey.length > 0
    ? state.sentUserTurnIds.has(idempotencyKey)
    : undefined;
}
