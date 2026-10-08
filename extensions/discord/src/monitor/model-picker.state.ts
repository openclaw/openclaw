import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { parseStrictInteger, parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { decodeCustomIdComponent, encodeCustomIdComponent } from "../custom-id-codec.js";
import type { ComponentData } from "../internal/discord.js";

export const DISCORD_MODEL_PICKER_CUSTOM_ID_KEY = "mdlpk";
const DISCORD_CUSTOM_ID_MAX_CHARS = 100;

const DISCORD_COMPONENT_MAX_SELECT_OPTIONS = 25;

function compareBucketItems(left: string, right: string): number {
  const normalized = left.toLowerCase().localeCompare(right.toLowerCase());
  return normalized === 0 ? left.localeCompare(right) : normalized;
}

const COMMAND_CONTEXTS = ["model", "models"] as const;
const PICKER_ACTIONS = [
  "open",
  "provider",
  "model",
  // Token-valued model selects use a distinct action from legacy raw-value menus.
  "pick",
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

export type DiscordModelPickerState = {
  command: DiscordModelPickerCommandContext;
  action: DiscordModelPickerAction;
  view: DiscordModelPickerView;
  userId: string;
  provider?: string;
  runtime?: string;
  runtimeIndex?: number;
  runtimeToken?: string;
  page: number;
  providerPage?: number;
  modelIndex?: number;
  modelToken?: string;
  recentSlot?: number;
  /** Letter-range bucket id; omitted when all items fit in one bucket. */
  providerBucket?: string;
  modelBucket?: string;
};

const DISCORD_MODEL_PICKER_BUCKET_THRESHOLD = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;

/** Target items per alpha bucket. Discord caps selects at 25 options. */
const DISCORD_MODEL_PICKER_BUCKET_TARGET_SIZE = 20;
const DISCORD_MODEL_PICKER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8}$/u;

export function createDiscordModelPickerModelToken(provider: string, model: string): string {
  return createHash("sha256")
    .update(JSON.stringify([normalizeProviderId(provider), model]), "utf8")
    .digest("base64url")
    .slice(0, 8);
}

export function createDiscordModelPickerRuntimeToken(runtime: string): string {
  return createHash("sha256").update(runtime, "utf8").digest("base64url").slice(0, 8);
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

type DiscordModelPickerBucketPage<T> = DiscordModelPickerPage<T> & {
  bucket: DiscordModelPickerBucket | null;
  buckets: DiscordModelPickerBucket[];
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

export function normalizeModelPickerPage(value: number | undefined): number {
  return normalizeOptionalModelPickerIndex(value) ?? 1;
}

function parseRawPage(value: unknown): number {
  return normalizeModelPickerPage(
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseStrictInteger(value)
        : undefined,
  );
}

function coerceString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function normalizeOptionalModelPickerIndex(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : undefined;
}

export async function loadDiscordModelPickerData(
  cfg: OpenClawConfig,
  agentId?: string,
  options?: Parameters<
    typeof import("openclaw/plugin-sdk/models-provider-runtime").buildPreparedModelsProviderData
  >[2],
): ReturnType<
  typeof import("openclaw/plugin-sdk/models-provider-runtime").buildPreparedModelsProviderData
> {
  const { buildPreparedModelsProviderData } = await loadModelsProviderRuntime();
  return buildPreparedModelsProviderData(cfg, agentId, options);
}

export function buildDiscordModelPickerCustomId(
  params: Omit<DiscordModelPickerState, "page"> & { page?: number },
): string {
  const userId = params.userId.trim();
  if (!userId) {
    throw new Error("Discord model picker custom_id requires userId");
  }

  const page = normalizeModelPickerPage(params.page);
  const providerPage = normalizeOptionalModelPickerIndex(params.providerPage);
  const normalizedProvider = params.provider ? normalizeProviderId(params.provider) : undefined;
  const modelIndex = normalizeOptionalModelPickerIndex(params.modelIndex);
  const recentSlot = normalizeOptionalModelPickerIndex(params.recentSlot);
  const modelToken = params.modelToken?.trim();
  if (modelToken && !DISCORD_MODEL_PICKER_TOKEN_PATTERN.test(modelToken)) {
    throw new Error("Discord model picker model token is invalid");
  }

  const parts = [
    `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:c=${encodeCustomIdComponent(params.command)}`,
    `a=${encodeCustomIdComponent(params.action)}`,
    `v=${encodeCustomIdComponent(params.view)}`,
    `u=${encodeCustomIdComponent(userId)}`,
    `g=${String(page)}`,
  ];
  if (normalizedProvider) {
    parts.push(`p=${encodeCustomIdComponent(normalizedProvider)}`);
  }
  const runtime = params.runtime?.trim();
  if (runtime) {
    parts.push(`r=${encodeCustomIdComponent(runtime)}`);
  }
  const runtimeToken = params.runtimeToken?.trim();
  if (runtimeToken && !DISCORD_MODEL_PICKER_TOKEN_PATTERN.test(runtimeToken)) {
    throw new Error("Discord model picker runtime token is invalid");
  }
  if (runtimeToken) {
    parts.push(`rt=${runtimeToken}`);
  }
  const runtimeIndex = normalizeOptionalModelPickerIndex(params.runtimeIndex);
  if (runtimeIndex) {
    parts.push(`ri=${String(runtimeIndex)}`);
  }
  if (providerPage) {
    parts.push(`pp=${String(providerPage)}`);
  }
  if (modelToken) {
    parts.push(`m=${modelToken}`);
  } else {
    // Legacy positional state is accepted until the next render. New model
    // components use the stable token so catalog reordering cannot retarget them.
    if (modelIndex) {
      parts.push(`mi=${String(modelIndex)}`);
    }
    if (recentSlot) {
      parts.push(`rs=${String(recentSlot)}`);
    }
  }
  const providerBucket = params.providerBucket?.trim().toLowerCase();
  if (providerBucket) {
    parts.push(`pb=${encodeCustomIdComponent(providerBucket)}`);
  }
  const modelBucket = params.modelBucket?.trim().toLowerCase();
  if (modelBucket) {
    parts.push(`mb=${encodeCustomIdComponent(modelBucket)}`);
  }

  // Page one is already the parser default. A model token also identifies its provider.
  if (parts.join(";").length > DISCORD_CUSTOM_ID_MAX_CHARS) {
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      if (parts[index] === "g=1" || parts[index] === "pp=1") {
        parts.splice(index, 1);
      }
    }
  }
  if (modelToken && parts.join(";").length > DISCORD_CUSTOM_ID_MAX_CHARS) {
    const providerPart = parts.findIndex((part) => part.startsWith("p="));
    if (providerPart >= 0) {
      parts.splice(providerPart, 1);
    }
  }
  const customId = parts.join(";");
  if (customId.length > DISCORD_CUSTOM_ID_MAX_CHARS) {
    throw new Error(
      `Discord model picker custom_id exceeds ${DISCORD_CUSTOM_ID_MAX_CHARS} chars (${customId.length})`,
    );
  }
  return customId;
}

export function parseDiscordModelPickerData(data: ComponentData): DiscordModelPickerState | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const command = decodeCustomIdComponent(coerceString(data.c ?? data.cmd));
  const action = decodeCustomIdComponent(coerceString(data.a ?? data.act));
  const view = decodeCustomIdComponent(coerceString(data.v ?? data.view));
  const userId = decodeCustomIdComponent(coerceString(data.u));
  const providerRaw = decodeCustomIdComponent(coerceString(data.p));
  const runtimeRaw = decodeCustomIdComponent(coerceString(data.r));
  const runtimeIndex = parseStrictPositiveInteger(data.ri);
  const runtimeTokenRaw = coerceString(data.rt).trim();
  if (runtimeTokenRaw && !DISCORD_MODEL_PICKER_TOKEN_PATTERN.test(runtimeTokenRaw)) {
    return null;
  }
  if ([runtimeRaw.trim(), runtimeTokenRaw, runtimeIndex].filter(Boolean).length > 1) {
    return null;
  }
  const page = parseRawPage(data.g ?? data.pg);
  const providerPage = parseStrictPositiveInteger(data.pp);
  const modelIndex = parseStrictPositiveInteger(data.mi);
  const modelTokenRaw = coerceString(data.m).trim();
  const modelToken = DISCORD_MODEL_PICKER_TOKEN_PATTERN.test(modelTokenRaw)
    ? modelTokenRaw
    : undefined;
  const recentSlot = parseStrictPositiveInteger(data.rs);
  const providerBucketRaw = decodeCustomIdComponent(coerceString(data.pb)).trim().toLowerCase();
  const modelBucketRaw = decodeCustomIdComponent(coerceString(data.mb)).trim().toLowerCase();

  if (!isValidCommandContext(command) || !isValidPickerAction(action) || !isValidPickerView(view)) {
    return null;
  }

  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    return null;
  }

  const provider = providerRaw ? normalizeProviderId(providerRaw) : undefined;
  const runtime = runtimeRaw.trim() || undefined;

  return {
    command,
    action,
    view,
    userId: trimmedUserId,
    provider,
    runtime,
    ...(runtimeTokenRaw ? { runtimeToken: runtimeTokenRaw } : {}),
    ...(typeof runtimeIndex === "number" ? { runtimeIndex } : {}),
    page,
    ...(typeof providerPage === "number" ? { providerPage } : {}),
    ...(typeof modelIndex === "number" ? { modelIndex } : {}),
    ...(modelToken ? { modelToken } : {}),
    ...(typeof recentSlot === "number" ? { recentSlot } : {}),
    ...(providerBucketRaw ? { providerBucket: providerBucketRaw } : {}),
    ...(modelBucketRaw ? { modelBucket: modelBucketRaw } : {}),
  };
}

