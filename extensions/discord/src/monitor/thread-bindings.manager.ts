import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
// Discord plugin module implements thread bindings.manager behavior.
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  getRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  asOptionalObjectRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createDiscordRestClient } from "../client.js";
import { getChannel } from "../internal/discord.js";
import {
  createThreadForBinding,
  createWebhookForChannel,
  findReusableWebhook,
  isDiscordThreadGoneError,
  isThreadArchived,
  maybeSendBindingMessage,
  resolveChannelIdForBinding,
  summarizeDiscordError,
} from "./thread-bindings.discord-api.js";
import {
  resolveThreadBindingFarewellText,
  resolveThreadBindingThreadName,
} from "./thread-bindings.messages.js";
import {
  commitBindingRecord,
  updateBindingRecordSync,
  runThreadBindingMutation,
  runThreadBindingAccountOperation,
  drainThreadBindingAccountOperations,
  drainThreadBindingMutations,
  shouldPersistAnyBindingState,
  snapshotThreadBindingJson,
} from "./thread-bindings.persistence.js";
import { createThreadBindingSessionAdapter } from "./thread-bindings.session-adapter.js";
import {
  BINDINGS_BY_THREAD_ID,
  forgetThreadBindingToken,
  getThreadBindingToken,
  MANAGERS_BY_ACCOUNT_ID,
  PERSIST_BY_ACCOUNT_ID,
  ensureBindingsLoadedAsync,
  rememberThreadBindingToken,
  normalizeTargetKind,
  normalizeThreadBindingDurationMs,
  normalizeThreadId,
  refreshUnboundThreadWebhookIdentity,
  resolveBindingIdsForSession,
  resolveBindingRecordKey,
  toBindingRecordKey,
  resolveThreadBindingIdleTimeoutMs,
  resolvePreparedThreadBindingLifecycle,
  resolveThreadBindingMaxAgeMs,
  THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
  shouldDefaultPersist,
} from "./thread-bindings.state.js";
import {
  DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  THREAD_BINDINGS_SWEEP_INTERVAL_MS,
  type ThreadBindingManager,
  type ThreadBindingRecord,
} from "./thread-bindings.types.js";

function isDirectConversationBindingId(value?: string | null): boolean {
  const trimmed = normalizeOptionalString(value);
  return Boolean(trimmed && /^(user:|channel:)/i.test(trimmed));
}

export async function createThreadBindingManager(input: {
  accountId?: string;
  token?: string;
  cfg: OpenClawConfig;
  persist?: boolean;
  enableSweeper?: boolean;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}): Promise<ThreadBindingManager> {
  const params = { ...input };
  await ensureBindingsLoadedAsync();
  const manager = await runThreadBindingMutation(async () =>
    createLoadedThreadBindingManager(params),
  );
  if (manager.isStopping()) {
    await manager.stop();
    return await createThreadBindingManager(params);
  }
  return manager;
}

