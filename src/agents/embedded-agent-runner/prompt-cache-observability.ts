import { registerSessionResourceCleanup } from "@openclaw/ai/internal/runtime";
import {
  sortPromptCacheToolsByName,
  splitSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import { getPublishedRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { ContextEnginePromptCacheObservationChange as PromptCacheChange } from "../../context-engine/types.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import type { Message } from "../../llm/types.js";
import type { NormalizedUsage } from "../usage.js";
import { log } from "./logger.js";
import {
  describePromptCacheFactChanges,
  describeToolChanges,
  type PromptCacheToolSnapshot,
  describePromptCacheSectionChanges,
  fingerprintPromptSections,
  formatChangedPromptSections,
  type PromptSectionDigests,
} from "./prompt-cache-facts.js";
import {
  describeHistoryChange,
  fingerprintMessage,
  type PromptHistoryFingerprint,
} from "./prompt-cache-history.js";
import type { ProviderPromptState } from "./provider-prompt-state.js";

type PromptHistoryRewriteReason = "compaction" | "pruning" | "runtimeContextCarrier";
type PromptCacheIdentity = { sessionId: string; promptCacheKey?: string; sessionKey?: string };

export type { PromptCacheChange };

type PromptCacheToolDescriptor = {
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: object;
};

type PromptCacheSnapshot = {
  provider: string;
  modelId: string;
  modelApi?: string | null;
  cacheRetention?: "none" | "short" | "long";
  streamStrategy: string;
  transport?: string;
  systemPromptDigest: string;
  systemPromptSections?: PromptSectionDigests;
  /** Digest of the volatile suffix below the cache boundary; undefined when the prompt has none. */
  systemPromptSuffixDigest?: string;
  systemPromptSuffixSections?: PromptSectionDigests;
  toolDigest: string;
  toolCount: number;
  tools: readonly PromptCacheToolSnapshot[];
};

type PromptCacheTracker = {
  sessionId: string;
  sessionKey?: string;
  history: PromptHistoryFingerprint[];
  historyBytes: number;
  declaredRewrites?: Set<PromptHistoryRewriteReason>;
  snapshot: PromptCacheSnapshot;
  lastCacheRead: number | null;
  /** Missing usage must not bind an older hit to a new request fingerprint. */
  lastCacheReadSnapshot?: PromptCacheSnapshot;
  lastProviderPrompt?: ProviderPromptState["lastAttempt"];
  requestedAt: number;
  pendingChanges: PromptCacheChange[] | null;
  unmeasuredChanges?: PromptCacheChange[] | null;
  /** The session tool pin changed the tool block on purpose before the next request. */
  toolPinChanged?: boolean;
  /** The session system-prompt series rebuilt at an allowed point before the next request. */
  systemPromptRebuilt?: boolean;
};

// Private, bounded before-images allow fact parsing to stay off the ordinary request path.
// Weak keys follow the existing snapshot lifecycle (current + last measured, max 512 trackers).
// Never attach text to the snapshots delivered to tracing/context-engine consumers.
const promptFactSources = new WeakMap<PromptCacheSnapshot, string>();
const toolFactSources = new WeakMap<
  readonly PromptCacheToolSnapshot[],
  Map<PromptCacheToolSnapshot, string>
>();
const MAX_PROMPT_FACT_SOURCE_CHARS = 32_768;
const MAX_TOOL_FACT_SOURCE_CHARS = 16_384;
const trackers = new Map<string, PromptCacheTracker>();
// Budget UTF-16 diagnostic strings plus container overhead, not conversation payloads.
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
let retainedHistoryBytes = 0;

/** Retired session IDs cannot reuse their cross-turn diagnostic baselines. */
export function clearPromptCacheObservations(sessionId?: string): void {
  if (sessionId === undefined) {
    trackers.clear();
    retainedHistoryBytes = 0;
    return;
  }
  for (const [key, tracker] of trackers) {
    if (tracker.sessionId === sessionId) {
      trackers.delete(key);
      retainedHistoryBytes -= tracker.historyBytes;
    }
  }
}
registerSessionResourceCleanup(clearPromptCacheObservations);

// Unpublished provider declarations retain their existing identity contract.
const toolSchemaFingerprints = new WeakMap<object, string>();
const MAX_TRACKERS = 512;
const historyRewriteWarnings = createDedupeCache({ ttlMs: 0, maxSize: MAX_TRACKERS });
const prefixChangeWarnings = createDedupeCache({ ttlMs: 0, maxSize: MAX_TRACKERS });
const MAX_HISTORY_DIFF_FIELDS = 8;
const MAX_NAMED_SECTION_CHANGES = 8;
const MIN_CACHE_BREAK_TOKEN_DROP = 1_000;
const MAX_STABLE_CACHE_READ_RATIO = 0.95;

function buildTrackerKey(params: PromptCacheIdentity): string {
  // Background reviews share provider affinity, but never diagnostic request ownership.
  return JSON.stringify([
    params.sessionId,
    params.promptCacheKey?.trim() || params.sessionKey?.trim() || params.sessionId,
  ]);
}

function describeProviderFields(
  beforeFields: Record<string, string>,
  afterFields: Record<string, string> | undefined,
): string {
  if (!afterFields) {
    return "removed";
  }
  const changed = [...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])].filter(
    (key) => beforeFields[key] !== afterFields[key],
  );
  return changed.length
    ? changed.slice(0, MAX_HISTORY_DIFF_FIELDS).join("+") +
        (changed.length > MAX_HISTORY_DIFF_FIELDS ? "+remaining" : "")
    : Object.keys(beforeFields).length || Object.keys(afterFields).length
      ? "order"
      : "value";
}

