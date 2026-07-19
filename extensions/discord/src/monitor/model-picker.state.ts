// Discord plugin module implements model picker.state behavior.
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  ModelsProviderData,
  ModelsRuntimeChoice,
} from "openclaw/plugin-sdk/models-provider-runtime";
import { parseStrictInteger, parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { decodeCustomIdComponent, encodeCustomIdComponent } from "../custom-id-codec.js";
import type { ComponentData } from "../internal/discord.js";

export const DISCORD_MODEL_PICKER_CUSTOM_ID_KEY = "mdlpk";
export const DISCORD_MODEL_PICKER_RUNTIME_PAGE_PREV_VALUE = "runtime-page-prev";
export const DISCORD_MODEL_PICKER_RUNTIME_PAGE_NEXT_VALUE = "runtime-page-next";
const DISCORD_CUSTOM_ID_MAX_CHARS = 100;

const DISCORD_COMPONENT_MAX_SELECT_OPTIONS = 25;

const DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;
const DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;

function compareBucketItems(left: string, right: string): number {
  const leftPrefix = firstUnicodeCodePoint(left);
  const rightPrefix = firstUnicodeCodePoint(right);
  if (leftPrefix !== rightPrefix) {
    return leftPrefix < rightPrefix ? -1 : 1;
  }
  const leftRemainder = left.slice(firstUnicodeCodePointLength(left));
  const rightRemainder = right.slice(firstUnicodeCodePointLength(right));
  const normalized = leftRemainder.toLowerCase().localeCompare(rightRemainder.toLowerCase());
  if (normalized !== 0) {
    return normalized;
  }
  if (leftRemainder !== rightRemainder) {
    return leftRemainder < rightRemainder ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function firstUnicodeCodePoint(value: string): string {
  const first = value[Symbol.iterator]().next();
  return first.done ? "" : first.value.toLowerCase();
}

function firstUnicodeCodePointLength(value: string): number {
  const codePoint = value.codePointAt(0);
  return codePoint === undefined ? 0 : codePoint > 0xffff ? 2 : 1;
}

const COMMAND_CONTEXTS = ["model", "models"] as const;
const PICKER_ACTIONS = [
  "open",
  "provider",
  "model",
  "runtime",
  "submit",
  "quick",
  "back",
  "reset",
  "cancel",
  "recents",
  "nav",
  "bucket",
] as const;
const PICKER_VIEWS = ["providers", "models", "recents"] as const;

export type DiscordModelPickerCommandContext = (typeof COMMAND_CONTEXTS)[number];
type DiscordModelPickerAction = (typeof PICKER_ACTIONS)[number];
type DiscordModelPickerView = (typeof PICKER_VIEWS)[number];
export type DiscordModelPickerLayout = "v2" | "classic";

const COMMAND_CONTEXT_CODES = {
  model: "m",
  models: "l",
} as const satisfies Record<DiscordModelPickerCommandContext, string>;
const PICKER_ACTION_CODES = {
  open: "o",
  provider: "p",
  model: "m",
  runtime: "t",
  submit: "s",
  quick: "q",
  back: "b",
  reset: "d",
  cancel: "c",
  recents: "e",
  nav: "n",
  bucket: "k",
} as const satisfies Record<DiscordModelPickerAction, string>;
const PICKER_VIEW_CODES = {
  providers: "p",
  models: "m",
  recents: "r",
} as const satisfies Record<DiscordModelPickerView, string>;

export type DiscordModelPickerState = {
  command: DiscordModelPickerCommandContext;
  action: DiscordModelPickerAction;
  view: DiscordModelPickerView;
  interactionBinding: string;
  provider?: string;
  providerFingerprint?: string;
  runtimeFingerprint?: string;
  runtimePage?: number;
  page: number;
  providerPage?: number;
  modelFingerprint?: string;
  /**
   * Letter-range bucket label (e.g. "a-g") when the provider/model count
   * exceeds {@link DISCORD_MODEL_PICKER_BUCKET_THRESHOLD}. Filters the
   * sorted item list to a single bucket before page-level pagination kicks
   * in. Omitted = "all" / single bucket.
   */
  providerBucket?: string;
  modelBucket?: string;
};

/**
 * Alpha buckets engage only when the sorted item list exceeds the single-page
 * select cap. Below this threshold the user gets the existing flat list +
 * prev/next behavior unchanged.
 */
const DISCORD_MODEL_PICKER_BUCKET_THRESHOLD = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;

/** Target items per alpha bucket. Discord caps selects at 25 options. */
const DISCORD_MODEL_PICKER_BUCKET_TARGET_SIZE = 20;
const DISCORD_MODEL_PICKER_MODEL_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{8}$/u;
const DISCORD_MODEL_PICKER_PROVIDER_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{8}$/u;
const DISCORD_MODEL_PICKER_RUNTIME_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{8}$/u;
const DISCORD_MODEL_PICKER_INTERACTION_BINDING_PATTERN = /^[A-Za-z0-9_-]{12}$/u;
// Picker controls are transient. A process-local key makes their compact route binding
// opaque and invalidates stale controls after restart instead of trusting unsigned ids.
const discordModelPickerBindingSeed = randomBytes(32);

export function createDiscordModelPickerInteractionBinding(params: {
  accountId: string;
  userId: string;
  route: Pick<ResolvedAgentRoute, "agentId" | "sessionKey">;
}): string {
  return createHmac("sha256", discordModelPickerBindingSeed)
    .update(
      JSON.stringify([
        params.accountId.trim(),
        params.userId.trim(),
        params.route.agentId,
        params.route.sessionKey,
      ]),
      "utf8",
    )
    .digest("base64url")
    .slice(0, 12);
}

export function createDiscordModelPickerModelFingerprint(provider: string, model: string): string {
  return createHash("sha256")
    .update(JSON.stringify([normalizeProviderId(provider), model]), "utf8")
    .digest("base64url")
    .slice(0, 8);
}

export function createDiscordModelPickerProviderFingerprint(provider: string): string {
  return createHash("sha256")
    .update(normalizeProviderId(provider), "utf8")
    .digest("base64url")
    .slice(0, 8);
}

export function createDiscordModelPickerRuntimeFingerprint(
  provider: string,
  runtime: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([normalizeProviderId(provider), runtime.trim()]), "utf8")
    .digest("base64url")
    .slice(0, 8);
}

export function getDiscordModelPickerRuntimeChoices(params: {
  data: ModelsProviderData;
  provider: string;
}): ModelsRuntimeChoice[] {
  const choices = params.data.runtimeChoicesByProvider?.get(normalizeProviderId(params.provider));
  if (choices?.length) {
    return choices;
  }
  return [
    {
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    },
  ];
}

export type DiscordModelPickerBucket = {
  /** Stable lowercase id, e.g. "a-g". Used in customId encoding. */
  id: string;
  /** Human label with count, e.g. "A–G (12)". */
  label: string;
  /** Inclusive start index into the sorted item list. */
  start: number;
  /** Exclusive end index into the sorted item list. */
  end: number;
};

export type DiscordModelPickerProviderItem = {
  id: string;
  count: number;
};

export type DiscordModelPickerPage<T> = {
  items: T[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
  hasPrev: boolean;
  hasNext: boolean;
};

export type DiscordModelPickerModelPage = DiscordModelPickerPage<string> & {
  provider: string;
};

const loadModelsProviderRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/models-provider-runtime"),
);

function isValidCommandContext(value: string): value is DiscordModelPickerCommandContext {
  return (COMMAND_CONTEXTS as readonly string[]).includes(value);
}

function isValidPickerAction(value: string): value is DiscordModelPickerAction {
  return (PICKER_ACTIONS as readonly string[]).includes(value);
}

function isValidPickerView(value: string): value is DiscordModelPickerView {
  return (PICKER_VIEWS as readonly string[]).includes(value);
}

function decodeCommandContext(value: string): DiscordModelPickerCommandContext | undefined {
  if (isValidCommandContext(value)) {
    return value;
  }
  return COMMAND_CONTEXTS.find((command) => COMMAND_CONTEXT_CODES[command] === value);
}

function decodePickerAction(value: string): DiscordModelPickerAction | undefined {
  if (isValidPickerAction(value)) {
    return value;
  }
  return PICKER_ACTIONS.find((action) => PICKER_ACTION_CODES[action] === value);
}

function decodePickerView(value: string): DiscordModelPickerView | undefined {
  if (isValidPickerView(value)) {
    return value;
  }
  return PICKER_VIEWS.find((view) => PICKER_VIEW_CODES[view] === value);
}

export function normalizeModelPickerPage(value: number | undefined): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.max(1, Math.floor(numeric));
}

function parseRawPage(value: unknown): number {
  if (typeof value === "number") {
    return normalizeModelPickerPage(value);
  }
  if (typeof value === "string") {
    const parsed = parseStrictInteger(value);
    if (parsed !== undefined) {
      return normalizeModelPickerPage(parsed);
    }
  }
  return 1;
}

function parseRawPositiveInt(value: unknown): number | undefined {
  return parseStrictPositiveInteger(value);
}

function coerceString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function clampPageSize(rawPageSize: number | undefined, max: number, fallback: number): number {
  if (!Number.isFinite(rawPageSize)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(rawPageSize ?? fallback)));
}

