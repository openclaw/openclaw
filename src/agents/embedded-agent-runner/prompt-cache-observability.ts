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
import type { ProviderPromptCachePrefix } from "./provider-prompt-serialization.js";
import type { ProviderPromptState } from "./provider-prompt-state.js";

type PromptHistoryRewriteReason = "compaction" | "pruning" | "runtimeContextCarrier";
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

const PROMPT_SECTION_NAMES = [
  "Skills",
  "Tooling",
  "Project Context",
  "Memory Recall",
  "Temporal Context",
  "Runtime",
  "Runtime Context",
  "Conversation Context",
  "Subagent Context",
  "Model Aliases",
  "Other",
] as const;
type PromptSectionName = (typeof PROMPT_SECTION_NAMES)[number];
type PromptSectionDigests = Partial<Record<PromptSectionName, string>>;
const promptSectionHeadings = new Map<string, PromptSectionName>(
  PROMPT_SECTION_NAMES.map((name) => [`${name === "Project Context" ? "#" : "##"} ${name}`, name]),
);

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
  declaredRewrites?: Set<PromptHistoryRewriteReason>;
  snapshot: PromptCacheSnapshot;
  lastCacheRead: number | null;
  /** Missing usage must not bind an older hit to a new request fingerprint. */
  lastCacheReadSnapshot?: PromptCacheSnapshot;
  lastProviderPrompt?: ProviderPromptState["lastAttempt"];
  requestedAt: number;
  pendingChanges: PromptCacheChange[] | null;
  unmeasuredChanges?: PromptCacheChange[] | null;
};

