import {
  readAcpSessionEntryAsync,
  type AcpSessionStoreEntry,
} from "openclaw/plugin-sdk/acp-runtime";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseDiscordTarget } from "../targets.js";
import { resolveChannelIdForBinding } from "./thread-bindings.discord-api.js";
import { getThreadBindingManager } from "./thread-bindings.manager.js";
import { removeBindingRecordSync } from "./thread-bindings.persistence.js";
import {
  mutateBindingsForTargetSession,
  resolveBindingIdsForTargetSession,
} from "./thread-bindings.session-shared.js";
import {
  BINDINGS_BY_THREAD_ID,
  MANAGERS_BY_ACCOUNT_ID,
  getThreadBindingToken,
  refreshUnboundThreadWebhookIdentity,
} from "./thread-bindings.state.js";
import type { ThreadBindingRecord, ThreadBindingTargetKind } from "./thread-bindings.types.js";
export {
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingIdleTimeoutBySessionKeyAsync,
  setThreadBindingMaxAgeBySessionKey,
  setThreadBindingMaxAgeBySessionKeyAsync,
} from "./thread-bindings.session-updates.js";

export type AcpThreadBindingReconciliationResult = {
  checked: number;
  removed: number;
  staleSessionKeys: string[];
};

type AcpThreadBindingHealthStatus = "healthy" | "stale" | "uncertain";

type AcpThreadBindingHealthProbe = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  sessionKey: string;
  binding: ThreadBindingRecord;
  session: AcpSessionStoreEntry;
}) => Promise<{
  status: AcpThreadBindingHealthStatus;
  reason?: string;
}>;

// Cap startup fan-out so large binding sets do not create unbounded ACP probe spikes.
const ACP_STARTUP_HEALTH_PROBE_CONCURRENCY_LIMIT = 8;

export function listThreadBindingsForAccount(accountId?: string): ThreadBindingRecord[] {
  return getThreadBindingManager(accountId)?.listBindings() ?? [];
}

export function listThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  return ids
    .map((bindingKey) => BINDINGS_BY_THREAD_ID.get(bindingKey))
    .filter((entry): entry is ThreadBindingRecord => Boolean(entry));
}

export async function autoBindSpawnedDiscordSubagent(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  channel?: string;
  to?: string;
  threadId?: string | number;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundBy?: string;
}): Promise<ThreadBindingRecord | null> {
  const channel = normalizeOptionalLowercaseString(params.channel);
  if (channel !== "discord") {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }
  const managerToken = getThreadBindingToken(manager.accountId);

  const requesterThreadId = normalizeOptionalStringifiedId(params.threadId);
  let channelId = "";
  if (requesterThreadId) {
    const existing = manager.getByThreadId(requesterThreadId);
    if (existing?.channelId?.trim()) {
      channelId = existing.channelId.trim();
    } else {
      channelId =
        (await resolveChannelIdForBinding({
          cfg: params.cfg,
          accountId: manager.accountId,
          token: managerToken,
          threadId: requesterThreadId,
        })) ?? "";
    }
  }
  if (!channelId) {
    const to = normalizeOptionalString(params.to) ?? "";
    if (!to) {
      return null;
    }
    try {
      const target = parseDiscordTarget(to, { defaultKind: "channel" });
      if (!target || target.kind !== "channel") {
        return null;
      }
      channelId =
        (await resolveChannelIdForBinding({
          cfg: params.cfg,
          accountId: manager.accountId,
          token: managerToken,
          threadId: target.id,
        })) ?? "";
    } catch {
      return null;
    }
  }

  return await manager.bindTarget({
    threadId: undefined,
    channelId,
    createThread: true,
    threadName: resolveThreadBindingThreadName({
      agentId: params.agentId,
      label: params.label,
    }),
    targetKind: "subagent",
    targetSessionKey: params.childSessionKey,
    agentId: params.agentId,
    label: params.label,
    boundBy: params.boundBy ?? "system",
    introText: resolveThreadBindingIntroText({
      agentId: params.agentId,
      label: params.label,
      idleTimeoutMs: manager.getIdleTimeoutMs(),
      maxAgeMs: manager.getMaxAgeMs(),
    }),
  });
}