function paginateItems<T>(params: {
  items: T[];
  page: number;
  pageSize: number;
}): DiscordModelPickerPage<T> {
  const totalItems = params.items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / params.pageSize));
  const page = Math.max(1, Math.min(params.page, totalPages));
  const startIndex = (page - 1) * params.pageSize;
  const endIndexExclusive = Math.min(totalItems, startIndex + params.pageSize);

  return {
    items: params.items.slice(startIndex, endIndexExclusive),
    page,
    pageSize: params.pageSize,
    totalPages,
    totalItems,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

export async function loadDiscordModelPickerData(
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<ModelsProviderData> {
  const { buildModelsProviderData } = await loadModelsProviderRuntime();
  return buildModelsProviderData(cfg, agentId);
}

export function buildDiscordModelPickerCustomId(params: {
  command: DiscordModelPickerCommandContext;
  action: DiscordModelPickerAction;
  view: DiscordModelPickerView;
  interactionBinding: string;
  provider?: string;
  runtimeFingerprint?: string;
  runtimePage?: number;
  page?: number;
  providerPage?: number;
  modelFingerprint?: string;
  providerBucket?: string;
  modelBucket?: string;
}): string {
  const interactionBinding = params.interactionBinding.trim();
  if (!DISCORD_MODEL_PICKER_INTERACTION_BINDING_PATTERN.test(interactionBinding)) {
    throw new Error("Discord model picker custom_id requires a valid interaction binding");
  }

  const page = normalizeModelPickerPage(params.page);
  const providerPage =
    typeof params.providerPage === "number" && Number.isFinite(params.providerPage)
      ? Math.max(1, Math.floor(params.providerPage))
      : undefined;
  const runtimePage =
    typeof params.runtimePage === "number" && Number.isFinite(params.runtimePage)
      ? Math.max(1, Math.floor(params.runtimePage))
      : undefined;
  const normalizedProvider = params.provider ? normalizeProviderId(params.provider) : undefined;
  const modelFingerprint = params.modelFingerprint?.trim();
  if (modelFingerprint && !DISCORD_MODEL_PICKER_MODEL_FINGERPRINT_PATTERN.test(modelFingerprint)) {
    throw new Error("Discord model picker model fingerprint is invalid");
  }

  const parts = [
    `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:c=${encodeCustomIdComponent(params.command)}`,
    `a=${encodeCustomIdComponent(params.action)}`,
    `v=${encodeCustomIdComponent(params.view)}`,
    `b=${interactionBinding}`,
    `g=${String(page)}`,
  ];
  if (normalizedProvider) {
    parts.push(`p=${encodeCustomIdComponent(normalizedProvider)}`);
  }
  const runtimeFingerprint = params.runtimeFingerprint?.trim();
  if (
    runtimeFingerprint &&
    !DISCORD_MODEL_PICKER_RUNTIME_FINGERPRINT_PATTERN.test(runtimeFingerprint)
  ) {
    throw new Error("Discord model picker runtime fingerprint is invalid");
  }
  if (runtimeFingerprint) {
    parts.push(`rt=${runtimeFingerprint}`);
  }
  if (runtimePage) {
    parts.push(`rp=${String(runtimePage)}`);
  }
  if (providerPage) {
    parts.push(`pp=${String(providerPage)}`);
  }
  if (modelFingerprint) {
    parts.push(`m=${modelFingerprint}`);
  }
  const providerBucket = params.providerBucket;
  if (providerBucket) {
    parts.push(`pb=${encodeCustomIdComponent(providerBucket)}`);
  }
  const modelBucket = params.modelBucket;
  if (modelBucket) {
    parts.push(`mb=${encodeCustomIdComponent(modelBucket)}`);
  }

  const customId = parts.join(";");
  if (customId.length <= DISCORD_CUSTOM_ID_MAX_CHARS) {
    return customId;
  }

  const compactParts = [
    `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:c=${COMMAND_CONTEXT_CODES[params.command]}`,
    `a=${PICKER_ACTION_CODES[params.action]}`,
    `v=${PICKER_VIEW_CODES[params.view]}`,
    `b=${interactionBinding}`,
    `g=${String(page)}`,
  ];
  if (normalizedProvider) {
    compactParts.push(`f=${createDiscordModelPickerProviderFingerprint(normalizedProvider)}`);
  }
  if (runtimeFingerprint) {
    compactParts.push(`r=${runtimeFingerprint}`);
  }
  if (runtimePage) {
    compactParts.push(`j=${String(runtimePage)}`);
  }
  if (providerPage) {
    compactParts.push(`h=${String(providerPage)}`);
  }
  if (modelFingerprint) {
    compactParts.push(`m=${modelFingerprint}`);
  }
  if (providerBucket) {
    compactParts.push(`q=${encodeCustomIdComponent(providerBucket)}`);
  }
  if (modelBucket) {
    compactParts.push(`k=${encodeCustomIdComponent(modelBucket)}`);
  }
  const compactCustomId = compactParts.join(";");
  if (compactCustomId.length > DISCORD_CUSTOM_ID_MAX_CHARS) {
    throw new Error(
      `Discord model picker custom_id exceeds ${DISCORD_CUSTOM_ID_MAX_CHARS} chars (${compactCustomId.length})`,
    );
  }
  return compactCustomId;
}

export function parseDiscordModelPickerData(data: ComponentData): DiscordModelPickerState | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  // Positional model and recents state can silently retarget when catalogs or
  // preferences change. This picker is unshipped, so reject it instead of carrying compat.
  if (data.mi !== undefined || data.rs !== undefined) {
    return null;
  }

  const command = decodeCommandContext(decodeCustomIdComponent(coerceString(data.c ?? data.cmd)));
  const action = decodePickerAction(decodeCustomIdComponent(coerceString(data.a ?? data.act)));
  const view = decodePickerView(decodeCustomIdComponent(coerceString(data.v ?? data.view)));
  const interactionBinding = decodeCustomIdComponent(coerceString(data.b));
  const providerRaw = decodeCustomIdComponent(coerceString(data.p));
  const providerFingerprintRaw = coerceString(data.pf ?? data.f).trim();
  const providerFingerprint = DISCORD_MODEL_PICKER_PROVIDER_FINGERPRINT_PATTERN.test(
    providerFingerprintRaw,
  )
    ? providerFingerprintRaw
    : undefined;
  const runtimeFingerprintRaw = coerceString(data.rt ?? data.r).trim();
  const runtimeFingerprint = DISCORD_MODEL_PICKER_RUNTIME_FINGERPRINT_PATTERN.test(
    runtimeFingerprintRaw,
  )
    ? runtimeFingerprintRaw
    : undefined;
  const runtimePage = parseRawPositiveInt(data.rp ?? data.j);
  const page = parseRawPage(data.g ?? data.pg);
  const providerPage = parseRawPositiveInt(data.pp ?? data.h);
  const modelFingerprintRaw = coerceString(data.m).trim();
  const modelFingerprint = DISCORD_MODEL_PICKER_MODEL_FINGERPRINT_PATTERN.test(modelFingerprintRaw)
    ? modelFingerprintRaw
    : undefined;
  const providerBucketRaw = decodeCustomIdComponent(coerceString(data.pb ?? data.q));
  const modelBucketRaw = decodeCustomIdComponent(coerceString(data.mb ?? data.k));

  if (!command || !action || !view) {
    return null;
  }

  if (!DISCORD_MODEL_PICKER_INTERACTION_BINDING_PATTERN.test(interactionBinding)) {
    return null;
  }

  if (
    (providerFingerprintRaw && !providerFingerprint) ||
    (providerRaw && providerFingerprint) ||
    (coerceString(data.rt ?? data.r) && !runtimeFingerprint) ||
    (coerceString(data.m) && !modelFingerprint)
  ) {
    return null;
  }

  const provider = providerRaw ? normalizeProviderId(providerRaw) : undefined;
  return {
    command,
    action,
    view,
    interactionBinding,
    provider,
    ...(providerFingerprint ? { providerFingerprint } : {}),
    ...(runtimeFingerprint ? { runtimeFingerprint } : {}),
    ...(typeof runtimePage === "number" ? { runtimePage } : {}),
    page,
    ...(typeof providerPage === "number" ? { providerPage } : {}),
    ...(modelFingerprint ? { modelFingerprint } : {}),
    ...(providerBucketRaw ? { providerBucket: providerBucketRaw } : {}),
    ...(modelBucketRaw ? { modelBucket: modelBucketRaw } : {}),
  };
}

/**
 * Split a sorted item list into letter-range buckets when its length exceeds
 * {@link DISCORD_MODEL_PICKER_BUCKET_THRESHOLD}. Items below the threshold
 * return a single "All" bucket so callers can render the same code path.
 *
 * The boundary extender keeps items sharing the same starting letter inside
 * the same bucket — selecting "A–G" never strands a stray "g" item in the
 * next bucket. If every item shares a first letter (e.g. all `qwen3-*`),
 * the function falls back to count-based numeric chunks so the user still
 * gets a finite-cardinality picker.
 */
function computeAlphaBuckets(sortedItems: string[]): DiscordModelPickerBucket[] {
  if (sortedItems.length === 0) {
    return [];
  }
  if (sortedItems.length <= DISCORD_MODEL_PICKER_BUCKET_THRESHOLD) {
    return [
      {
        id: "all",
        label: `All (${sortedItems.length})`,
        start: 0,
        end: sortedItems.length,
      },
    ];
  }

  // String iteration preserves one complete Unicode code point. charAt(0)
  // would split emoji/non-BMP prefixes into lone surrogate bucket ids.
  const firstLetter = firstUnicodeCodePoint;
  const firstItem = expectDefined(sortedItems.at(0), "non-empty sorted model picker items");
  const allSamePrefix = sortedItems.every((item) => firstLetter(item) === firstLetter(firstItem));
  if (allSamePrefix) {
    return chunkBucketsByCount(sortedItems);
  }

  const buckets: DiscordModelPickerBucket[] = [];
  // Cap bucket count at the Discord select-option limit. Without this a very
  // large list (e.g. 600+ diverse items) would yield >25 buckets and the
  // bucket select itself would exceed Discord's hard 25-option cap. The
  // letter-boundary extender below can only grow buckets (never split
  // letter groups), so sizing the base target to a 25-bucket ceiling
  // remains safe even after extension.
  const target = computeBucketTargetSize(sortedItems.length);
  let start = 0;
  while (start < sortedItems.length) {
    let end = Math.min(sortedItems.length, start + target);
    // Extend `end` so we don't split a letter group across two buckets.
    if (end < sortedItems.length) {
      const last = firstLetter(expectDefined(sortedItems[end - 1], "bucket end predecessor"));
      while (
        end < sortedItems.length &&
        firstLetter(expectDefined(sortedItems[end], "bucket extension index")) === last
      ) {
        end += 1;
      }
    }
    const startLetter = firstLetter(expectDefined(sortedItems[start], "bucket start index"));
    const endLetter = firstLetter(expectDefined(sortedItems[end - 1], "bucket end predecessor"));
    const id = startLetter === endLetter ? startLetter : `${startLetter}-${endLetter}`;
    const label =
      startLetter === endLetter
        ? `${startLetter.toUpperCase()} (${end - start})`
        : `${startLetter.toUpperCase()}–${endLetter.toUpperCase()} (${end - start})`;
    buckets.push({ id, label, start, end });
    start = end;
  }
  return buckets;
}

/**
 * Pick the per-bucket target size such that the resulting bucket count never
 * exceeds {@link DISCORD_COMPONENT_MAX_SELECT_OPTIONS} (Discord's hard select
 * cap). Stays at the default {@link DISCORD_MODEL_PICKER_BUCKET_TARGET_SIZE}
 * for typical inputs and grows linearly for very large lists.
 */
function computeBucketTargetSize(totalItems: number): number {
  const minTarget = DISCORD_MODEL_PICKER_BUCKET_TARGET_SIZE;
  const capByBucketCount = Math.ceil(totalItems / DISCORD_COMPONENT_MAX_SELECT_OPTIONS);
  return Math.max(minTarget, capByBucketCount);
}

function chunkBucketsByCount(sortedItems: string[]): DiscordModelPickerBucket[] {
  const buckets: DiscordModelPickerBucket[] = [];
  const target = computeBucketTargetSize(sortedItems.length);
  for (let start = 0; start < sortedItems.length; start += target) {
    const end = Math.min(sortedItems.length, start + target);
    buckets.push({
      id: `${start + 1}-${end}`,
      label: `${start + 1}–${end} (${end - start})`,
      start,
      end,
    });
  }
  return buckets;
}

/**
 * Resolve a bucket from a list given a (possibly user-supplied) bucket id.
 * Falls back to the first bucket when the id does not match — mirrors the
 * "bad customId → reset to defaults" semantics already used for other
 * state fields.
 */
function resolveBucket(
  buckets: DiscordModelPickerBucket[],
  id: string | undefined,
): DiscordModelPickerBucket | null {
  if (buckets.length === 0) {
    return null;
  }
  if (!id) {
    return expectDefined(buckets.at(0), "non-empty model picker buckets");
  }
  return (
    buckets.find((bucket) => bucket.id === id) ??
    expectDefined(buckets.at(0), "non-empty model picker buckets")
  );
}

/**
 * Derive the alpha-bucket id that contains a given provider id. Returns
 * `undefined` when bucketing is inactive (all providers fit in one bucket)
 * or the provider is unknown. Used by the interaction handler to recompute
 * `providerBucket` at re-render time without forcing every customId to
 * carry the bucket field — the bucket is a pure function of the provider
 * list + provider id.
 */
export function findProviderBucketId(
  data: ModelsProviderData,
  provider: string,
): string | undefined {
  return findProviderBucketLocation(data, provider)?.bucket;
}

export function findProviderBucketLocation(
  data: ModelsProviderData,
  provider: string,
): { bucket?: string; page: number } | undefined {
  const normalized = normalizeProviderId(provider);
  const sorted = [...data.providers].toSorted(compareBucketItems);
  const idx = sorted.indexOf(normalized);
  if (idx < 0) {
    return undefined;
  }
  const buckets = computeAlphaBuckets(sorted);
  const containing = buckets.find((bucket) => idx >= bucket.start && idx < bucket.end);
  if (!containing) {
    return undefined;
  }
  const page = Math.floor((idx - containing.start) / DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE) + 1;
  return {
    ...(containing.id !== "all" ? { bucket: containing.id } : {}),
    page,
  };
}

/**
 * Derive the alpha-bucket id that contains a given model id within the
 * named provider. Same rationale as {@link findProviderBucketId} — saves
 * customId budget by recomputing the bucket from the durable state
 * (provider + model) rather than carrying it as a parameter.
 */
export function findModelBucketId(
  data: ModelsProviderData,
  provider: string,
  model: string,
): string | undefined {
  const modelSet = data.byProvider.get(normalizeProviderId(provider));
  if (!modelSet) {
    return undefined;
  }
  const sorted = [...modelSet].toSorted(compareBucketItems);
  const idx = sorted.indexOf(model);
  if (idx < 0) {
    return undefined;
  }
  const buckets = computeAlphaBuckets(sorted);
  const containing = buckets.find((bucket) => idx >= bucket.start && idx < bucket.end);
  return containing && containing.id !== "all" ? containing.id : undefined;
}

function buildDiscordModelPickerProviderItems(
  data: ModelsProviderData,
): DiscordModelPickerProviderItem[] {
  // Keep every normalized first-code-point group contiguous so bucket ids
  // remain unique even when locale collation interleaves accented prefixes.
  return [...data.providers].toSorted(compareBucketItems).map((provider) => ({
    id: provider,
    count: data.byProvider.get(provider)?.size ?? 0,
  }));
}

export function getDiscordModelPickerProviderPage(params: {
  data: ModelsProviderData;
  page?: number;
  pageSize?: number;
  bucket?: string;
}): DiscordModelPickerPage<DiscordModelPickerProviderItem> & {
  bucket: DiscordModelPickerBucket | null;
  buckets: DiscordModelPickerBucket[];
} {
  const allItems = buildDiscordModelPickerProviderItems(params.data);
  const buckets = computeAlphaBuckets(allItems.map((item) => item.id));
  const bucket = resolveBucket(buckets, params.bucket);
  const bucketItems = bucket ? allItems.slice(bucket.start, bucket.end) : allItems;

  const pageSize = clampPageSize(
    params.pageSize,
    DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE,
    DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE,
  );
  const page = paginateItems({
    items: bucketItems,
    page: normalizeModelPickerPage(params.page),
    pageSize,
  });
  return { ...page, bucket, buckets };
}

export function getDiscordModelPickerModelPage(params: {
  data: ModelsProviderData;
  provider: string;
  page?: number;
  pageSize?: number;
  bucket?: string;
}):
  | (DiscordModelPickerModelPage & {
      bucket: DiscordModelPickerBucket | null;
      buckets: DiscordModelPickerBucket[];
    })
  | null {
  const provider = normalizeProviderId(params.provider);
  const modelSet = params.data.byProvider.get(provider);
  if (!modelSet) {
    return null;
  }

  const allModels = [...modelSet].toSorted(compareBucketItems);
  const buckets = computeAlphaBuckets(allModels);
  const bucket = resolveBucket(buckets, params.bucket);
  const bucketItems = bucket ? allModels.slice(bucket.start, bucket.end) : allModels;

  const pageSize = clampPageSize(
    params.pageSize,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
  );
  const page = paginateItems({
    items: bucketItems,
    page: normalizeModelPickerPage(params.page),
    pageSize,
  });

  return {
    ...page,
    provider,
    bucket,
    buckets,
  };
}

export function resolveDiscordModelPickerPageForModel(params: {
  data: ModelsProviderData;
  provider: string;
  model: string;
  pageSize?: number;
}): { page: number; bucket?: string } {
  const provider = normalizeProviderId(params.provider);
  const modelSet = params.data.byProvider.get(provider);
  if (!modelSet) {
    return { page: 1 };
  }
  const sorted = [...modelSet].toSorted(compareBucketItems);
  const index = sorted.indexOf(params.model);
  if (index < 0) {
    return { page: 1 };
  }
  const pageSize = clampPageSize(
    params.pageSize,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
  );
  const buckets = computeAlphaBuckets(sorted);
  const containingBucket = buckets.find((bucket) => index >= bucket.start && index < bucket.end);
  if (!containingBucket) {
    return { page: Math.floor(index / pageSize) + 1 };
  }
  const offsetInBucket = index - containingBucket.start;
  return {
    page: Math.floor(offsetInBucket / pageSize) + 1,
    bucket: containingBucket.id === "all" ? undefined : containingBucket.id,
  };
}