function describeProviderPrefix(
  previous: ProviderPromptState["lastAttempt"],
  next: ProviderPromptState["lastAttempt"],
): string {
  if (!previous?.cachePrefix || !next?.cachePrefix) {
    return "unavailable";
  }
  const before = previous.cachePrefix;
  const after = next.cachePrefix;
  if (previous.scopeDigest !== next.scopeDigest) {
    return "provider-scope";
  }
  const continuation = before.continuation || after.continuation;
  const segment = (["system", "tools"] as const).find((key) => before[key] !== after[key]);
  let index = -1;
  if (!after.messageDigests.startsWith(before.messageDigests)) {
    for (let offset = 0; offset < before.messageDigests.length; offset += 32) {
      if (
        before.messageDigests.slice(offset, offset + 32) !==
        after.messageDigests.slice(offset, offset + 32)
      ) {
        index = offset / 32;
        break;
      }
    }
  }
  let prefix = segment ?? (continuation ? "wire-prefix-match" : "prefix-match");
  if (!segment && index >= 0) {
    const item = before.messageFields[index];
    const fields = item ? `.${describeProviderFields(item, after.messageFields[index])}` : "";
    prefix = `${continuation ? "wire-input" : "message"}:${index}${fields}`;
  } else if (!segment && before.tail !== undefined) {
    // A growing tail cannot establish equality of its earlier messages from one digest.
    prefix =
      before.messageCount !== after.messageCount
        ? `unverified-after:${before.messageDigests.length / 32}`
        : before.tail !== after.tail
          ? `message-tail:${before.messageDigests.length / 32}`
          : prefix;
  }
  const parameters =
    before.parameters.digest !== after.parameters.digest
      ? `parameters:${describeProviderFields(before.parameters.fields, after.parameters.fields)}`
      : undefined;
  const format = before.messageField !== after.messageField ? "input-format" : undefined;
  const details = [
    prefix.endsWith("prefix-match") && (parameters || format) ? undefined : prefix,
    format,
    parameters,
  ]
    .filter(Boolean)
    .join(",");
  // A delta request's wire input is not its logical conversation prefix.
  return `${continuation ? "continuation:" : ""}${details}`;
}

