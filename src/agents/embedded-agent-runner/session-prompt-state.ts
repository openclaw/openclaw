/** Transcript-backed prompt projection state cached by an embedded session lifecycle. */
import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { Message, ToolResultMessage } from "../../llm/types.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { gateAgentToolExecution } from "../agent-tool-availability.js";
import { copyAgentToolMetadata, getAgentToolListingScope } from "../agent-tool-metadata.js";
import { getOpenClawSystemUpdateKind } from "../internal-runtime-context.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { shareSystemPromptPrefix } from "../sessions/system-prompt-pool.js";
import {
  readToolUsageRankingSnapshot,
  type ToolUsageRankingSnapshot,
} from "../tool-usage-ranking.js";
import type { AnyAgentTool } from "../tools/common.js";
import {
  prepareCacheTtlCheckpoint,
  serializeCacheTtlToolResultProjections,
  type CacheTtlCheckpoint,
  type CacheTtlProjectionInput,
} from "./cache-ttl-checkpoint.js";
import { extractAttemptPermissionNotice } from "./run/attempt-system-prompt.js";
import { buildSystemUpdateMessage } from "./run/runtime-context-prompt.js";
import { promptDelta } from "./session-prompt-delta.js";
import { resolvePromptHistoryId } from "./session-prompt-history-id.js";
import { SYSTEM_PROMPT_UPDATE_HEADER } from "./session-prompt-update.js";
import {
  readToolSurfaceCheckpoint,
  type ToolDefinition,
  type ToolSurface,
} from "./session-tool-checkpoint.js";
import { describeSessionToolDefinition, sameToolParameters } from "./session-tool-definition.js";

export type ToolResultPromptProjectionState = CacheTtlProjectionInput & {
  /** Null means an uncertain append requires a checkpoint, including for empty state. */
  cacheTtlCheckpoint?: CacheTtlCheckpoint | null;
};

type EmbeddedSessionPromptState = {
  activeAttempts: number;
  usageRanking?: {
    routeKey: string;
    historyId: string | null;
    snapshot?: ToolUsageRankingSnapshot;
  };
  persistedUsageRanking?: ToolUsageRankingSnapshot;
  toolResults: ToolResultPromptProjectionState;
  systemPrompt?: SystemPromptSeries;
  pendingSystemPrompt?: SystemPromptSeries;
  systemPromptRouteKey?: string;
  historyBoundary?: { count: number; id: string | null };
  toolSurface?: ToolSurface;
  pendingToolSurface?: ToolSurface;
  removedRuntimeContextKeys?: Set<string>;
  runtimeContextCarrierPositions?: number[];
};

type SystemPromptSeries = {
  prefix: string;
  hash: string;
  renderedPrefix: string;
  routeKey: string;
  historyId: string | null;
  /** The transcript's boundary count when this series was written; see resolvePromptHistoryId. */
  boundaryCount?: number;
  permissionNotice?: string;
  usageRanking?: ToolUsageRankingSnapshot;
  restart: boolean;
};

const SYSTEM_PROMPT_ROUTE_PARTS = [
  "provider",
  "model",
  "api",
  "baseUrl",
  "inHistorySystemUpdates",
  "personalProfile",
  "harness",
  "surface",
] as const;
type SystemPromptRoutePart = (typeof SYSTEM_PROMPT_ROUTE_PARTS)[number];
type SystemPromptRestartReason =
  | "new"
  | "history"
  | "model-change"
  | `route:${SystemPromptRoutePart}`;
export type SystemPromptSeriesStatus = "pinned" | `restarted:${SystemPromptRestartReason}`;

/** One owner for the series key layout; saved checkpoints compare these exact bytes. */
export function buildSystemPromptRouteKey(
  route: Partial<Record<SystemPromptRoutePart, string | boolean | undefined>>,
): string {
  return JSON.stringify(SYSTEM_PROMPT_ROUTE_PARTS.map((part) => route[part]));
}

