// Hub-delegated ACP session helpers for owner-scoped persistent workers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type HubDelegatedSessionMeta = {
  ownerSessionKey: string;
  createdAt: number;
};

export type HubDelegatedAcpPolicy = {
  idleMs: number;
  maxAgeMs: number;
};

export const DEFAULT_HUB_DELEGATED_IDLE_HOURS = 72;
export const DEFAULT_HUB_DELEGATED_MAX_AGE_HOURS = 168;

type HubDelegatedPolicyInput = {
  idleHours?: number;
  maxAgeHours?: number;
};

type HubDelegatedSessionEntry = {
  hubDelegated?: HubDelegatedSessionMeta | null;
  spawnedBy?: string;
  parentSessionKey?: string;
  label?: string;
  updatedAt?: number;
  acp?: {
    lastActivityAt?: number;
    mode?: "persistent" | "oneshot";
  } | null;
};

export function resolveHubDelegatedAcpPolicy(
  input?: HubDelegatedPolicyInput | null,
): HubDelegatedAcpPolicy {
  const idleHours = input?.idleHours ?? DEFAULT_HUB_DELEGATED_IDLE_HOURS;
  const maxAgeHours = input?.maxAgeHours ?? DEFAULT_HUB_DELEGATED_MAX_AGE_HOURS;
  return {
    idleMs: Math.max(0, idleHours) * 60 * 60 * 1000,
    maxAgeMs: Math.max(0, maxAgeHours) * 60 * 60 * 1000,
  };
}

export function isHubDelegatedAcpSessionEntry(
  entry?: HubDelegatedSessionEntry | null,
): entry is HubDelegatedSessionEntry & { hubDelegated: HubDelegatedSessionMeta } {
  const ownerSessionKey = normalizeOptionalString(entry?.hubDelegated?.ownerSessionKey);
  return Boolean(ownerSessionKey);
}

export function isHubDelegatedOwnedByRequester(params: {
  entry?: HubDelegatedSessionEntry | null;
  requesterSessionKey?: string | null;
}): boolean {
  if (!isHubDelegatedAcpSessionEntry(params.entry)) {
    return false;
  }
  const requester = normalizeOptionalString(params.requesterSessionKey);
  if (!requester) {
    return false;
  }
  const owner = normalizeOptionalString(params.entry.hubDelegated.ownerSessionKey);
  const spawnedBy = normalizeOptionalString(params.entry.spawnedBy);
  const parentSessionKey = normalizeOptionalString(params.entry.parentSessionKey);
  return requester === owner || requester === spawnedBy || requester === parentSessionKey;
}

type HubDelegatedLabelStoreEntry = HubDelegatedSessionEntry & {
  label?: string;
};

/** Returns the conflicting store key when the same owner already uses this label. */
export function findHubDelegatedLabelConflictInStore(params: {
  store: Record<string, HubDelegatedLabelStoreEntry>;
  storeKey: string;
  ownerSessionKey: string;
  label: string;
}): string | undefined {
  const ownerSessionKey = normalizeOptionalString(params.ownerSessionKey);
  const label = normalizeOptionalString(params.label);
  if (!ownerSessionKey || !label) {
    return undefined;
  }
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    if (sessionKey === params.storeKey) {
      continue;
    }
    if (!isHubDelegatedAcpSessionEntry(entry)) {
      continue;
    }
    if (normalizeOptionalString(entry.hubDelegated.ownerSessionKey) !== ownerSessionKey) {
      continue;
    }
    if (normalizeOptionalString(entry.label) === label) {
      return sessionKey;
    }
  }
  return undefined;
}

export type HubDelegatedLabelLookupResult =
  | { status: "match"; index: number }
  | { status: "missing" }
  | { status: "ambiguous"; labels: string[] };