function diffSnapshots(
  previous: PromptCacheSnapshot,
  next: PromptCacheSnapshot,
): PromptCacheChange[] | null {
  const changes: PromptCacheChange[] = [];
  if (previous.provider !== next.provider || previous.modelId !== next.modelId) {
    changes.push({
      code: "model",
      detail: `${previous.provider}/${previous.modelId} -> ${next.provider}/${next.modelId}`,
    });
  } else if ((previous.modelApi ?? null) !== (next.modelApi ?? null)) {
    changes.push({
      code: "model",
      detail: `${previous.modelApi ?? "unknown"} -> ${next.modelApi ?? "unknown"}`,
    });
  }
  for (const code of ["cacheRetention", "transport", "streamStrategy"] as const) {
    if (previous[code] !== next[code]) {
      changes.push({
        code,
        detail: `${previous[code] ?? "default"} -> ${next[code] ?? "default"}`,
      });
    }
  }
  // OpenAI Responses routes send the suffix inline in `instructions`, so a
  // suffix change re-caches from that point; Anthropic-style checkpoints lose
  // the later conversation checkpoint. Track it separately from the prefix.
  for (const [code, detail] of [
    ["systemPrompt", "system prompt digest changed"],
    ["systemPromptSuffix", "system prompt suffix digest changed"],
  ] as const) {
    if (previous[`${code}Digest`] !== next[`${code}Digest`]) {
      const before = previous[`${code}Sections`];
      const after = next[`${code}Sections`];
      changes.push({
        code,
        detail:
          before || after
            ? `${detail} (sections: ${formatChangedPromptSections(before, after)})`
            : detail,
      });
    }
  }
  if (previous.toolDigest !== next.toolDigest) {
    changes.push({
      code: "tools",
      detail: describeToolChanges(previous, next),
    });
  }
  return changes.length > 0 ? changes : null;
}

export function collectPromptCacheTools(
  tools: readonly PromptCacheToolDescriptor[],
): PromptCacheToolSnapshot[] {
  const snapshots: PromptCacheToolSnapshot[] = [];
  let descriptionChars = 0;
  const descriptions = new Map<PromptCacheToolSnapshot, string>();
  for (const tool of tools) {
    try {
      const name = tool.name?.trim();
      if (!name) {
        continue;
      }
      const { description, parameters } = tool;
      let schemaDigest: string | undefined;
      if (parameters) {
        schemaDigest =
          getPublishedRuntimeToolInputSchema(parameters)?.canonicalFingerprint ??
          toolSchemaFingerprints.get(parameters);
        if (!schemaDigest) {
          schemaDigest = sha256Hex(stableStringify(parameters));
          toolSchemaFingerprints.set(parameters, schemaDigest);
        }
      }
      const snapshot = {
        name,
        descriptionDigest: description === undefined ? undefined : sha256Hex(description),
        schemaDigest,
      };
      if (
        description !== undefined &&
        descriptionChars + description.length <= MAX_TOOL_FACT_SOURCE_CHARS
      ) {
        descriptionChars += description.length;
        descriptions.set(snapshot, description);
      }
      snapshots.push(snapshot);
    } catch {
      continue;
    }
  }
  const sorted = sortPromptCacheToolsByName(snapshots);
  toolFactSources.set(sorted, descriptions);
  return sorted;
}

// Every session pins its tool block and system prompt on every route. Within one session the
// bytes before the newest message change only at an allowed rebuild point: a model, transport or
// retention change, a declared system-prompt rebuild (compaction, reset, route switch) or a
// declared tool-pin extension. Tests assert this (OPENCLAW_PROMPT_CACHE_ASSERT=1, the test-suite
// default); production warns once per session and component.

