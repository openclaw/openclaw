import {
  sortPromptCacheToolsByName,
  splitSystemPromptCacheBoundary,
} from "@openclaw/ai/internal/shared";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { ContextEnginePromptCacheObservationChange as PromptCacheChange } from "../../context-engine/types.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { Message } from "../../llm/types.js";
import type { NormalizedUsage } from "../usage.js";
import { log } from "./logger.js";

type PromptHistoryRewriteReason =
  | "compaction"
  | "pruning"
  | "runtimeContextCarrier"
  | "imageCleanup";
type PromptCacheIdentity = { sessionId: string; promptCacheKey?: string; sessionKey?: string };

export type { PromptCacheChange };

type PromptCacheToolSnapshot = {
  name: string;
  descriptionDigest?: string;
  schemaDigest?: string;
};

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
  /** Digest of the volatile suffix below the cache boundary; undefined when the prompt has none. */
  systemPromptSuffixDigest?: string;
  toolDigest: string;
  toolCount: number;
  toolNames: string[];
  toolFingerprints: PromptCacheToolSnapshot[];
};

type PromptCacheTracker = {
  sessionId: string;
  sessionKey?: string;
  history: PromptHistoryFingerprint[];
  declaredRewrites?: Set<PromptHistoryRewriteReason>;
  snapshot: PromptCacheSnapshot;
  lastCacheRead: number | null;
  /** Missing usage must not bind an older hit to a new request fingerprint. */
  lastCacheReadSnapshot?: PromptCacheSnapshot;
  pendingChanges: PromptCacheChange[] | null;
};

type PromptHistoryFingerprint = {
  digest: string;
  role: string;
  stringBlock?: WeakRef<PromptStringFingerprint>;
};

type PromptStringFingerprint = { value: string; digest: string };

const trackers = new Map<string, PromptCacheTracker>();
const stringFingerprints = new WeakMap<Message, PromptStringFingerprint>();
const blockFingerprints = new WeakMap<
  object,
  { digest: string; primitives: [string, unknown][] }
>();
// Schemas are provider-owned declarations; unlike transcript blocks, they do not mutate in place.
const toolSchemaFingerprints = new WeakMap<object, string>();
const MAX_TRACKERS = 512;
const historyRewriteWarnings = createDedupeCache({ ttlMs: 0, maxSize: MAX_TRACKERS });

function fingerprintBlock(block: object): string {
  const primitives: [string, unknown][] = [];
  const nested: [string, unknown][] = [];
  for (const entry of Object.entries(block)) {
    const value = entry[1];
    if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) {
      primitives.push(entry);
    } else {
      nested.push(entry);
    }
  }
  const previous = blockFingerprints.get(block);
  const unchanged =
    previous &&
    previous.primitives.length === primitives.length &&
    primitives.every(([key, value], index) => {
      const cached = previous.primitives[index];
      return cached?.[0] === key && cached[1] === value;
    });
  const memo = unchanged
    ? previous
    : { digest: sha256Hex(stableStringify(Object.fromEntries(primitives))), primitives };
  if (!unchanged) {
    blockFingerprints.set(block, memo);
  }
  return nested.length
    ? sha256Hex(`${memo.digest}:${stableStringify(Object.fromEntries(nested))}`)
    : memo.digest;
}

function fingerprintMessage(
  message: Message,
  previous?: PromptHistoryFingerprint,
): PromptHistoryFingerprint {
  const { content, ...envelope } = message;
  let stringBlock: PromptHistoryFingerprint["stringBlock"];
  let blocks: string[];
  if (typeof content === "string") {
    // Transcript messages own text memos; diagnostics retain only weak references.
    const previousMemo = previous?.stringBlock?.deref() ?? stringFingerprints.get(message);
    const memo =
      previousMemo?.value === content
        ? previousMemo
        : { value: content, digest: sha256Hex(stableStringify(content)) };
    stringFingerprints.set(message, memo);
    stringBlock = new WeakRef(memo);
    blocks = [memo.digest];
  } else {
    stringFingerprints.delete(message);
    blocks = content.map(fingerprintBlock);
  }
  return {
    digest: sha256Hex(stableStringify([envelope, blocks])),
    role: message.role,
    stringBlock,
  };
}

const MIN_CACHE_BREAK_TOKEN_DROP = 1_000;
const MAX_STABLE_CACHE_READ_RATIO = 0.95;

function buildTrackerKey(params: PromptCacheIdentity): string {
  return params.promptCacheKey?.trim() || params.sessionKey?.trim() || params.sessionId;
}

function setTracker(key: string, tracker: PromptCacheTracker): void {
  trackers.delete(key);
  pruneMapToMaxSize(trackers, MAX_TRACKERS - 1);
  trackers.set(key, tracker);
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
      changes.push({ code, detail });
    }
  }
  if (previous.toolDigest !== next.toolDigest) {
    changes.push({
      code: "tools",
      detail:
        previous.toolCount === next.toolCount
          ? "tool set changed with same count"
          : `${previous.toolCount} -> ${next.toolCount} tools`,
    });
  }
  return changes.length > 0 ? changes : null;
}

