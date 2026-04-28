import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { resolveMatrixLegacyFlatStoreRoot } from "../../storage-paths.js";
import { createAsyncLock } from "../async-lock.js";
import { resolveMatrixStateFilePath } from "../client/storage.js";
import type { MatrixAuth } from "../client/types.js";
import { LogService } from "../sdk/logger.js";
import {
  type ParticipationDirective,
  type ParticipationDirectiveMode,
} from "./participation-policy.js";

const PARTICIPATION_STATE_FILENAME = "participation-state.json";
const STORE_VERSION = 1;
const REDACTED_STORED_SOURCE_TEXT = "[stored participation directive source text redacted]";

type StoredMatrixParticipationRoomPolicy = {
  directive: {
    mode: ParticipationDirectiveMode;
    includeAgentIds?: string[];
    excludeAgentIds?: string[];
    /** Legacy stores may contain sourceText. New writes intentionally omit raw source text. */
    sourceText?: string;
    persistence?: "room";
  };
  updatedAt: string;
  updatedBy?: string;
};

type StoredMatrixParticipationState = {
  version: number;
  rooms: Record<string, StoredMatrixParticipationRoomPolicy>;
};

type MatrixParticipationPolicyRecord = {
  directive: ParticipationDirective;
  updatedAt: string;
  updatedBy?: string;
};

type SharedParticipationStoreState = {
  lock: ReturnType<typeof createAsyncLock>;
  policies: Map<string, MatrixParticipationPolicyRecord>;
  loadPromise: Promise<void> | null;
  loadedLegacyPaths: Set<string>;
};

export type MatrixParticipationStateStore = {
  /** Resolved central JSON file path used for durable room participation policies. */
  storagePath: string;
  /** Current-account legacy JSON file path merged on load, if known. */
  legacyStoragePath?: string;
  getRoomPolicy: (params: { roomId: string }) => Promise<ParticipationDirective | undefined>;
  applyDirective: (params: {
    roomId: string;
    directive?: ParticipationDirective;
    senderId?: string;
  }) => Promise<void>;
  clearRoomPolicy: (params: { roomId: string }) => Promise<void>;
};

const sharedStores = new Map<string, SharedParticipationStoreState>();

function resolveCentralParticipationStatePath(params: {
  stateDir?: string;
  storagePath?: string;
}): string {
  if (params.storagePath) {
    return params.storagePath;
  }
  if (!params.stateDir) {
    throw new Error(
      "Matrix participation state requires stateDir or storagePath for central storage",
    );
  }
  return path.join(resolveMatrixLegacyFlatStoreRoot(params.stateDir), PARTICIPATION_STATE_FILENAME);
}

function resolveLegacyParticipationStatePath(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  legacyStoragePath?: string;
}): string | undefined {
  if (params.legacyStoragePath) {
    return params.legacyStoragePath;
  }
  try {
    return resolveMatrixStateFilePath({
      auth: params.auth,
      env: params.env,
      stateDir: params.stateDir,
      filename: PARTICIPATION_STATE_FILENAME,
    });
  } catch {
    return undefined;
  }
}

function normalizeRoomId(value: string): string {
  return value.trim();
}

function unique(values: Iterable<string>): string[] {
  const out: string[] = [];
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized && !out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
}

function cloneDirective(directive: ParticipationDirective): ParticipationDirective {
  return {
    mode: directive.mode,
    sourceText: directive.sourceText,
    persistence: directive.persistence,
    ...(directive.includeAgentIds ? { includeAgentIds: [...directive.includeAgentIds] } : {}),
    ...(directive.excludeAgentIds ? { excludeAgentIds: [...directive.excludeAgentIds] } : {}),
    ...(directive.clearsStoredPolicy ? { clearsStoredPolicy: true } : {}),
  };
}

function cloneStoredDirective(directive: ParticipationDirective): ParticipationDirective {
  return {
    ...cloneDirective(directive),
    sourceText: REDACTED_STORED_SOURCE_TEXT,
  };
}