export function beginPromptCacheObservation(
  params: PromptCacheIdentity & {
    provider: string;
    modelId: string;
    modelApi?: string | null;
    cacheRetention?: "none" | "short" | "long";
    streamStrategy: string;
    transport?: string;
    systemPrompt: string;
    tools: readonly PromptCacheToolSnapshot[];
    messages: readonly Message[];
    /** Turn attribution for diagnostics, such as the trigger and input provenance. */
    turn?: string;
  },
) {
  const key = buildTrackerKey(params);
  const previous = trackers.get(key);
  const requestedAt = Date.now();
  const tools = sortPromptCacheToolsByName(params.tools);
  const descriptions = toolFactSources.get(params.tools);
  if (descriptions) {
    toolFactSources.set(tools, descriptions);
  }
  const splitSystemPrompt = splitSystemPromptCacheBoundary(params.systemPrompt);
  const prefix = splitSystemPrompt?.stablePrefix ?? params.systemPrompt;
  const systemPromptDigest = sha256Hex(prefix);
  const systemPromptSuffixDigest = splitSystemPrompt
    ? sha256Hex(splitSystemPrompt.dynamicSuffix)
    : undefined;
  const snapshot: PromptCacheSnapshot = {
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    cacheRetention: params.cacheRetention,
    streamStrategy: params.streamStrategy,
    transport: params.transport,
    systemPromptDigest,
    systemPromptSections: fingerprintPromptSections(
      prefix,
      systemPromptDigest,
      previous?.snapshot.systemPromptDigest,
      previous?.snapshot.systemPromptSections,
    ),
    ...(splitSystemPrompt
      ? {
          systemPromptSuffixDigest,
          systemPromptSuffixSections: fingerprintPromptSections(
            splitSystemPrompt.dynamicSuffix,
            systemPromptSuffixDigest!,
            previous?.snapshot.systemPromptSuffixDigest,
            previous?.snapshot.systemPromptSuffixSections,
          ),
        }
      : {}),
    toolDigest: sha256Hex(stableStringify(tools)),
    toolCount: tools.length,
    tools,
  };
  const suffix = splitSystemPrompt?.dynamicSuffix ?? "";
  if (suffix.length <= MAX_PROMPT_FACT_SOURCE_CHARS) {
    const retained =
      previous && previous.snapshot.systemPromptSuffixDigest === systemPromptSuffixDigest
        ? promptFactSources.get(previous.snapshot)
        : undefined;
    // Detach the bounded suffix from a potentially much larger stable-prefix string.
    // UTF-16 preserves exact code units, including unpaired surrogates.
    promptFactSources.set(snapshot, retained ?? Buffer.from(suffix, "utf16le").toString("utf16le"));
  }
  let history = previous?.history ?? [];
  let historyBytes = 0;
  for (let index = 0; index < params.messages.length; index++) {
    const fingerprint = fingerprintMessage(params.messages[index]!, previous?.history[index]);
    historyBytes +=
      256 + 2 * (fingerprint.packed.length + fingerprint.layout.length + fingerprint.role.length);
    if (fingerprint !== history[index]) {
      // Copy before changing the baseline used by divergence diagnostics.
      history = history === previous?.history ? history.slice() : history;
      history[index] = fingerprint;
    }
  }
  if (history.length > params.messages.length) {
    history = history.slice(0, params.messages.length);
  }
  if (history !== previous?.history) {
    // Worker transfer copies layout strings; unchanged histories already share them.
    const layouts = new Map<string, string>();
    for (const fingerprint of history) {
      const shared = layouts.get(fingerprint.layout);
      if (shared !== undefined) {
        fingerprint.layout = shared;
      } else {
        layouts.set(fingerprint.layout, fingerprint.layout);
      }
    }
  }
  // Enforcement compares only this request with the previous one; carried changes stay
  // attribution evidence for a later measured cache drop.
  const immediate = (previous && diffSnapshots(previous.snapshot, snapshot)) || [];
  const changes = previous
    ? [
        ...(previous.unmeasuredChanges ?? []),
        ...(previous.pendingChanges?.filter(
          (change) => change.code === "aggregateToolResultTruncation",
        ) ?? []),
        ...immediate,
      ]
    : [];
  for (const code of previous?.declaredRewrites ?? []) {
    changes.push({ code, detail: `${code} changed provider history` });
  }
  const restarted = immediate.some(
    ({ code }) => code === "model" || code === "transport" || code === "cacheRetention",
  );
  const divergence = previous
    ? previous.history.findIndex((message, index) => message !== history[index])
    : -1;
  const violation =
    divergence < 0 || restarted || previous?.declaredRewrites?.size
      ? undefined
      : {
          code: "historyRewrite" as const,
          detail: `message ${divergence} (${history[divergence]?.role ?? previous!.history[divergence]!.role}) differs from the previous request; history must be append-only; ${describeHistoryChange(previous!.history[divergence]!, history[divergence])}`,
        };
  if (violation) {
    changes.push(violation);
  }
  const pendingChanges = [...new Map(changes.map((change) => [change.code, change])).values()];
  const tracker: PromptCacheTracker = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey?.trim(),
    history,
    historyBytes,
    snapshot,
    lastCacheRead: previous?.lastCacheRead ?? null,
    lastCacheReadSnapshot: previous?.lastCacheReadSnapshot,
    lastProviderPrompt: previous?.lastProviderPrompt,
    requestedAt,
    pendingChanges: pendingChanges.length > 0 ? pendingChanges : null,
  };
  trackers.delete(key);
  trackers.set(key, tracker);
  retainedHistoryBytes += historyBytes - (previous?.historyBytes ?? 0);
  for (const [oldestKey, oldest] of trackers) {
    if (trackers.size <= MAX_TRACKERS && retainedHistoryBytes <= MAX_HISTORY_BYTES) {
      break;
    }
    trackers.delete(oldestKey);
    retainedHistoryBytes -= oldest.historyBytes;
  }
  const prefixChanges = restarted
    ? []
    : immediate.filter(({ code }) =>
        code === "tools"
          ? !previous?.toolPinChanged
          : (code === "systemPrompt" || code === "systemPromptSuffix") &&
            !previous?.systemPromptRebuilt,
      );
  if (process.env.OPENCLAW_PROMPT_CACHE_ASSERT === "1" && (violation || prefixChanges.length)) {
    const detail = [violation, ...prefixChanges]
      .filter((change) => change !== undefined)
      .map((change) => `${change.code}(${change.detail})`)
      .join(", ");
    throw new Error(`[prompt-cache] prefix changed within session: ${detail} ${params.turn ?? ""}`);
  }
  const warningSession = params.sessionKey?.trim() || params.sessionId;
  if (violation) {
    if (!historyRewriteWarnings.check(warningSession)) {
      log.warn(`[prompt-cache] ${violation.detail} sessionKey=${params.sessionKey ?? key}`);
    }
  }
  for (const change of prefixChanges) {
    if (!prefixChangeWarnings.check(`${warningSession}\0${change.code}`)) {
      log.warn(
        `[prompt-cache] prefix changed within session outside a rebuild point: ${change.code}(${change.detail}) sessionKey=${params.sessionKey ?? key}`,
      );
    }
  }
  return {
    snapshot,
    prefixUnchanged: previous !== undefined && divergence < 0,
    changes: tracker.pendingChanges,
    previousCacheRead: previous?.lastCacheRead ?? null,
    requestGapMs: previous ? Math.max(0, requestedAt - previous.requestedAt) : undefined,
  };
}