/** Resolves owner-scoped hub-delegated labels with exact case-sensitive equality. */
export function resolveHubDelegatedLabelLookup(params: {
  entries: ReadonlyArray<{ label?: string | null }>;
  label: string;
}): HubDelegatedLabelLookupResult {
  const label = normalizeOptionalString(params.label);
  if (!label) {
    return { status: "missing" };
  }
  const foldedLabel = label.toLowerCase();
  const exactIndexes: number[] = [];
  const caseFoldedIndexes: number[] = [];
  for (let index = 0; index < params.entries.length; index += 1) {
    const entryLabel = normalizeOptionalString(params.entries[index]?.label);
    if (!entryLabel) {
      continue;
    }
    if (entryLabel === label) {
      exactIndexes.push(index);
      continue;
    }
    if (entryLabel.toLowerCase() === foldedLabel) {
      caseFoldedIndexes.push(index);
    }
  }
  if (exactIndexes.length === 1) {
    return { status: "match", index: exactIndexes[0] };
  }
  if (exactIndexes.length > 1) {
    const labels = exactIndexes
      .map((index) => normalizeOptionalString(params.entries[index]?.label))
      .filter((entryLabel): entryLabel is string => Boolean(entryLabel));
    return { status: "ambiguous", labels };
  }
  if (caseFoldedIndexes.length > 1) {
    const labels = caseFoldedIndexes
      .map((index) => normalizeOptionalString(params.entries[index]?.label))
      .filter((entryLabel): entryLabel is string => Boolean(entryLabel));
    return { status: "ambiguous", labels };
  }
  return { status: "missing" };
}

export function resolveHubDelegatedLastActivityAt(
  entry: HubDelegatedSessionEntry & { hubDelegated: HubDelegatedSessionMeta },
): number {
  const createdAt = entry.hubDelegated.createdAt;
  const acpActivity = entry.acp?.lastActivityAt;
  if (typeof acpActivity === "number" && Number.isFinite(acpActivity)) {
    return Math.max(createdAt, acpActivity);
  }
  const updatedAt = entry.updatedAt;
  if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) {
    return Math.max(createdAt, updatedAt);
  }
  return createdAt;
}

export type HubDelegatedExpiryReason = "delegate-idle-expired" | "delegate-max-age-expired";

export function resolveHubDelegatedExpiry(params: {
  entry: HubDelegatedSessionEntry & { hubDelegated: HubDelegatedSessionMeta };
  policy: HubDelegatedAcpPolicy;
  now?: number;
}): { expired: false } | { expired: true; reason: HubDelegatedExpiryReason; expiresAt: number } {
  const now = params.now ?? Date.now();
  const lastActivityAt = resolveHubDelegatedLastActivityAt(params.entry);
  const createdAt = params.entry.hubDelegated.createdAt;
  if (params.policy.maxAgeMs > 0) {
    const maxAgeExpiresAt = createdAt + params.policy.maxAgeMs;
    if (now >= maxAgeExpiresAt) {
      return { expired: true, reason: "delegate-max-age-expired", expiresAt: maxAgeExpiresAt };
    }
  }
  if (params.policy.idleMs > 0) {
    const idleExpiresAt = lastActivityAt + params.policy.idleMs;
    if (now >= idleExpiresAt) {
      return { expired: true, reason: "delegate-idle-expired", expiresAt: idleExpiresAt };
    }
  }
  return { expired: false };
}

export function resolveHubDelegatedExpiryPreview(params: {
  entry: HubDelegatedSessionEntry & { hubDelegated: HubDelegatedSessionMeta };
  policy: HubDelegatedAcpPolicy;
}): {
  idleExpiresAt?: number;
  maxAgeExpiresAt?: number;
} {
  const lastActivityAt = resolveHubDelegatedLastActivityAt(params.entry);
  const createdAt = params.entry.hubDelegated.createdAt;
  return {
    ...(params.policy.idleMs > 0 ? { idleExpiresAt: lastActivityAt + params.policy.idleMs } : {}),
    ...(params.policy.maxAgeMs > 0 ? { maxAgeExpiresAt: createdAt + params.policy.maxAgeMs } : {}),
  };
}

function padUtcDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

/** UTC timestamp label for hub-delegated workers, e.g. delegate-20260605-143022. */
export function formatHubDelegatedAutoLabel(at = new Date()): string {
  const year = at.getUTCFullYear();
  const month = padUtcDatePart(at.getUTCMonth() + 1);
  const day = padUtcDatePart(at.getUTCDate());
  const hours = padUtcDatePart(at.getUTCHours());
  const minutes = padUtcDatePart(at.getUTCMinutes());
  const seconds = padUtcDatePart(at.getUTCSeconds());
  return `delegate-${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export function resolveHubDelegatedAutoLabel(params: {
  hasLabelConflict: (label: string) => boolean;
  now?: Date;
}): string {
  const now = params.now ?? new Date();
  const base = formatHubDelegatedAutoLabel(now);
  if (!params.hasLabelConflict(base)) {
    return base;
  }
  for (let suffix = 2; suffix <= 99; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!params.hasLabelConflict(candidate)) {
      return candidate;
    }
  }
  return `${base}-${now.getUTCMilliseconds()}`;
}
