import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/memory-host-core";
import {
  getActiveMemoryProvider,
  isActiveMemoryProviderNative,
  type ActiveMemoryProviderResult,
  type MemoryCallerContext,
  type MemoryReference,
} from "openclaw/plugin-sdk/memory-host-search";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "../api.js";

type SharedMemoryCaller = {
  appConfig?: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  memoryContext?: MemoryCallerContext;
};

export function resolveActiveMemoryAgentId(params: SharedMemoryCaller): string | null {
  if (!params.appConfig) {
    return null;
  }
  if (params.agentId?.trim()) {
    return params.agentId.trim();
  }
  if (params.agentSessionKey?.trim()) {
    return resolveSessionAgentIdStrict({
      sessionKey: params.agentSessionKey,
      config: params.appConfig,
    });
  }
  return resolveDefaultAgentId(params.appConfig);
}

/** Reports whether the slot owner serves this query natively; legacy owners keep their manager path. */
export async function usesNativeMemoryProvider(params: SharedMemoryCaller): Promise<boolean> {
  const agentId = resolveActiveMemoryAgentId(params);
  if (!params.appConfig || !agentId) {
    return false;
  }
  try {
    return await isActiveMemoryProviderNative({ cfg: params.appConfig, agentId });
  } catch {
    // An owner that cannot be resolved leaves Wiki results wiki-only, as the manager path does.
    return false;
  }
}

/** Opens one query-bound memory provider and closes it before returning. */
export async function withActiveMemoryProvider<T>(
  params: SharedMemoryCaller,
  action: (result: ActiveMemoryProviderResult) => Promise<T>,
): Promise<T> {
  const agentId = resolveActiveMemoryAgentId(params);
  let active = true;
  const caller = params.memoryContext;
  // Legacy library/CLI calls are host operations, never session-owner or operator authority.
  const context: MemoryCallerContext = {
    authority: caller?.authority ?? { kind: "host", operation: "memory-wiki.query" },
    signal: caller?.signal,
    assertCurrent() {
      if (!active) {
        throw new Error("Memory Wiki query has completed.");
      }
      caller?.assertCurrent();
      caller?.signal?.throwIfAborted();
    },
  };
  let result: ActiveMemoryProviderResult = { provider: null };
  let value: T;
  try {
    context.assertCurrent();
    if (params.appConfig && agentId) {
      try {
        result = await getActiveMemoryProvider({ cfg: params.appConfig, agentId, context });
      } catch {
        // An unavailable provider leaves Wiki results wiki-only; a lapsed caller still fails.
        context.assertCurrent();
      }
    }
    value = await action(result);
    context.assertCurrent();
  } finally {
    active = false;
    await result.provider?.close();
  }
  // Lease cleanup can yield after selection; the caller still controls release.
  caller?.assertCurrent();
  caller?.signal?.throwIfAborted();
  return value;
}

const MEMORY_REFERENCE_PREFIX = "memory-ref:";

export function memoryReferenceLookup(reference: MemoryReference): string {
  return `${MEMORY_REFERENCE_PREFIX}${encodeURIComponent(JSON.stringify(reference))}`;
}

export function isMemoryReferenceLookup(lookup: string): boolean {
  return lookup.startsWith(MEMORY_REFERENCE_PREFIX);
}

export function parseMemoryReferenceLookup(lookup: string): MemoryReference | null {
  if (!lookup.startsWith(MEMORY_REFERENCE_PREFIX)) {
    return null;
  }
  const record = asNullableRecord(
    JSON.parse(decodeURIComponent(lookup.slice(MEMORY_REFERENCE_PREFIX.length))),
  );
  if (
    !record ||
    typeof record.providerId !== "string" ||
    !record.providerId ||
    typeof record.id !== "string" ||
    !record.id ||
    (record.revision !== undefined && typeof record.revision !== "string") ||
    (record.fragment !== undefined && typeof record.fragment !== "string")
  ) {
    throw new Error("Invalid memory reference.");
  }
  return {
    providerId: record.providerId,
    id: record.id,
    ...(record.revision !== undefined ? { revision: record.revision } : {}),
    ...(record.fragment !== undefined ? { fragment: record.fragment } : {}),
  };
}