/** Session projections are shared; each cache-affinity baseline consumes a declaration once. */
function markSessionTrackers(
  params: PromptCacheIdentity,
  mark: (tracker: PromptCacheTracker) => void,
): void {
  for (const tracker of trackers.values()) {
    if (
      tracker.sessionId === params.sessionId &&
      tracker.sessionKey === params.sessionKey?.trim()
    ) {
      mark(tracker);
    }
  }
}

export function declarePromptHistoryRewrite(
  params: PromptCacheIdentity & { reason: PromptHistoryRewriteReason },
): void {
  markSessionTrackers(params, (tracker) => {
    (tracker.declaredRewrites ??= new Set()).add(params.reason);
  });
}

export function declarePromptToolPin(params: PromptCacheIdentity): void {
  markSessionTrackers(params, (tracker) => {
    tracker.toolPinChanged = true;
  });
}

/** The session system-prompt series rebuilt at an allowed point; its next request may differ. */
export function declarePromptSystemPromptRebuild(params: PromptCacheIdentity): void {
  markSessionTrackers(params, (tracker) => {
    tracker.systemPromptRebuilt = true;
  });
}

export function recordAggregateTruncation(params: PromptCacheIdentity): void {
  const tracker = trackers.get(buildTrackerKey(params));
  const changes = tracker?.pendingChanges ?? [];
  if (!tracker || changes.some((change) => change.code === "aggregateToolResultTruncation")) {
    return;
  }
  changes.push({
    code: "aggregateToolResultTruncation",
    detail: "aggregate tool-result truncation changed provider prompt",
  });
  tracker.pendingChanges = changes;
}