type PromptHistoryFingerprint = {
  digest: string;
  role: string;
  envelopeFields: Map<string, string>;
  contentDigest: string;
  contentKind: "string" | "blocks";
  blockCount: number;
  blocks: string[];
  remainingBlocksDigest?: string;
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
const MAX_HISTORY_DIFF_FIELDS = 8;
// Only these static names may enter diagnostics; extension keys can contain user data.
const HISTORY_ENVELOPE_FIELDS = new Set([
  "role",
  "timestamp",
  "idempotencyKey",
  "__openclaw",
  "usage",
  "api",
  "provider",
  "model",
  "stopReason",
  "errorMessage",
  "toolCallId",
  "toolName",
  "isError",
  "runtimeContext",
  "runtimeContextCarrier",
  "operatorMessage",
]);

function fingerprintEnvelope(envelope: object): Map<string, string> {
  const fields = new Map<string, string>();
  const other: [string, unknown][] = [];
  for (const [key, value] of Object.entries(envelope)) {
    if (HISTORY_ENVELOPE_FIELDS.has(key)) {
      fields.set(key, sha256Hex(stableStringify({ [key]: value })));
    } else {
      other.push([key, value]);
    }
  }
  if (other.length) {
    fields.set("other", sha256Hex(stableStringify(Object.fromEntries(other))));
  }
  return fields;
}

function describeHistoryChange(
  previous: PromptHistoryFingerprint,
  next: PromptHistoryFingerprint | undefined,
): string {
  if (!next) {
    return "message removed";
  }
  const fields: string[] = [];
  if (previous.contentKind !== next.contentKind) {
    fields.push("content.type");
  }
  if (previous.contentDigest !== next.contentDigest) {
    if (previous.contentKind === "string" || next.contentKind === "string") {
      fields.push("content");
    } else {
      if (previous.blockCount !== next.blockCount) {
        fields.push("content.length");
      }
      for (let index = 0; index < Math.max(previous.blocks.length, next.blocks.length); index++) {
        if (previous.blocks[index] !== next.blocks[index]) {
          fields.push(`content[${index}]`);
        }
      }
      if (previous.remainingBlocksDigest !== next.remainingBlocksDigest) {
        fields.push("content[remaining]");
      }
    }
  }
  for (const key of new Set([...previous.envelopeFields.keys(), ...next.envelopeFields.keys()])) {
    if (previous.envelopeFields.get(key) !== next.envelopeFields.get(key)) {
      fields.push(`envelope.${key}`);
    }
  }
  return `changed fields: ${fields.slice(0, MAX_HISTORY_DIFF_FIELDS).join(", ")}${fields.length > MAX_HISTORY_DIFF_FIELDS ? ", …" : ""}`;
}

function fingerprintBlock(block: object): string {
  const primitives: [string, unknown][] = [];
  const nested: [string, unknown][] = [];
  for (const entry of Object.entries(block)) {
    const value = entry[1];
    const primitive =
      value === null || ["string", "number", "boolean", "undefined"].includes(typeof value);
    (primitive ? primitives : nested).push(entry);
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
  const envelopeFields = fingerprintEnvelope(envelope);
  const contentDigest = sha256Hex(stableStringify(blocks));
  return {
    digest: sha256Hex(stableStringify([Object.fromEntries(envelopeFields), contentDigest])),
    role: message.role,
    envelopeFields,
    contentDigest,
    contentKind: typeof content === "string" ? "string" : "blocks",
    blockCount: blocks.length,
    blocks: blocks.slice(0, MAX_HISTORY_DIFF_FIELDS),
    ...(blocks.length > MAX_HISTORY_DIFF_FIELDS
      ? { remainingBlocksDigest: sha256Hex(stableStringify(blocks.slice(MAX_HISTORY_DIFF_FIELDS))) }
      : {}),
    stringBlock,
  };
}

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
  before: ProviderPromptCachePrefix["parameters"],
  after: ProviderPromptCachePrefix["parameters"] | undefined,
): string {
  if (!after) {
    return "removed";
  }
  const beforeFields = before.fields ?? {};
  const afterFields = after.fields ?? {};
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
  const index = before.messages.findIndex((item, i) => item.digest !== after.messages[i]?.digest);
  let prefix = segment ?? (continuation ? "wire-prefix-match" : "prefix-match");
  if (!segment && index >= 0) {
    const item = before.messages[index]!;
    const fields = item.fields ? `.${describeProviderFields(item, after.messages[index])}` : "";
    prefix = `${continuation ? "wire-input" : "message"}:${index}${fields}`;
  } else if (!segment && before.tail !== undefined) {
    // A growing tail cannot establish equality of its earlier messages from one digest.
    prefix =
      before.messageCount !== after.messageCount
        ? `unverified-after:${before.messages.length}`
        : before.tail !== after.tail
          ? `message-tail:${before.messages.length}`
          : prefix;
  }
  const parameters =
    before.parameters.digest !== after.parameters.digest
      ? `parameters:${describeProviderFields(before.parameters, after.parameters)}`
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

function describeToolChanges(previous: PromptCacheSnapshot, next: PromptCacheSnapshot): string {
  const before = new Map(previous.tools.map((tool) => [tool.name, tool]));
  const after = new Map(next.tools.map((tool) => [tool.name, tool]));
  const changed: Record<"added" | "removed" | "description" | "schema", string[]> = {
    added: [],
    removed: [],
    description: [],
    schema: [],
  };
  for (const tool of next.tools) {
    const prior = before.get(tool.name);
    if (!prior) {
      changed.added.push(tool.name);
    } else {
      if (prior.descriptionDigest !== tool.descriptionDigest) {
        changed.description.push(tool.name);
      }
      if (prior.schemaDigest !== tool.schemaDigest) {
        changed.schema.push(tool.name);
      }
    }
  }
  for (const tool of previous.tools) {
    if (!after.has(tool.name)) {
      changed.removed.push(tool.name);
    }
  }
  const details = [`${previous.toolCount} -> ${next.toolCount} tools`];
  for (const [kind, names] of Object.entries(changed)) {
    if (names.length > 0) {
      const sample = names
        .slice(0, 5)
        .map((name) => JSON.stringify(name.slice(0, 80)))
        .join(", ");
      details.push(`${kind}: ${sample}${names.length > 5 ? ` (+${names.length - 5} more)` : ""}`);
    }
  }
  return details.join("; ");
}

function fingerprintPromptSections(
  prompt: string,
  digest: string,
  previousDigest?: string,
  previousSections?: PromptSectionDigests,
): PromptSectionDigests | undefined {
  if (digest === previousDigest) {
    return previousSections;
  }
  if (!/^#{1,2} /m.test(prompt)) {
    return undefined;
  }
  const sections: PromptSectionDigests = {};
  let name: PromptSectionName = "Other";
  let start = 0;
  const append = (end: number) => {
    if (end > start) {
      sections[name] = sha256Hex(`${sections[name] ?? ""}${prompt.slice(start, end)}`);
    }
  };
  for (const heading of prompt.matchAll(/^#{1,2} [^\n]*(?:\n|$)/gm)) {
    append(heading.index);
    start = heading.index;
    name = promptSectionHeadings.get(heading[0].trimEnd()) ?? "Other";
    // Injected files own the rest of the stable prefix, including their headings.
    if (name === "Project Context") {
      break;
    }
  }
  append(prompt.length);
  return sections;
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
      const changed = PROMPT_SECTION_NAMES.filter((name) => before?.[name] !== after?.[name]);
      changes.push({
        code,
        detail:
          before || after
            ? `${detail} (sections: ${changed.length ? changed.join(", ") : "Other"})`
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
  const previous = trackers.get(key);
  const requestedAt = Date.now();
  const tools = sortPromptCacheToolsByName(params.tools);
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
  const history = params.messages.map((message, index) =>
    fingerprintMessage(message, previous?.history[index]),
  );
  const changes = previous
    ? [
        ...(previous.unmeasuredChanges ?? []),
        ...(previous.pendingChanges?.filter(
          (change) => change.code === "aggregateToolResultTruncation",
        ) ?? []),
        ...(diffSnapshots(previous.snapshot, snapshot) ?? []),
      ]
    : [];
  for (const code of previous?.declaredRewrites ?? []) {
    changes.push({ code, detail: `${code} changed provider history` });
  }
  const restarted = changes.some(
    ({ code }) => code === "model" || code === "transport" || code === "cacheRetention",
  );
  const divergence = previous
    ? previous.history.findIndex((message, index) => message.digest !== history[index]?.digest)
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
    snapshot,
    lastCacheRead: previous?.lastCacheRead ?? null,
    lastCacheReadSnapshot: previous?.lastCacheReadSnapshot,
    lastProviderPrompt: previous?.lastProviderPrompt,
    requestedAt,
    pendingChanges: pendingChanges.length > 0 ? pendingChanges : null,
  };
  trackers.delete(key);
  pruneMapToMaxSize(trackers, MAX_TRACKERS - 1);
  trackers.set(key, tracker);
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
    prefixUnchanged: previous !== undefined && divergence < 0,
    changes: tracker.pendingChanges,
    previousCacheRead: previous?.lastCacheRead ?? null,
    requestGapMs: previous ? Math.max(0, requestedAt - previous.requestedAt) : undefined,
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
  if (
    params.usage?.cacheTelemetry?.state === "unavailable" ||
    typeof cacheRead !== "number" ||
    !Number.isFinite(cacheRead)
  ) {
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
        changes,
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