/** @deprecated Public SDK compatibility; bundled callers use the awaited variant. */
export function unbindThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
  farewellText?: string;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  if (ids.length === 0) {
    return [];
  }

  const removed: ThreadBindingRecord[] = [];
  for (const bindingKey of ids) {
    const record = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (!record) {
      continue;
    }
    const manager = MANAGERS_BY_ACCOUNT_ID.get(record.accountId);
    if (manager?.isStopping()) {
      throw new Error("Discord thread binding manager is stopping");
    }
    const unbound = removeBindingRecordSync(bindingKey);
    if (unbound) {
      if (manager) {
        manager.notifyUnbound(unbound, params);
      } else {
        refreshUnboundThreadWebhookIdentity(unbound);
      }
      removed.push(unbound);
    }
  }

  return removed;
}

export async function unbindThreadBindingsBySessionKeyAsync(
  input: Parameters<typeof unbindThreadBindingsBySessionKey>[0],
): Promise<ThreadBindingRecord[]> {
  const params = { ...input };
  return mutateBindingsForTargetSession(
    params,
    () => null,
    (record, manager) => {
      if (manager) {
        manager.notifyUnbound(record, params);
      } else {
        refreshUnboundThreadWebhookIdentity(record);
      }
    },
  );
}

export async function reconcileAcpThreadBindingsOnStartup(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  sendFarewell?: boolean;
  healthProbe?: AcpThreadBindingHealthProbe;
}): Promise<AcpThreadBindingReconciliationResult> {
  const manager = getThreadBindingManager(params.accountId);
  if (!manager) {
    return {
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
    };
  }

  const acpBindings = manager
    .listBindings()
    .filter(
      (binding) =>
        binding.targetKind === "acp" && binding.metadata?.pluginBindingOwner !== "plugin",
    );
  const staleBindings: ThreadBindingRecord[] = [];
  const probeTargets: Array<{
    binding: ThreadBindingRecord;
    sessionKey: string;
    session: AcpSessionStoreEntry;
  }> = [];

  for (const binding of acpBindings) {
    const sessionKey = binding.targetSessionKey.trim();
    if (!sessionKey) {
      staleBindings.push(binding);
      continue;
    }
    const session = await readAcpSessionEntryAsync({
      cfg: params.cfg,
      sessionKey,
      agentId: binding.agentId,
    });
    if (
      getThreadBindingManager(manager.accountId) !== manager ||
      manager.getByThreadId(binding.threadId) !== binding
    ) {
      continue;
    }
    if (!session) {
      staleBindings.push(binding);
      continue;
    }
    // Session store read failures are transient; never auto-unbind on uncertain reads.
    if (session.storeReadFailed) {
      continue;
    }

    if (!session.acp) {
      staleBindings.push(binding);
      continue;
    }

    if (!params.healthProbe) {
      continue;
    }
    probeTargets.push({ binding, sessionKey, session });
  }

  if (params.healthProbe && probeTargets.length > 0) {
    const { results: probeResults } = await runTasksWithConcurrency({
      tasks: probeTargets.map(({ binding, sessionKey, session }) => async () => {
        try {
          const result = await params.healthProbe?.({
            cfg: params.cfg,
            accountId: manager.accountId,
            sessionKey,
            binding,
            session,
          });
          return {
            binding,
            status: result?.status ?? ("uncertain" satisfies AcpThreadBindingHealthStatus),
          };
        } catch {
          // Treat probe failures as uncertain and keep the binding.
          return {
            binding,
            status: "uncertain" satisfies AcpThreadBindingHealthStatus,
          };
        }
      }),
      limit: ACP_STARTUP_HEALTH_PROBE_CONCURRENCY_LIMIT,
      errorMode: "stop",
      throwOnError: true,
    });

    for (const probeResult of probeResults) {
      if (probeResult.status === "stale") {
        staleBindings.push(probeResult.binding);
      }
    }
  }

  if (staleBindings.length === 0) {
    return {
      checked: acpBindings.length,
      removed: 0,
      staleSessionKeys: [],
    };
  }

  const staleSessionKeys: string[] = [];
  let removed = 0;
  for (const binding of staleBindings) {
    staleSessionKeys.push(binding.targetSessionKey);
    if (
      getThreadBindingManager(manager.accountId) !== manager ||
      manager.getByThreadId(binding.threadId) !== binding
    ) {
      continue;
    }
    const unbound = await manager.unbindThread({
      threadId: binding.threadId,
      expected: binding,
      reason: "stale-session",
      sendFarewell: params.sendFarewell ?? false,
    });
    if (unbound) {
      removed += 1;
    }
  }

  return {
    checked: acpBindings.length,
    removed,
    staleSessionKeys: uniqueStrings(staleSessionKeys),
  };
}