function createLoadedThreadBindingManager(
  params: Parameters<typeof createThreadBindingManager>[0],
): ThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    rememberThreadBindingToken({ accountId, token: params.token });
    return existing;
  }

  rememberThreadBindingToken({ accountId, token: params.token });

  const persist = params.persist ?? shouldDefaultPersist();
  PERSIST_BY_ACCOUNT_ID.set(accountId, persist);
  const idleTimeoutMs = normalizeThreadBindingDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeThreadBindingDurationMs(
    params.maxAgeMs,
    DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  );
  const resolveCurrentCfg = () => getRuntimeConfigSnapshot() ?? params.cfg;
  const resolveCurrentToken = () => getThreadBindingToken(accountId) ?? params.token;
  const getCurrentBinding = (threadId: string) =>
    MANAGERS_BY_ACCOUNT_ID.get(accountId) === manager ? manager.getByThreadId(threadId) : undefined;

  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let sweepPromise: Promise<void> | undefined;
  const assertManagerCurrent = () => {
    if (MANAGERS_BY_ACCOUNT_ID.get(accountId) !== manager) {
      throw new Error("Discord thread binding manager was retired");
    }
  };
  const runOwnedMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopping) {
      return Promise.reject(new Error("Discord thread binding manager is stopping"));
    }
    return runThreadBindingAccountOperation([manager], async () => {
      assertManagerCurrent();
      return await operation();
    });
  };
  const mutate = <T>(operation: () => Promise<T>): Promise<T> =>
    runOwnedMutation(() =>
      runThreadBindingMutation(async () => {
        assertManagerCurrent();
        return await operation();
      }),
    );

  let sweepTimer: NodeJS.Timeout | null = null;
  const runSweepOnce = async () => {
    const bindings = manager.listBindings();
    if (bindings.length === 0) {
      return;
    }
    let rest: ReturnType<typeof createDiscordRestClient>["rest"] | null = null;
    for (const snapshotBinding of bindings) {
      // Re-read live state after any awaited work from earlier iterations.
      // This avoids unbinding based on stale snapshot data when activity touches
      // happen while the sweeper loop is in-flight.
      const binding = getCurrentBinding(snapshotBinding.threadId);
      if (!binding || stopping) {
        continue;
      }
      const now = Date.now();
      const lifecycle = resolvePreparedThreadBindingLifecycle({
        record: binding,
        idleTimeoutMs,
        maxAgeMs,
      });
      const { expiresAt, reason } = lifecycle;
      if (expiresAt != null && reason && now >= expiresAt) {
        await manager.unbindThread({
          threadId: binding.threadId,
          expected: binding,
          reason,
          sendFarewell: true,
          farewellText: resolveThreadBindingFarewellText({
            reason,
            idleTimeoutMs: lifecycle.idleTimeoutMs,
            maxAgeMs: lifecycle.maxAgeMs,
          }),
        });
        continue;
      }
      if (isDirectConversationBindingId(binding.threadId)) {
        continue;
      }
      if (!rest) {
        try {
          const cfg = resolveCurrentCfg();
          rest = createDiscordRestClient({
            cfg,
            accountId,
            token: resolveCurrentToken(),
          }).rest;
        } catch {
          return;
        }
      }
      try {
        const channel = await getChannel(rest, binding.threadId);
        // A completed probe only owns the manager and binding that started it.
        if (getCurrentBinding(binding.threadId) !== binding) {
          continue;
        }
        if (!channel || typeof channel !== "object") {
          logVerbose(
            `discord thread binding sweep probe returned invalid payload for ${binding.threadId}`,
          );
          continue;
        }
        if (isThreadArchived(channel)) {
          await manager.unbindThread({
            threadId: binding.threadId,
            expected: binding,
            reason: "thread-archived",
            sendFarewell: true,
          });
        }
      } catch (err) {
        if (getCurrentBinding(binding.threadId) !== binding) {
          continue;
        }
        if (isDiscordThreadGoneError(err)) {
          logVerbose(
            `discord thread binding sweep removing stale binding ${binding.threadId}: ${summarizeDiscordError(err)}`,
          );
          await manager.unbindThread({
            threadId: binding.threadId,
            expected: binding,
            reason: "thread-delete",
            sendFarewell: false,
          });
          continue;
        }
        logVerbose(
          `discord thread binding sweep probe failed for ${binding.threadId}: ${summarizeDiscordError(err)}`,
        );
      }
    }
  };
  const unbindThread = async (
    unbindParams: Parameters<ThreadBindingManager["unbindThread"]>[0],
  ) => {
    const bindingKey = resolveBindingRecordKey({
      accountId,
      threadId: unbindParams.threadId,
    });
    if (!bindingKey) {
      return null;
    }
    const existingLocal = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (
      !existingLocal ||
      existingLocal.accountId !== accountId ||
      (unbindParams.expected && existingLocal !== unbindParams.expected)
    ) {
      return null;
    }
    await commitBindingRecord({
      bindingKey,
      previous: existingLocal,
      next: null,
      persist: unbindParams.persist ?? persist,
      assertCurrent: assertManagerCurrent,
    });
    const removed = existingLocal;
    manager.notifyUnbound(removed, unbindParams);
    return removed;
  };

  const manager: ThreadBindingManager = {
    accountId,
    isStopping: () => stopping,
    notifyUnbound: (removed, notification) => {
      refreshUnboundThreadWebhookIdentity(removed);
      if (notification.sendFarewell !== false) {
        const cfg = resolveCurrentCfg();
        const farewell = resolveThreadBindingFarewellText({
          reason: notification.reason,
          farewellText: notification.farewellText,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
            record: removed,
            defaultIdleTimeoutMs: idleTimeoutMs,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMs({
            record: removed,
            defaultMaxAgeMs: maxAgeMs,
          }),
        });
        // Use bot send path for farewell messages so unbound threads don't process
        // webhook echoes as fresh inbound events when allowBots is enabled.
        if (cfg) {
          void maybeSendBindingMessage({
            cfg,
            record: removed,
            text: farewell,
            preferWebhook: false,
          });
        }
      }
    },
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByThreadId: (threadId) => {
      const key = resolveBindingRecordKey({
        accountId,
        threadId,
      });
      if (!key) {
        return undefined;
      }
      const entry = BINDINGS_BY_THREAD_ID.get(key);
      if (!entry || entry.accountId !== accountId) {
        return undefined;
      }
      return entry;
    },
    getBySessionKey: (targetSessionKey) => {
      const all = manager.listBySessionKey(targetSessionKey);
      return all[0];
    },
    listBySessionKey: (targetSessionKey) => {
      const ids = resolveBindingIdsForSession({
        targetSessionKey,
        accountId,
      });
      return ids
        .map((bindingKey) => BINDINGS_BY_THREAD_ID.get(bindingKey))
        .filter((entry): entry is ThreadBindingRecord => Boolean(entry));
    },
    listBindings: () =>
      [...BINDINGS_BY_THREAD_ID.values()].filter((entry) => entry.accountId === accountId),
    touchThreadSync: (input) => {
      assertManagerCurrent();
      if (stopping) {
        throw new Error("Discord thread binding manager is stopping");
      }
      const key = resolveBindingRecordKey({ accountId, threadId: input.threadId });
      if (!key) {
        return null;
      }
      const at =
        typeof input.at === "number" && Number.isFinite(input.at)
          ? Math.max(0, Math.floor(input.at))
          : Date.now();
      return updateBindingRecordSync({
        bindingKey: key,
        transform: (record) => ({
          ...record,
          lastActivityAt: Math.max(record.lastActivityAt || 0, at),
        }),
        persist: (input.persist ?? persist) && shouldPersistAnyBindingState(),
        minIntervalMs: THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
      });
    },
    touchThread: (input) => {
      const touchParams = {
        ...input,
        at:
          typeof input.at === "number" && Number.isFinite(input.at)
            ? Math.max(0, Math.floor(input.at))
            : Date.now(),
      };
      return mutate(async () => {
        const key = resolveBindingRecordKey({
          accountId,
          threadId: touchParams.threadId,
        });
        if (!key) {
          return null;
        }
        const existingResult = BINDINGS_BY_THREAD_ID.get(key);
        if (!existingResult || existingResult.accountId !== accountId) {
          return null;
        }
        const nextRecord: ThreadBindingRecord = {
          ...existingResult,
          lastActivityAt: Math.max(existingResult.lastActivityAt || 0, touchParams.at),
        };
        await commitBindingRecord({
          bindingKey: key,
          previous: existingResult,
          next: nextRecord,
          persist: (touchParams.persist ?? persist) && shouldPersistAnyBindingState(),
          minIntervalMs: THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
          assertCurrent: assertManagerCurrent,
        });
        return nextRecord;
      });
    },
    bindTarget: async (input) => {
      const bindParams = {
        ...input,
        metadata: asOptionalObjectRecord(
          snapshotThreadBindingJson(input.metadata ? { ...input.metadata } : undefined),
        ),
      };
      return runOwnedMutation(async () => {
        const assertCurrent = bindParams.assertCurrent;
        assertCurrent?.();
        const cfg = resolveCurrentCfg();
        let threadId = normalizeThreadId(bindParams.threadId);
        let channelId = normalizeOptionalString(bindParams.channelId) ?? "";
        const directConversationBinding =
          isDirectConversationBindingId(threadId) || isDirectConversationBindingId(channelId);
        let nativeBindingCreated = false;
        const targetSessionKey = normalizeOptionalString(bindParams.targetSessionKey) ?? "";
        if (!targetSessionKey) {
          return null;
        }
        const targetKind = normalizeTargetKind(bindParams.targetKind, targetSessionKey);
        let agentId = normalizeOptionalString(bindParams.agentId);

        if (!threadId && bindParams.createThread) {
          if (!channelId) {
            return null;
          }
          agentId ??= resolveSessionAgentIdStrict({ config: cfg, sessionKey: targetSessionKey });
          const threadName = resolveThreadBindingThreadName({
            agentId: bindParams.agentId,
            label: bindParams.label,
          });
          threadId =
            (await createThreadForBinding({
              cfg,
              accountId,
              token: resolveCurrentToken(),
              channelId,
              threadName: normalizeOptionalString(bindParams.threadName) ?? threadName,
              ...(assertCurrent ? { assertCreateAllowed: assertCurrent } : {}),
            })) ?? undefined;
          nativeBindingCreated = Boolean(threadId);
        }

        if (!threadId) {
          return null;
        }

        if (!channelId && directConversationBinding) {
          channelId = threadId;
        }

        if (!channelId) {
          channelId =
            (await resolveChannelIdForBinding({
              cfg,
              accountId,
              token: resolveCurrentToken(),
              threadId,
              channelId: bindParams.channelId,
            })) ?? "";
        }
        if (!channelId) {
          return null;
        }

        const existingValue = manager.getByThreadId(threadId);
        const previous =
          existingValue?.targetSessionKey === targetSessionKey &&
          existingValue.targetKind === targetKind
            ? existingValue
            : undefined;
        agentId ??=
          normalizeOptionalString(previous?.agentId) ??
          resolveSessionAgentIdStrict({ config: cfg, sessionKey: targetSessionKey });
        let webhookId =
          normalizeOptionalString(bindParams.webhookId) ??
          normalizeOptionalString(existingValue?.webhookId) ??
          "";
        let webhookToken =
          normalizeOptionalString(bindParams.webhookToken) ??
          normalizeOptionalString(existingValue?.webhookToken) ??
          "";
        if (!directConversationBinding && (!webhookId || !webhookToken)) {
          const cachedWebhook = findReusableWebhook({ accountId, channelId });
          webhookId = cachedWebhook.webhookId ?? "";
          webhookToken = cachedWebhook.webhookToken ?? "";
        }
        if (!directConversationBinding && (!webhookId || !webhookToken)) {
          const createdWebhook = await createWebhookForChannel({
            cfg,
            accountId,
            token: resolveCurrentToken(),
            channelId,
            ...(assertCurrent ? { assertCreateAllowed: assertCurrent } : {}),
          });
          webhookId = createdWebhook.webhookId ?? "";
          webhookToken = createdWebhook.webhookToken ?? "";
          nativeBindingCreated ||= Boolean(webhookId && webhookToken);
        }

        const now = Date.now();
        const record: ThreadBindingRecord = {
          accountId,
          channelId,
          threadId,
          targetKind,
          targetSessionKey,
          agentId,
          label:
            normalizeOptionalString(bindParams.label) ?? normalizeOptionalString(previous?.label),
          webhookId: webhookId || undefined,
          webhookToken: webhookToken || undefined,
          boundBy:
            normalizeOptionalString(bindParams.boundBy) ??
            normalizeOptionalString(previous?.boundBy) ??
            "system",
          boundAt: now,
          lastActivityAt: now,
          idleTimeoutMs:
            typeof existingValue?.idleTimeoutMs === "number"
              ? existingValue.idleTimeoutMs
              : idleTimeoutMs,
          maxAgeMs: typeof existingValue?.maxAgeMs === "number" ? existingValue.maxAgeMs : maxAgeMs,
          metadata: { ...previous?.metadata, ...bindParams.metadata },
        };

        // A confirmed native create must be published even if its initiator was revoked in flight.
        if (!nativeBindingCreated) {
          assertCurrent?.();
        }
        await runThreadBindingMutation(() =>
          commitBindingRecord({
            bindingKey: toBindingRecordKey({ accountId, threadId }),
            previous: existingValue,
            next: record,
            persist,
            assertCurrent: () => {
              assertManagerCurrent();
              if (!nativeBindingCreated) {
                assertCurrent?.();
              }
            },
          }),
        );

        const introText = bindParams.introText?.trim();
        if (introText && cfg) {
          void maybeSendBindingMessage({
            cfg,
            record,
            text: introText,
            assertCurrent: () => {
              assertCurrent?.();
              const current = getCurrentBinding(record.threadId);
              if (
                !current ||
                current.targetSessionKey !== record.targetSessionKey ||
                current.targetKind !== record.targetKind
              ) {
                throw new Error("Discord thread binding changed before its intro");
              }
            },
          });
        }
        return record;
      });
    },
    unbindThread: (input) => {
      const unbindParams = { ...input };
      return mutate(() => unbindThread(unbindParams));
    },
    unbindBySessionKey: (input) => {
      const unbindParams = { ...input };
      return mutate(async () => {
        const ids = resolveBindingIdsForSession({
          targetSessionKey: unbindParams.targetSessionKey,
          accountId,
          targetKind: unbindParams.targetKind,
        });
        if (ids.length === 0) {
          return [];
        }
        const removed: ThreadBindingRecord[] = [];
        for (const bindingKey of ids) {
          const binding = BINDINGS_BY_THREAD_ID.get(bindingKey);
          if (!binding) {
            continue;
          }
          const entry = await unbindThread({
            threadId: binding.threadId,
            reason: unbindParams.reason,
            sendFarewell: unbindParams.sendFarewell,
            farewellText: unbindParams.farewellText,
          });
          if (entry) {
            removed.push(entry);
          }
        }
        return removed;
      });
    },
    stop: () => {
      if (stopPromise) {
        return stopPromise;
      }
      stopping = true;
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      stopPromise = (async () => {
        await sweepPromise;
        await drainThreadBindingAccountOperations(manager);
        await drainThreadBindingMutations();
        if (MANAGERS_BY_ACCOUNT_ID.get(accountId) === manager) {
          MANAGERS_BY_ACCOUNT_ID.delete(accountId);
          forgetThreadBindingToken(accountId);
        }
        unregisterSessionBindingAdapter({
          channel: "discord",
          accountId,
          adapter: sessionBindingAdapter,
        });
      })();
      return stopPromise;
    },
  };

  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      if (stopping || sweepPromise) {
        return;
      }
      sweepPromise = runSweepOnce()
        .catch((error: unknown) => {
          logVerbose(`discord thread binding sweep failed: ${String(error)}`);
        })
        .finally(() => {
          sweepPromise = undefined;
        });
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    // Keep the production process free to exit, but avoid breaking fake-timer
    // sweeper tests where unref'd intervals may never fire.
    if (!(process.env.VITEST || process.env.NODE_ENV === "test")) {
      sweepTimer.unref?.();
    }
  }

  const sessionBindingAdapter = createThreadBindingSessionAdapter({
    accountId,
    manager,
    defaults: { idleTimeoutMs, maxAgeMs },
    resolveCurrentCfg,
    resolveCurrentToken,
  });

  registerSessionBindingAdapter(sessionBindingAdapter);

  MANAGERS_BY_ACCOUNT_ID.set(accountId, manager);
  return manager;
}

export function getThreadBindingManager(accountId?: string): ThreadBindingManager | null {
  const normalized = normalizeAccountId(accountId);
  return MANAGERS_BY_ACCOUNT_ID.get(normalized) ?? null;
}
