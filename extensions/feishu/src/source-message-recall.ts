// Feishu plugin module implements source-message recall cancellation.
import {
  getChannelRuntimeContext,
  registerChannelRuntimeContext,
} from "openclaw/plugin-sdk/channel-runtime-context";
import type { PluginRuntime } from "../runtime-api.js";

const RUNTIME_CONTEXT_KEY = {
  channelId: "feishu",
  capability: "source-message-recall",
} as const;
const RECALL_TTL_MS = 30 * 60 * 1000;
const MAX_RECALLED_MESSAGES = 2_000;

type SourceMessageState = {
  controllers: Set<AbortController>;
  recalledAt?: number;
  touchedAt: number;
};

type RecallRegistry = {
  states: Map<string, SourceMessageState>;
};

function normalize(value: string | undefined | null): string | undefined {
  return value?.trim() || undefined;
}

function pruneRegistry(registry: RecallRegistry, now = Date.now()): void {
  for (const [messageId, state] of registry.states) {
    if (
      state.controllers.size === 0 &&
      state.recalledAt !== undefined &&
      now - state.recalledAt > RECALL_TTL_MS
    ) {
      registry.states.delete(messageId);
    }
  }
  if (registry.states.size <= MAX_RECALLED_MESSAGES) {
    return;
  }
  const removable = [...registry.states]
    .filter(([, state]) => state.controllers.size === 0)
    .toSorted(([, left], [, right]) => left.touchedAt - right.touchedAt);
  for (const [messageId] of removable) {
    if (registry.states.size <= MAX_RECALLED_MESSAGES) {
      break;
    }
    registry.states.delete(messageId);
  }
}

function resolveRegistry(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
}): RecallRegistry | undefined {
  const accountId = normalize(params.accountId);
  if (!params.channelRuntime || !accountId) {
    return undefined;
  }
  const key = { ...RUNTIME_CONTEXT_KEY, accountId };
  const existing = getChannelRuntimeContext({
    channelRuntime: params.channelRuntime,
    ...key,
  }) as RecallRegistry | undefined;
  if (existing) {
    return existing;
  }
  const registry: RecallRegistry = { states: new Map() };
  const lease = registerChannelRuntimeContext({
    channelRuntime: params.channelRuntime,
    ...key,
    context: registry,
  });
  return lease ? registry : undefined;
}

function resolveState(registry: RecallRegistry, messageId: string, now = Date.now()) {
  pruneRegistry(registry, now);
  const existing = registry.states.get(messageId);
  if (existing) {
    existing.touchedAt = now;
    return existing;
  }
  const state: SourceMessageState = {
    controllers: new Set(),
    touchedAt: now,
  };
  registry.states.set(messageId, state);
  return state;
}

export function isFeishuSourceMessageRecalled(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
  messageId?: string | null;
}): boolean {
  const messageId = normalize(params.messageId);
  const registry = resolveRegistry(params);
  if (!messageId || !registry) {
    return false;
  }
  pruneRegistry(registry);
  return registry.states.get(messageId)?.recalledAt !== undefined;
}

export function recallFeishuSourceMessage(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
  messageId?: string | null;
}): { abortedRuns: number; alreadyRecalled: boolean; recorded: boolean } {
  const messageId = normalize(params.messageId);
  const registry = resolveRegistry(params);
  if (!messageId || !registry) {
    return { abortedRuns: 0, alreadyRecalled: false, recorded: false };
  }
  const now = Date.now();
  const state = resolveState(registry, messageId, now);
  const alreadyRecalled = state.recalledAt !== undefined;
  state.recalledAt ??= now;
  let abortedRuns = 0;
  for (const controller of state.controllers) {
    if (!controller.signal.aborted) {
      controller.abort(new Error(`Feishu source message ${messageId} was recalled`));
      abortedRuns += 1;
    }
  }
  return { abortedRuns, alreadyRecalled, recorded: true };
}

export function bindFeishuSourceMessageRun(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
  messageId?: string | null;
}): { abortSignal: AbortSignal; dispose: () => void } | undefined {
  const messageId = normalize(params.messageId);
  const registry = resolveRegistry(params);
  if (!messageId || !registry) {
    return undefined;
  }
  const controller = new AbortController();
  const state = resolveState(registry, messageId);
  if (state.recalledAt !== undefined) {
    controller.abort(new Error(`Feishu source message ${messageId} was recalled`));
  } else {
    state.controllers.add(controller);
  }
  let disposed = false;
  return {
    abortSignal: controller.signal,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      state.controllers.delete(controller);
      state.touchedAt = Date.now();
      if (state.controllers.size === 0 && state.recalledAt === undefined) {
        registry.states.delete(messageId);
      }
    },
  };
}