function sanitizeStoredDirective(raw: unknown): ParticipationDirective | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const directive = raw as {
    mode?: unknown;
    includeAgentIds?: unknown;
    excludeAgentIds?: unknown;
    sourceText?: unknown;
    persistence?: unknown;
  };
  if (
    directive.mode !== "subset_only" &&
    directive.mode !== "exclude_subset" &&
    directive.mode !== "silence"
  ) {
    return undefined;
  }
  if (directive.persistence !== "room") {
    return undefined;
  }
  const includeAgentIds = Array.isArray(directive.includeAgentIds)
    ? unique(
        directive.includeAgentIds.filter((value): value is string => typeof value === "string"),
      )
    : undefined;
  const excludeAgentIds = Array.isArray(directive.excludeAgentIds)
    ? unique(
        directive.excludeAgentIds.filter((value): value is string => typeof value === "string"),
      )
    : undefined;
  if (directive.mode === "subset_only" && (!includeAgentIds || includeAgentIds.length === 0)) {
    return undefined;
  }
  if (directive.mode === "exclude_subset" && (!excludeAgentIds || excludeAgentIds.length === 0)) {
    return undefined;
  }
  return {
    mode: directive.mode,
    sourceText: REDACTED_STORED_SOURCE_TEXT,
    persistence: "room",
    ...(includeAgentIds ? { includeAgentIds } : {}),
    ...(excludeAgentIds ? { excludeAgentIds } : {}),
  };
}

function toStoredState(
  policies: Map<string, MatrixParticipationPolicyRecord>,
): StoredMatrixParticipationState {
  const rooms = Object.fromEntries(
    [...policies.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([roomId, policy]) => [
        roomId,
        {
          directive: {
            mode: policy.directive.mode,
            persistence: "room",
            ...(policy.directive.includeAgentIds
              ? { includeAgentIds: [...policy.directive.includeAgentIds] }
              : {}),
            ...(policy.directive.excludeAgentIds
              ? { excludeAgentIds: [...policy.directive.excludeAgentIds] }
              : {}),
          },
          updatedAt: policy.updatedAt,
          ...(policy.updatedBy ? { updatedBy: policy.updatedBy } : {}),
        } satisfies StoredMatrixParticipationRoomPolicy,
      ]),
  );
  return { version: STORE_VERSION, rooms };
}

async function readStoredState(
  storagePath: string,
): Promise<Map<string, MatrixParticipationPolicyRecord>> {
  const { value } = await readJsonFileWithFallback<StoredMatrixParticipationState | null>(
    storagePath,
    null,
  );
  const policies = new Map<string, MatrixParticipationPolicyRecord>();
  if (value?.version !== STORE_VERSION || !value.rooms || typeof value.rooms !== "object") {
    return policies;
  }
  for (const [rawRoomId, rawPolicy] of Object.entries(value.rooms)) {
    const roomId = normalizeRoomId(rawRoomId);
    if (!roomId || !rawPolicy || typeof rawPolicy !== "object") {
      continue;
    }
    const directive = sanitizeStoredDirective((rawPolicy as { directive?: unknown }).directive);
    const updatedAt =
      typeof (rawPolicy as { updatedAt?: unknown }).updatedAt === "string" &&
      (rawPolicy as { updatedAt?: string }).updatedAt?.trim()
        ? (rawPolicy as { updatedAt: string }).updatedAt.trim()
        : new Date(0).toISOString();
    const updatedBy =
      typeof (rawPolicy as { updatedBy?: unknown }).updatedBy === "string" &&
      (rawPolicy as { updatedBy?: string }).updatedBy?.trim()
        ? (rawPolicy as { updatedBy: string }).updatedBy.trim()
        : undefined;
    if (!directive) {
      continue;
    }
    policies.set(roomId, { directive, updatedAt, ...(updatedBy ? { updatedBy } : {}) });
  }
  return policies;
}