function describeDropFacts(
  changes: PromptCacheChange[] | null,
  previous: PromptCacheSnapshot | undefined,
  next: PromptCacheSnapshot,
): PromptCacheChange[] | null {
  if (!previous || !changes) {
    return changes;
  }
  return changes.map((change) => {
    const facts: string[] = [];
    if (change.code === "systemPromptSuffix") {
      const beforeSource = promptFactSources.get(previous);
      const afterSource = promptFactSources.get(next);
      if (beforeSource === undefined || afterSource === undefined) {
        return { ...change, detail: `${change.detail}; facts: unavailable (source size bound)` };
      }
      facts.push(...describePromptCacheSectionChanges(beforeSource, afterSource));
    } else if (change.code === "tools") {
      for (const [index, tool] of next.tools.entries()) {
        const prior = previous.tools.find((candidate) => candidate.name === tool.name);
        if (!prior || prior.descriptionDigest === tool.descriptionDigest) {
          continue;
        }
        const before =
          prior.descriptionDigest === undefined
            ? ""
            : toolFactSources.get(previous.tools)?.get(prior);
        const after =
          tool.descriptionDigest === undefined ? "" : toolFactSources.get(next.tools)?.get(tool);
        const label = tool.name === "computer" ? "computer" : `tool[${index + 1}]`;
        facts.push(
          ...(before === undefined || after === undefined
            ? ["unavailable (source size bound)"]
            : describePromptCacheFactChanges(
                before,
                after,
                tool.name === "computer" ? "computer" : "description",
              )
          ).map((fact) => `${label}.description.${fact} changed`),
        );
        if (facts.length > MAX_NAMED_SECTION_CHANGES) {
          break;
        }
      }
    }
    return facts.length
      ? {
          ...change,
          detail: `${change.detail}; facts: ${facts.slice(0, MAX_NAMED_SECTION_CHANGES).join(", ")}${facts.length > MAX_NAMED_SECTION_CHANGES ? ", remaining" : ""}`,
        }
      : change;
  });
}

export function completePromptCacheObservation(
  params: PromptCacheIdentity & {
    usage?: NormalizedUsage;
    providerPrompt?: ProviderPromptState["lastAttempt"];
  },
) {
  const key = buildTrackerKey(params);
  const tracker = trackers.get(key);
  if (!tracker) {
    return null;
  }
  const changes = tracker.pendingChanges;
  tracker.pendingChanges = null;

  const cacheRead = params.usage?.cacheRead;
  if (params.usage?.cacheTelemetry?.state === "unavailable" || cacheRead === undefined) {
    // Keep cause evidence paired with the last measured cache hit, not a usage-less request.
    tracker.unmeasuredChanges = changes;
    return null;
  }
  tracker.unmeasuredChanges = null;
  const previousCacheRead = tracker.lastCacheRead;
  const previousSnapshot = tracker.lastCacheReadSnapshot;
  const previousProviderPrompt = tracker.lastProviderPrompt;
  tracker.lastCacheRead = cacheRead;
  tracker.lastCacheReadSnapshot = tracker.snapshot;
  tracker.lastProviderPrompt = params.providerPrompt;

  if (previousCacheRead == null || previousCacheRead <= 0) {
    return null;
  }

  const tokenDrop = previousCacheRead - cacheRead;
  const hasMeaningfulDrop =
    cacheRead < previousCacheRead * MAX_STABLE_CACHE_READ_RATIO &&
    tokenDrop >= MIN_CACHE_BREAK_TOKEN_DROP;
  const completeMiss =
    cacheRead === 0 &&
    (params.usage?.input ?? 0) > 0 &&
    previousSnapshot !== undefined &&
    diffSnapshots(previousSnapshot, tracker.snapshot) === null;
  return hasMeaningfulDrop || completeMiss
    ? {
        previousCacheRead,
        cacheRead,
        changes: describeDropFacts(changes, previousSnapshot, tracker.snapshot),
        ...(previousProviderPrompt?.wire || params.providerPrompt?.wire
          ? {
              requests: {
                previous: previousProviderPrompt?.wire,
                current: params.providerPrompt?.wire,
              },
            }
          : {}),
        ...(params.providerPrompt
          ? {
              providerPrefix: describeProviderPrefix(previousProviderPrompt, params.providerPrompt),
            }
          : {}),
      }
    : null;
}
