export type FeishuThreadBindingTargetKind = "subagent" | "acp";

export type FeishuThreadBindingRecord = {
  accountId: string;
  chatId: string; // group chat ID (oc_xxx)
  rootId: string; // message ID anchoring the topic thread
  targetKind: FeishuThreadBindingTargetKind;
  targetSessionKey: string;
  agentId: string;
  label?: string;
  boundBy: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

export type PersistedFeishuThreadBindingsPayload = {
  version: number;
  bindings: Record<string, FeishuThreadBindingRecord>;
};

export const FEISHU_THREAD_BINDINGS_VERSION = 1 as const;
export const FEISHU_THREAD_BINDINGS_SWEEP_INTERVAL_MS = 120_000;
export const DEFAULT_FEISHU_THREAD_BINDING_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h
export const DEFAULT_FEISHU_THREAD_BINDING_MAX_AGE_MS = 0; // disabled
export const FEISHU_THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS = 15_000;