function mergeNewest(
  target: Map<string, MatrixParticipationPolicyRecord>,
  source: Map<string, MatrixParticipationPolicyRecord>,
): void {
  for (const [roomId, next] of source) {
    const current = target.get(roomId);
    if (!current || Date.parse(next.updatedAt) >= Date.parse(current.updatedAt)) {
      target.set(roomId, next);
    }
  }
}

function getSharedStore(storagePath: string): SharedParticipationStoreState {
  const key = path.resolve(storagePath);
  let shared = sharedStores.get(key);
  if (!shared) {
    shared = {
      lock: createAsyncLock(),
      policies: new Map<string, MatrixParticipationPolicyRecord>(),
      loadPromise: null,
      loadedLegacyPaths: new Set<string>(),
    };
    sharedStores.set(key, shared);
  }
  return shared;
}

export function createMatrixParticipationStateStore(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  storagePath?: string;
  legacyStoragePath?: string;
  now?: () => string;
}): MatrixParticipationStateStore {
  const storagePath = resolveCentralParticipationStatePath({
    stateDir: params.stateDir,
    storagePath: params.storagePath,
  });
  const legacyStoragePath = resolveLegacyParticipationStatePath(params);
  const now = params.now ?? (() => new Date().toISOString());
  const shared = getSharedStore(storagePath);

  const ensureLoaded = async (): Promise<void> => {
    if (!shared.loadPromise) {
      shared.loadPromise = (async () => {
        try {
          const loaded = await readStoredState(storagePath);
          shared.policies.clear();
          mergeNewest(shared.policies, loaded);
        } catch (err) {
          LogService.warn(
            "MatrixParticipationState",
            "Failed loading Matrix participation state:",
            err,
          );
        }
      })();
    }
    await shared.loadPromise;
    if (legacyStoragePath && path.resolve(legacyStoragePath) !== path.resolve(storagePath)) {
      const legacyKey = path.resolve(legacyStoragePath);
      if (!shared.loadedLegacyPaths.has(legacyKey)) {
        try {
          const legacy = await readStoredState(legacyStoragePath);
          mergeNewest(shared.policies, legacy);
          shared.loadedLegacyPaths.add(legacyKey);
          if (legacy.size > 0) {
            await persist();
          }
        } catch (err) {
          LogService.warn(
            "MatrixParticipationState",
            "Failed merging legacy Matrix participation state:",
            err,
          );
        }
      }
    }
  };

  const persist = async (): Promise<void> => {
    await shared.lock(async () => {
      await writeJsonFileAtomically(storagePath, toStoredState(shared.policies));
    });
  };

  return {
    storagePath,
    ...(legacyStoragePath ? { legacyStoragePath } : {}),
    getRoomPolicy: async ({ roomId }) => {
      const normalizedRoomId = normalizeRoomId(roomId);
      if (!normalizedRoomId) {
        return undefined;
      }
      await ensureLoaded();
      const policy = shared.policies.get(normalizedRoomId);
      return policy ? cloneDirective(policy.directive) : undefined;
    },
    applyDirective: async ({ roomId, directive, senderId }) => {
      const normalizedRoomId = normalizeRoomId(roomId);
      if (!normalizedRoomId || !directive) {
        return;
      }
      await ensureLoaded();
      if (directive.mode === "open" || directive.clearsStoredPolicy) {
        if (shared.policies.delete(normalizedRoomId)) {
          await persist();
        }
        return;
      }
      if (directive.persistence !== "room") {
        return;
      }
      shared.policies.set(normalizedRoomId, {
        directive: cloneStoredDirective({ ...directive, persistence: "room" }),
        updatedAt: now(),
        ...(senderId?.trim() ? { updatedBy: senderId.trim() } : {}),
      });
      await persist();
    },
    clearRoomPolicy: async ({ roomId }) => {
      const normalizedRoomId = normalizeRoomId(roomId);
      if (!normalizedRoomId) {
        return;
      }
      await ensureLoaded();
      if (shared.policies.delete(normalizedRoomId)) {
        await persist();
      }
    },
  };
}