export function parseSystemPromptRouteKey(
  routeKey: unknown,
): Partial<Record<SystemPromptRoutePart, unknown>> | undefined {
  if (typeof routeKey !== "string") {
    return undefined;
  }
  let parts: unknown;
  try {
    parts = JSON.parse(routeKey);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts)) {
    return undefined;
  }
  const route: Partial<Record<SystemPromptRoutePart, unknown>> = {};
  SYSTEM_PROMPT_ROUTE_PARTS.forEach((part, index) => {
    route[part] = parts[index];
  });
  return route;
}

function changedPromptRoutePart(previous: unknown, current: string): SystemPromptRestartReason {
  const before = parseSystemPromptRouteKey(previous);
  const after = parseSystemPromptRouteKey(current);
  const part =
    before && after
      ? SYSTEM_PROMPT_ROUTE_PARTS.find((name) => before[name] !== after[name])
      : undefined;
  return part ? `route:${part}` : "new";
}

type ToolSurfaceInput = {
  state: EmbeddedSessionPromptState;
  routeKey: string;
  toolPolicy: string;
  entries: SessionEntry[];
  historyBoundaryCount?: number;
  tools: AnyAgentTool[];
};

/** The prompt owner alone decides when persisted usage may enter provider-visible text. */
export async function prepareSessionToolUsageRanking(params: {
  state: EmbeddedSessionPromptState;
  routeKey: string;
  entries: SessionEntry[];
  historyBoundaryCount?: number;
  enabled: boolean;
  catalogIds: readonly string[];
  inherited?: ToolUsageRankingSnapshot;
  now: number;
  readRankedIds: () => Promise<readonly string[]>;
}): Promise<ToolUsageRankingSnapshot | undefined> {
  const historyId = resolvePromptHistoryId(params);
  const markerIndex = params.entries.findLastIndex(
    (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
  );
  const marker = params.entries[markerIndex];
  const data = marker?.type === "custom" && isRecord(marker.data) ? marker.data : undefined;
  const afterModelChange = params.entries
    .slice(markerIndex + 1)
    .some((entry) => entry.type === "model_change");
  const previous = params.state.usageRanking;
  if (!previous) {
    // Both checkpoint consumers share the ranking owner's one restored identity.
    params.state.persistedUsageRanking = readToolUsageRankingSnapshot(data?.usageRanking);
  }
  const sameBoundary = previous
    ? previous.routeKey === params.routeKey && previous.historyId === historyId
    : data?.routeKey === params.routeKey && data.historyId === historyId && !afterModelChange;
  let snapshot = sameBoundary
    ? previous
      ? previous.snapshot
      : params.state.persistedUsageRanking
    : undefined;
  const frozen = snapshot;
  if (!sameBoundary && params.enabled) {
    const inherited = !data && !historyId ? params.inherited : undefined;
    const allowed = new Set(params.catalogIds);
    const orderedToolIds = (
      inherited ? inherited.orderedToolIds : [...(await params.readRankedIds())]
    ).filter((id) => allowed.has(id));
    const firstSeen =
      inherited?.newcomers ??
      previous?.snapshot?.newcomers ??
      params.state.persistedUsageRanking?.newcomers;
    snapshot = {
      version: 1,
      at: inherited?.at ?? params.now,
      orderedToolIds,
      newcomers: Object.fromEntries(
        params.catalogIds.map((id) => [id, firstSeen?.[id] ?? params.now]),
      ),
    };
  } else if (
    frozen &&
    (params.catalogIds.some((id) => frozen.newcomers?.[id] === undefined) ||
      frozen.orderedToolIds.some((id) => !params.catalogIds.includes(id)))
  ) {
    // Catalog refresh admits newcomers without rereading scores or disturbing surviving order.
    snapshot = {
      ...frozen,
      orderedToolIds: frozen.orderedToolIds.filter((id) => params.catalogIds.includes(id)),
      newcomers: {
        ...frozen.newcomers,
        ...Object.fromEntries(
          params.catalogIds
            .filter((id) => frozen.newcomers?.[id] === undefined)
            .map((id) => [id, params.now]),
        ),
      },
    };
  }
  params.state.usageRanking = { routeKey: params.routeKey, historyId, snapshot };
  return snapshot;
}

/** Spawn captures the parent's admitted preference, never its live usage or tool authority. */
export function getSessionToolUsageRanking(
  sessionId: string,
): ToolUsageRankingSnapshot | undefined {
  return sessionPromptStates.get(sessionId)?.usageRanking?.snapshot;
}

function resolveSessionToolSurface(params: ToolSurfaceInput) {
  const historyId = resolvePromptHistoryId(params);
  const restored = (): ToolSurface | undefined => {
    const pin = readToolSurfaceCheckpoint(params.entries);
    return pin?.routeKey === params.routeKey &&
      pin.historyId === historyId &&
      pin.toolPolicy === params.toolPolicy
      ? {
          routeKey: params.routeKey,
          historyId,
          toolPolicy: params.toolPolicy,
          tools: pin.tools,
          publicationListing: pin.publicationListing,
        }
      : undefined;
  };
  const candidate = params.state.pendingToolSurface ?? params.state.toolSurface ?? restored();
  const known =
    candidate?.routeKey === params.routeKey &&
    candidate.historyId === historyId &&
    candidate.toolPolicy === params.toolPolicy
      ? candidate
      : undefined;
  // A restored pin rides along with later combined checkpoints.
  params.state.toolSurface = params.state.pendingToolSurface ? params.state.toolSurface : known;
  return { known, historyId };
}

/** Async discovery cannot rewrite an established listing before a config/tool refresh. */
export function prepareSessionPublicationToolListing(
  params: Omit<ToolSurfaceInput, "entries"> & {
    getEntries: () => SessionEntry[];
    refresh?: boolean;
  },
): AnyAgentTool[] {
  const current = params.tools.find((tool) => tool.name === "github_publish");
  const scope = current && getAgentToolListingScope(current);
  if (!current || scope === undefined) {
    return params.tools;
  }
  const { known, historyId } = resolveSessionToolSurface({
    ...params,
    entries: params.getEntries(),
  });
  const previous = known?.publicationListing;
  const listing =
    previous && previous.scope === scope && !params.refresh
      ? previous
      : {
          scope,
          ...describeSessionToolDefinition(current),
          label: current.label,
          async: current.async,
          catalogMode: current.catalogMode,
        };
  if (listing !== previous) {
    const { name, description, parameters } = listing;
    params.state.pendingToolSurface = {
      routeKey: params.routeKey,
      historyId,
      toolPolicy: params.toolPolicy,
      tools: known?.tools?.map((tool) =>
        tool.name === name ? { name, description, parameters } : tool,
      ),
      publicationListing: listing,
    };
  }
  const { scope: _scope, ...pin } = listing;
  if (
    pin.description === current.description &&
    pin.label === current.label &&
    pin.async === current.async &&
    pin.catalogMode === current.catalogMode &&
    sameToolParameters(pin.parameters, current.parameters)
  ) {
    return params.tools;
  }
  return params.tools.map((tool) =>
    tool === current
      ? copyAgentToolMetadata(tool, {
          ...tool,
          ...pin,
          async: pin.async,
          catalogMode: pin.catalogMode,
        })
      : tool,
  );
}

/** The series' first request pins tools and definitions; unbuilt pinned tools refuse calls. */
export function prepareSessionToolSurface(
  params: ToolSurfaceInput & { admitNewTools?: boolean },
): AnyAgentTool[] {
  const { known, historyId } = resolveSessionToolSurface(params);
  const previous = new Map(known?.tools?.map((pin) => [pin.name, pin]));
  // Surfaces that still filter per turn admit new tools and changed schemas, as before.
  const admitted =
    !known?.tools || params.admitNewTools
      ? params.tools.filter(
          (tool) =>
            !previous.has(tool.name) ||
            // Computer discovery supplies live facts, never a new session definition.
            (tool.name !== "computer" &&
              !sameToolParameters(previous.get(tool.name)?.parameters, tool.parameters)),
        )
      : [];
  let pinned = known?.tools;
  if (!pinned || admitted.length > 0) {
    const definitions = new Map([
      ...previous,
      ...admitted.map((tool) => [tool.name, describeSessionToolDefinition(tool)] as const),
    ]);
    pinned = [...definitions.values()].toSorted((a, b) => a.name.localeCompare(b.name));
    params.state.pendingToolSurface = {
      routeKey: params.routeKey,
      historyId,
      toolPolicy: params.toolPolicy,
      publicationListing: known?.publicationListing,
      tools: pinned,
    };
  }
  const built = new Map(params.tools.map((tool) => [tool.name, tool]));
  return pinned.map((pin) => {
    const tool = built.get(pin.name);
    return tool ? copyAgentToolMetadata(tool, { ...tool, ...pin }) : refusePinnedTool(pin);
  });
}

function refusePinnedTool(tool: ToolDefinition): AnyAgentTool {
  return gateAgentToolExecution(
    { ...tool, label: tool.name, execute: async () => ({ content: [], details: {} }) },
    `${tool.name} is not available in this turn. Do not retry ${tool.name}.`,
  );
}

/** Tools last sent to the provider (undefined before a pin), for compaction estimates. */
export function readSessionSentTools(entries: SessionEntry[]): AnyAgentTool[] | undefined {
  return readToolSurfaceCheckpoint(entries)?.tools.map(refusePinnedTool);
}

/** Unsent preparation belongs to its attempt. */
export function beginSessionSystemPrompt(state: EmbeddedSessionPromptState): void {
  state.pendingSystemPrompt = undefined;
  state.historyBoundary = undefined;
}

/**
 * Restore the admitted series; refreshed instructions append after its conversation prefix.
 *
 * Every session pins one system prompt on every route and runtime. Later changes go out
 * as appended `prompt-update` deltas: an in-history system message where the route
 * accepts one, otherwise a user-role note. The series rebuilds only at these points:
 * - `new`: the session's first request, or `/new` and `/reset` (a new session);
 * - `history`: an explicit compaction or a transcript reset;
 * - `model-change` and `route:*`: a model or provider switch, including its API, base
 *   URL, system-message capability, harness or tool surface, or a change of the
 *   session's selected person.
 * The operator refresh is one of these: `/compact`, `/new` or a model switch.
 */
export function prepareSessionSystemPrompt(params: {
  state: EmbeddedSessionPromptState;
  routeKey: string;
  systemPrompt: string;
  entries: SessionEntry[];
  historyBoundaryCount?: number;
}) {
  const { permissionNotice, systemPrompt } = extractAttemptPermissionNotice(params.systemPrompt);
  const historyId = resolvePromptHistoryId(params);
  const markerIndex = params.entries.findLastIndex(
    (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
  );
  const afterCheckpoint = params.entries.slice(markerIndex + 1);
  const checkpoint = params.entries[markerIndex];
  const data = checkpoint?.type === "custom" ? checkpoint.data : undefined;
  const orphanedUpdate =
    !params.state.pendingSystemPrompt &&
    afterCheckpoint.some((entry) => getOpenClawSystemUpdateKind(entry) === "prompt-update");
  if (orphanedUpdate) {
    // A canceled append may precede its checkpoint; retire that override before any new request.
    params.state.systemPrompt = undefined;
  }
  let series = params.state.pendingSystemPrompt ?? params.state.systemPrompt;
  const previous = series ?? (isRecord(data) && typeof data.prefix === "string" ? data : undefined);
  if (
    !series &&
    !orphanedUpdate &&
    (!params.state.systemPromptRouteKey || params.state.systemPromptRouteKey === params.routeKey)
  ) {
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
        prefix: shareSystemPromptPrefix(data.prefix),
        hash: data.hash,
        renderedPrefix: shareSystemPromptPrefix(data.renderedPrefix),
        routeKey: params.routeKey,
        historyId,
        // The persisted count: a checkpoint written before the count existed is rewritten with it.
        boundaryCount: typeof data.boundaryCount === "number" ? data.boundaryCount : undefined,
        permissionNotice:
          typeof data.permissionNotice === "string" ? data.permissionNotice : undefined,
        usageRanking: params.state.persistedUsageRanking,
        restart: false,
      };
      params.state.systemPrompt = series;
    }
  }
  const renderedPrefix =
    series?.renderedPrefix === systemPrompt
      ? series.renderedPrefix
      : shareSystemPromptPrefix(systemPrompt);
  const restart = !series || series.routeKey !== params.routeKey || series.historyId !== historyId;
  const seriesStatus: SystemPromptSeriesStatus = !restart
    ? "pinned"
    : !previous
      ? "restarted:new"
      : previous.historyId !== historyId
        ? "restarted:history"
        : afterCheckpoint.some((later) => later.type === "model_change")
          ? "restarted:model-change"
          : `restarted:${changedPromptRoutePart(previous.routeKey, params.routeKey)}`;
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
        boundaryCount: params.historyBoundaryCount,
        permissionNotice,
        usageRanking: params.state.usageRanking?.snapshot,
        restart: true,
      }
    : {
        ...series!,
        boundaryCount: params.historyBoundaryCount,
        renderedPrefix,
        permissionNotice,
        usageRanking: params.state.usageRanking?.snapshot,
        restart: false,
      };
  // Admission callbacks need the series, not the transcript used to restore it.
  const { state, routeKey } = params;
  let committed = false;
  return {
    systemPrompt: next.prefix,
    update: sections.length
      ? buildSystemUpdateMessage(
          restart
            ? sections.join("\n\n")
            : `${SYSTEM_PROMPT_UPDATE_HEADER}\n\n${sections.join("\n\n")}`,
          "prompt-update",
          false,
        )
      : undefined,
    restart,
    seriesStatus,
    commit: (restartRecorded = false) => {
      if (committed) {
        return;
      }
      committed = true;
      // An early restart marker already retired old overrides; keep this turn's new operators.
      state.pendingSystemPrompt = restartRecorded ? { ...next, restart: false } : next;
      state.systemPromptRouteKey = routeKey;
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
  // A pin belongs to one route and history; compaction or a route change retires it.
  const candidate = state.pendingToolSurface ?? state.toolSurface;
  const toolSurface =
    candidate?.routeKey === snapshot.routeKey && candidate.historyId === snapshot.historyId
      ? candidate
      : undefined;
  if (
    state.pendingToolSurface ||
    snapshot.restart ||
    !previous ||
    snapshot.prefix !== previous.prefix ||
    snapshot.renderedPrefix !== previous.renderedPrefix ||
    snapshot.routeKey !== previous.routeKey ||
    snapshot.historyId !== previous.historyId ||
    snapshot.boundaryCount !== previous.boundaryCount ||
    snapshot.permissionNotice !== previous.permissionNotice ||
    snapshot.usageRanking !== previous.usageRanking
  ) {
    try {
      await appendEntry(
        "openclaw.system-prompt",
        toolSurface
          ? {
              ...snapshot,
              toolPolicy: toolSurface.toolPolicy,
              tools: toolSurface.tools,
              publicationListing: toolSurface.publicationListing,
            }
          : snapshot,
      );
    } catch (error) {
      // Rejection can follow a durable commit; keep pending work, but distrust the cached checkpoint.
      state.systemPrompt = undefined;
      state.toolSurface = undefined;
      throw error;
    }
  }
  state.systemPrompt = { ...snapshot, restart: false };
  state.persistedUsageRanking = snapshot.usageRanking;
  state.pendingSystemPrompt = undefined;
  state.toolSurface = toolSurface;
  state.pendingToolSurface = undefined;
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
    ...(source ? { cacheTtlCheckpoint: source.cacheTtlCheckpoint } : {}),
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
      : freezeJsonSnapshot(
          message.content.flatMap((block) =>
            isRecord(block) && block.type === "text" && typeof block.text === "string"
              ? [{ type: "text" as const, text: block.text }]
              : [],
          ),
        ),
  });
}

function getEmbeddedSessionPromptState(sessionId: string): EmbeddedSessionPromptState {
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
    state.cacheTtlCheckpoint = committedCheckpoint;
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