export function collectPromptCacheTools(
  tools: readonly PromptCacheToolDescriptor[],
): PromptCacheToolSnapshot[] {
  const snapshots: PromptCacheToolSnapshot[] = [];
  for (const tool of tools) {
    try {
      const name = tool.name?.trim();
      if (!name) {
        continue;
      }
      const { description, parameters } = tool;
      let schemaDigest: string | undefined;
      if (parameters) {
        schemaDigest = toolSchemaFingerprints.get(parameters);
        if (!schemaDigest) {
          schemaDigest = sha256Hex(stableStringify(parameters));
          toolSchemaFingerprints.set(parameters, schemaDigest);
        }
      }
      snapshots.push({
        name,
        descriptionDigest: description === undefined ? undefined : sha256Hex(description),
        schemaDigest,
      });
    } catch {
      continue;
    }
  }
  return sortPromptCacheToolsByName(snapshots);
}

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
  },
) {
  const key = buildTrackerKey(params);
  const tools = sortPromptCacheToolsByName(params.tools);
  const splitSystemPrompt = splitSystemPromptCacheBoundary(params.systemPrompt);
  const snapshot: PromptCacheSnapshot = {
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    cacheRetention: params.cacheRetention,
    streamStrategy: params.streamStrategy,
    transport: params.transport,
    systemPromptDigest: sha256Hex(splitSystemPrompt?.stablePrefix ?? params.systemPrompt),
    ...(splitSystemPrompt
      ? { systemPromptSuffixDigest: sha256Hex(splitSystemPrompt.dynamicSuffix) }
      : {}),
    toolDigest: sha256Hex(stableStringify(tools)),
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.name),
    toolFingerprints: tools.map(({ name, descriptionDigest, schemaDigest }) => ({
      name,
      descriptionDigest,
      schemaDigest,
    })),
  };
  const previous = trackers.get(key);
  const history = params.messages.map((message, index) =>
    fingerprintMessage(message, previous?.history[index]),
  );
  const changes = previous
    ? [
        ...(previous.pendingChanges?.filter(
          (change) => change.code === "aggregateToolResultTruncation",
        ) ?? []),
        ...(diffSnapshots(previous.snapshot, snapshot) ?? []),
      ]
    : [];
  for (const code of previous?.declaredRewrites ?? []) {
    changes.push({ code, detail: `${code} changed provider history` });
  }
  const restarted =
    previous?.sessionId !== params.sessionId ||
    changes.some(
      ({ code }) => code === "model" || code === "transport" || code === "cacheRetention",
    );
  const divergence =
    previous && !restarted && !previous.declaredRewrites?.size
      ? previous.history.findIndex((message, index) => message.digest !== history[index]?.digest)
      : -1;
  const violation =
    divergence < 0
      ? undefined
      : {
          code: "historyRewrite" as const,
          detail: `message ${divergence} (${history[divergence]?.role ?? previous!.history[divergence]!.role}) differs from the previous request; history must be append-only`,
        };
  if (violation) {
    changes.push(violation);
  }
  setTracker(key, {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey?.trim(),
    history,
    snapshot,
    lastCacheRead: previous?.lastCacheRead ?? null,
    lastCacheReadSnapshot: previous?.lastCacheReadSnapshot,
    pendingChanges: changes.length > 0 ? changes : null,
  });
  if (violation) {
    if (process.env.OPENCLAW_PROMPT_CACHE_ASSERT === "1") {
      throw new Error(violation.detail);
    }
    if (!historyRewriteWarnings.check(params.sessionKey?.trim() || params.sessionId)) {
      log.warn(`[prompt-cache] ${violation.detail} sessionKey=${params.sessionKey ?? key}`);
    }
  }
  return {
    snapshot,
    changes: changes.length > 0 ? changes : null,
    previousCacheRead: previous?.lastCacheRead ?? null,
  };
}

export function declarePromptHistoryRewrite(
  params: PromptCacheIdentity & { reason: PromptHistoryRewriteReason },
): void {
  // Session projections are shared; each cache-affinity baseline consumes the rewrite once.
  for (const tracker of trackers.values()) {
    if (
      tracker.sessionId === params.sessionId &&
      tracker.sessionKey === params.sessionKey?.trim()
    ) {
      (tracker.declaredRewrites ??= new Set()).add(params.reason);
    }
  }
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

export function completePromptCacheObservation(
  params: PromptCacheIdentity & {
    usage?: NormalizedUsage;
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
  if (typeof cacheRead !== "number" || !Number.isFinite(cacheRead)) {
    return null;
  }
  const previousCacheRead = tracker.lastCacheRead;
  const previousSnapshot = tracker.lastCacheReadSnapshot;
  tracker.lastCacheRead = cacheRead;
  tracker.lastCacheReadSnapshot = tracker.snapshot;

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
        changes,
      }
    : null;
}
