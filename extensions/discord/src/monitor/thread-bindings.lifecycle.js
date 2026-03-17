import {
  readAcpSessionEntry
} from "../../../../src/acp/runtime/session-meta.js";
import { normalizeAccountId } from "../../../../src/routing/session-key.js";
import { parseDiscordTarget } from "../targets.js";
import { resolveChannelIdForBinding } from "./thread-bindings.discord-api.js";
import { getThreadBindingManager } from "./thread-bindings.manager.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName
} from "./thread-bindings.messages.js";
import {
  BINDINGS_BY_THREAD_ID,
  MANAGERS_BY_ACCOUNT_ID,
  ensureBindingsLoaded,
  getThreadBindingToken,
  normalizeThreadId,
  rememberRecentUnboundWebhookEcho,
  removeBindingRecord,
  resolveBindingIdsForSession,
  saveBindingsToDisk,
  setBindingRecord,
  shouldPersistBindingMutations
} from "./thread-bindings.state.js";
const ACP_STARTUP_HEALTH_PROBE_CONCURRENCY_LIMIT = 8;
async function mapWithConcurrency(params) {
  if (params.items.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.floor(params.limit));
  const resultsByIndex = /* @__PURE__ */ new Map();
  let nextIndex = 0;
  const runWorker = async () => {
    for (; ; ) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= params.items.length) {
        return;
      }
      resultsByIndex.set(index, await params.worker(params.items[index], index));
    }
  };
  const workers = Array.from({ length: Math.min(limit, params.items.length) }, () => runWorker());
  await Promise.all(workers);
  return params.items.map((_item, index) => resultsByIndex.get(index));
}
function normalizeNonNegativeMs(raw) {
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.floor(raw));
}
function resolveBindingIdsForTargetSession(params) {
  ensureBindingsLoaded();
  const targetSessionKey = params.targetSessionKey.trim();
  if (!targetSessionKey) {
    return [];
  }
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : void 0;
  return resolveBindingIdsForSession({
    targetSessionKey,
    accountId,
    targetKind: params.targetKind
  });
}
function updateBindingsForTargetSession(ids, update) {
  if (ids.length === 0) {
    return [];
  }
  const now = Date.now();
  const updated = [];
  for (const bindingKey of ids) {
    const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (!existing) {
      continue;
    }
    const nextRecord = update(existing, now);
    setBindingRecord(nextRecord);
    updated.push(nextRecord);
  }
  if (updated.length > 0 && shouldPersistBindingMutations()) {
    saveBindingsToDisk({ force: true });
  }
  return updated;
}
function listThreadBindingsForAccount(accountId) {
  const manager = getThreadBindingManager(accountId);
  if (!manager) {
    return [];
  }
  return manager.listBindings();
}
function listThreadBindingsBySessionKey(params) {
  const ids = resolveBindingIdsForTargetSession(params);
  return ids.map((bindingKey) => BINDINGS_BY_THREAD_ID.get(bindingKey)).filter((entry) => Boolean(entry));
}
async function autoBindSpawnedDiscordSubagent(params) {
  const channel = params.channel?.trim().toLowerCase();
  if (channel !== "discord") {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }
  const managerToken = getThreadBindingToken(manager.accountId);
  const requesterThreadId = normalizeThreadId(params.threadId);
  let channelId = "";
  if (requesterThreadId) {
    const existing = manager.getByThreadId(requesterThreadId);
    if (existing?.channelId?.trim()) {
      channelId = existing.channelId.trim();
    } else {
      channelId = await resolveChannelIdForBinding({
        cfg: params.cfg,
        accountId: manager.accountId,
        token: managerToken,
        threadId: requesterThreadId
      }) ?? "";
    }
  }
  if (!channelId) {
    const to = params.to?.trim() || "";
    if (!to) {
      return null;
    }
    try {
      const target = parseDiscordTarget(to, { defaultKind: "channel" });
      if (!target || target.kind !== "channel") {
        return null;
      }
      channelId = await resolveChannelIdForBinding({
        cfg: params.cfg,
        accountId: manager.accountId,
        token: managerToken,
        threadId: target.id
      }) ?? "";
    } catch {
      return null;
    }
  }
  return await manager.bindTarget({
    threadId: void 0,
    channelId,
    createThread: true,
    threadName: resolveThreadBindingThreadName({
      agentId: params.agentId,
      label: params.label
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
      maxAgeMs: manager.getMaxAgeMs()
    })
  });
}
function unbindThreadBindingsBySessionKey(params) {
  const ids = resolveBindingIdsForTargetSession(params);
  if (ids.length === 0) {
    return [];
  }
  const removed = [];
  for (const bindingKey of ids) {
    const record = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (!record) {
      continue;
    }
    const manager = MANAGERS_BY_ACCOUNT_ID.get(record.accountId);
    if (manager) {
      const unbound2 = manager.unbindThread({
        threadId: record.threadId,
        reason: params.reason,
        sendFarewell: params.sendFarewell,
        farewellText: params.farewellText
      });
      if (unbound2) {
        removed.push(unbound2);
      }
      continue;
    }
    const unbound = removeBindingRecord(bindingKey);
    if (unbound) {
      rememberRecentUnboundWebhookEcho(unbound);
      removed.push(unbound);
    }
  }
  if (removed.length > 0 && shouldPersistBindingMutations()) {
    saveBindingsToDisk({ force: true });
  }
  return removed;
}
function setThreadBindingIdleTimeoutBySessionKey(params) {
  const ids = resolveBindingIdsForTargetSession(params);
  const idleTimeoutMs = normalizeNonNegativeMs(params.idleTimeoutMs);
  return updateBindingsForTargetSession(ids, (existing, now) => ({
    ...existing,
    idleTimeoutMs,
    lastActivityAt: now
  }));
}
function setThreadBindingMaxAgeBySessionKey(params) {
  const ids = resolveBindingIdsForTargetSession(params);
  const maxAgeMs = normalizeNonNegativeMs(params.maxAgeMs);
  return updateBindingsForTargetSession(ids, (existing, now) => ({
    ...existing,
    maxAgeMs,
    boundAt: now,
    lastActivityAt: now
  }));
}
function resolveStoredAcpBindingHealth(params) {
  if (!params.session.acp) {
    return "stale";
  }
  return "healthy";
}
async function reconcileAcpThreadBindingsOnStartup(params) {
  const manager = getThreadBindingManager(params.accountId);
  if (!manager) {
    return {
      checked: 0,
      removed: 0,
      staleSessionKeys: []
    };
  }
  const acpBindings = manager.listBindings().filter((binding) => binding.targetKind === "acp");
  const staleBindings = [];
  const probeTargets = [];
  for (const binding of acpBindings) {
    const sessionKey = binding.targetSessionKey.trim();
    if (!sessionKey) {
      staleBindings.push(binding);
      continue;
    }
    const session = readAcpSessionEntry({
      cfg: params.cfg,
      sessionKey
    });
    if (!session) {
      staleBindings.push(binding);
      continue;
    }
    if (session.storeReadFailed) {
      continue;
    }
    if (resolveStoredAcpBindingHealth({ session }) === "stale") {
      staleBindings.push(binding);
      continue;
    }
    if (!params.healthProbe) {
      continue;
    }
    probeTargets.push({ binding, sessionKey, session });
  }
  if (params.healthProbe && probeTargets.length > 0) {
    const probeResults = await mapWithConcurrency({
      items: probeTargets,
      limit: ACP_STARTUP_HEALTH_PROBE_CONCURRENCY_LIMIT,
      worker: async ({ binding, sessionKey, session }) => {
        try {
          const result = await params.healthProbe?.({
            cfg: params.cfg,
            accountId: manager.accountId,
            sessionKey,
            binding,
            session
          });
          return {
            binding,
            status: result?.status ?? "uncertain"
          };
        } catch {
          return {
            binding,
            status: "uncertain"
          };
        }
      }
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
      staleSessionKeys: []
    };
  }
  const staleSessionKeys = [];
  let removed = 0;
  for (const binding of staleBindings) {
    staleSessionKeys.push(binding.targetSessionKey);
    const unbound = manager.unbindThread({
      threadId: binding.threadId,
      reason: "stale-session",
      sendFarewell: params.sendFarewell ?? false
    });
    if (unbound) {
      removed += 1;
    }
  }
  return {
    checked: acpBindings.length,
    removed,
    staleSessionKeys: [...new Set(staleSessionKeys)]
  };
}
export {
  autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey,
  listThreadBindingsForAccount,
  reconcileAcpThreadBindingsOnStartup,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
  unbindThreadBindingsBySessionKey
};