// Keep equal initial letters together; use numeric chunks when every initial matches.
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

  // Bucket ids enter URI-encoded Discord custom ids, so the prefix must never
  // be a lone UTF-16 surrogate when an identifier starts with an astral character.
  const firstLetter = (value: string): string => (Array.from(value)[0] ?? "").toLowerCase();
  const firstItem = expectDefined(sortedItems.at(0), "non-empty sorted model picker items");
  const allSamePrefix = sortedItems.every((item) => firstLetter(item) === firstLetter(firstItem));
  const buckets: DiscordModelPickerBucket[] = [];
  // Extending letter boundaries only grows buckets, preserving the 25-option ceiling.
  const target = Math.max(
    DISCORD_MODEL_PICKER_BUCKET_TARGET_SIZE,
    Math.ceil(sortedItems.length / DISCORD_COMPONENT_MAX_SELECT_OPTIONS),
  );
  let start = 0;
  while (start < sortedItems.length) {
    let end = Math.min(sortedItems.length, start + target);
    if (!allSamePrefix && end < sortedItems.length) {
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
    const id = allSamePrefix
      ? `${start + 1}-${end}`
      : startLetter === endLetter
        ? startLetter
        : `${startLetter}-${endLetter}`;
    const range = allSamePrefix
      ? `${start + 1}–${end}`
      : startLetter === endLetter
        ? startLetter.toUpperCase()
        : `${startLetter.toUpperCase()}–${endLetter.toUpperCase()}`;
    const label = `${range} (${end - start})`;
    buckets.push({ id, label, start, end });
    start = end;
  }
  return buckets;
}

