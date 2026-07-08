// Feishu plugin module implements source-message recall cancellation.
import type { PluginRuntime } from "../runtime-api.js";

const FEISHU_CHANNEL_ID = "feishu";
const FEISHU_SOURCE_MESSAGE_RECALL_CAPABILITY = "source-message-recall";
const RECALL_TTL_MS = 30 * 60 * 1000;
const MAX_RECALLED_MESSAGES = 2_000;

type SourceMessageRunBinding = {
  controller: AbortController;
};

type SourceMessageState = {
  bindings: Map<symbol, SourceMessageRunBinding>;
  recalledAt?: number;
  updatedAt: number;
};

export type FeishuSourceMessageRecallRegistry = {
  bindRun: (params: { messageId: string }) => {
    abortSignal: AbortSignal;
    dispose: () => void;
  };
  isRecalled: (messageId: string) => boolean;
  markRecalled: (messageId: string) => { abortedRuns: number; alreadyRecalled: boolean };
};

function normalizeSourceMessageId(messageId: string | undefined | null): string | undefined {
  const trimmed = messageId?.trim();
  return trimmed || undefined;
}

function normalizeAccountId(accountId: string | undefined | null): string | undefined {
  const trimmed = accountId?.trim();
  return trimmed || undefined;
}

function createAbortReason(messageId: string): Error {
  return new Error(`Feishu source message ${messageId} was recalled`);
}

function pruneRegistry(states: Map<string, SourceMessageState>, now = Date.now()): void {
  for (const [messageId, state] of states) {
    const hasBindings = state.bindings.size > 0;
    const recalledAt = state.recalledAt;
    if (!hasBindings && recalledAt !== undefined && now - recalledAt > RECALL_TTL_MS) {
      states.delete(messageId);
    }
  }

  if (states.size <= MAX_RECALLED_MESSAGES) {
    return;
  }
  const removable = Array.from(states.entries())
    .filter(([, state]) => state.bindings.size === 0)
    .toSorted(([, left], [, right]) => left.updatedAt - right.updatedAt)
    .slice(0, states.size - MAX_RECALLED_MESSAGES);
  for (const [messageId] of removable) {
    states.delete(messageId);
  }
}

function createFeishuSourceMessageRecallRegistry(): FeishuSourceMessageRecallRegistry {
  const states = new Map<string, SourceMessageState>();

  const getOrCreateState = (messageId: string, now = Date.now()): SourceMessageState => {
    pruneRegistry(states, now);
    const existing = states.get(messageId);
    if (existing) {
      existing.updatedAt = now;
      return existing;
    }
    const state: SourceMessageState = {
      bindings: new Map(),
      updatedAt: now,
    };
    states.set(messageId, state);
    return state;
  };

  return {
    bindRun: ({ messageId }) => {
      const normalizedMessageId = normalizeSourceMessageId(messageId);
      const controller = new AbortController();
      if (!normalizedMessageId) {
        return {
          abortSignal: controller.signal,
          dispose: () => {},
        };
      }

      const token = Symbol(normalizedMessageId);
      const state = getOrCreateState(normalizedMessageId);
      const recalled = state.recalledAt !== undefined;
      const binding: SourceMessageRunBinding = {
        controller,
      };
      if (!recalled) {
        state.bindings.set(token, binding);
      } else {
        controller.abort(createAbortReason(normalizedMessageId));
      }

      return {
        abortSignal: controller.signal,
        dispose: () => {
          state.bindings.delete(token);
          state.updatedAt = Date.now();
          if (state.bindings.size === 0 && state.recalledAt === undefined) {
            states.delete(normalizedMessageId);
          }
        },
      };
    },
    isRecalled: (messageId) => {
      const normalizedMessageId = normalizeSourceMessageId(messageId);
      if (!normalizedMessageId) {
        return false;
      }
      pruneRegistry(states);
      return states.get(normalizedMessageId)?.recalledAt !== undefined;
    },
    markRecalled: (messageId) => {
      const normalizedMessageId = normalizeSourceMessageId(messageId);
      if (!normalizedMessageId) {
        return { abortedRuns: 0, alreadyRecalled: false };
      }
      const now = Date.now();
      const state = getOrCreateState(normalizedMessageId, now);
      const alreadyRecalled = state.recalledAt !== undefined;
      state.recalledAt = state.recalledAt ?? now;
      state.updatedAt = now;
      let abortedRuns = 0;
      for (const binding of state.bindings.values()) {
        if (!binding.controller.signal.aborted) {
          binding.controller.abort(createAbortReason(normalizedMessageId));
          abortedRuns += 1;
        }
      }
      return { abortedRuns, alreadyRecalled };
    },
  };
}

export function getFeishuSourceMessageRecallRegistry(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
}): FeishuSourceMessageRecallRegistry | undefined {
  const accountId = normalizeAccountId(params.accountId);
  const runtimeContexts = params.channelRuntime?.runtimeContexts;
  if (!runtimeContexts || !accountId) {
    return undefined;
  }
  const key = {
    channelId: FEISHU_CHANNEL_ID,
    accountId,
    capability: FEISHU_SOURCE_MESSAGE_RECALL_CAPABILITY,
  };
  const existing = runtimeContexts.get<FeishuSourceMessageRecallRegistry>(key);
  if (existing) {
    return existing;
  }
  const registry = createFeishuSourceMessageRecallRegistry();
  runtimeContexts.register({
    ...key,
    context: registry,
  });
  return registry;
}

export function isFeishuSourceMessageRecalled(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
  messageId?: string | null;
}): boolean {
  const messageId = normalizeSourceMessageId(params.messageId);
  if (!messageId) {
    return false;
  }
  return (
    getFeishuSourceMessageRecallRegistry({
      channelRuntime: params.channelRuntime,
      accountId: params.accountId,
    })?.isRecalled(messageId) ?? false
  );
}

export function recallFeishuSourceMessage(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
  messageId?: string | null;
}): { abortedRuns: number; alreadyRecalled: boolean; recorded: boolean } {
  const messageId = normalizeSourceMessageId(params.messageId);
  if (!messageId) {
    return { abortedRuns: 0, alreadyRecalled: false, recorded: false };
  }
  const result = getFeishuSourceMessageRecallRegistry({
    channelRuntime: params.channelRuntime,
    accountId: params.accountId,
  })?.markRecalled(messageId);
  return result
    ? { ...result, recorded: true }
    : { abortedRuns: 0, alreadyRecalled: false, recorded: false };
}

export function bindFeishuSourceMessageRun(params: {
  channelRuntime?: PluginRuntime["channel"];
  accountId?: string | null;
  messageId?: string | null;
}): ReturnType<FeishuSourceMessageRecallRegistry["bindRun"]> | undefined {
  const messageId = normalizeSourceMessageId(params.messageId);
  if (!messageId) {
    return undefined;
  }
  return getFeishuSourceMessageRecallRegistry({
    channelRuntime: params.channelRuntime,
    accountId: params.accountId,
  })?.bindRun({
    messageId,
  });
}

export function composeFeishuSourceMessageAbortSignal(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const activeSignals = signals.filter(
    (signal, index): signal is AbortSignal => Boolean(signal) && signals.indexOf(signal) === index,
  );
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}