// Derive navigation from catalog state to conserve Discord's custom-id budget.
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
  return findModelPickerBucketLocation(
    [...data.providers].toSorted(),
    normalizeProviderId(provider),
  );
}

export function findModelBucketId(
  data: ModelsProviderData,
  provider: string,
  model: string,
): string | undefined {
  return resolveDiscordModelPickerPageForModel({ data, provider, model }).bucket;
}

function findModelPickerBucketLocation(
  sortedItems: string[],
  item: string,
): { bucket?: string; page: number } | undefined {
  const index = sortedItems.indexOf(item);
  const bucket =
    index < 0
      ? undefined
      : computeAlphaBuckets(sortedItems).find((entry) => index >= entry.start && index < entry.end);
  return bucket
    ? {
        ...(bucket.id === "all" ? {} : { bucket: bucket.id }),
        page: Math.floor((index - bucket.start) / DISCORD_COMPONENT_MAX_SELECT_OPTIONS) + 1,
      }
    : undefined;
}

function paginateDiscordModelPickerBucket<T>(params: {
  items: T[];
  itemLabels: string[];
  page?: number;
  bucket?: string;
}): DiscordModelPickerBucketPage<T> {
  const buckets = computeAlphaBuckets(params.itemLabels);
  const bucket = buckets.find((entry) => entry.id === params.bucket) ?? buckets[0] ?? null;
  const items = bucket ? params.items.slice(bucket.start, bucket.end) : params.items;
  const pageSize = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(normalizeModelPickerPage(params.page), totalPages);
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    totalPages,
    totalItems,
    hasPrev: page > 1,
    hasNext: page < totalPages,
    bucket,
    buckets,
  };
}

export function getDiscordModelPickerProviderPage(params: {
  data: ModelsProviderData;
  page?: number;
  bucket?: string;
}): DiscordModelPickerBucketPage<DiscordModelPickerProviderItem> {
  const providers = [...params.data.providers].toSorted();
  return paginateDiscordModelPickerBucket({
    ...params,
    itemLabels: providers,
    items: providers.map((provider) => ({
      id: provider,
      count: params.data.byProvider.get(provider)?.size ?? 0,
    })),
  });
}

export function getDiscordModelPickerModelPage(params: {
  data: ModelsProviderData;
  provider: string;
  page?: number;
  bucket?: string;
}): (DiscordModelPickerBucketPage<string> & { provider: string }) | null {
  const provider = normalizeProviderId(params.provider);
  const modelSet = params.data.byProvider.get(provider);
  if (!modelSet) {
    return null;
  }

  const allModels = [...modelSet].toSorted(compareBucketItems);
  return {
    ...paginateDiscordModelPickerBucket({ ...params, items: allModels, itemLabels: allModels }),
    provider,
  };
}

export function resolveDiscordModelPickerPageForModel(params: {
  data: ModelsProviderData;
  provider: string;
  model: string;
}): { page: number; bucket?: string } {
  const provider = normalizeProviderId(params.provider);
  const modelSet = params.data.byProvider.get(provider);
  if (!modelSet) {
    return { page: 1 };
  }
  const sorted = [...modelSet].toSorted(compareBucketItems);
  return findModelPickerBucketLocation(sorted, params.model) ?? { page: 1 };
}
