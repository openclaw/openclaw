export type PumbleThreadBindingRecord = {
  accountId: string;
  channelId: string;
  threadRootId: string;
  targetKind: "subagent";
  targetSessionKey: string;
  agentId: string;
  label?: string;
  boundBy: string;
  boundAt: number;
  expiresAt?: number;
};

export type PersistedPumbleThreadBindingsPayload = {
  version: 1;
  bindings: Record<string, PumbleThreadBindingRecord>;
};

export type PumbleThreadBindingManager = {
  accountId: string;
  getSessionTtlMs: () => number;
  getByThreadRootId: (threadRootId: string) => PumbleThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => PumbleThreadBindingRecord[];
  listBindings: () => PumbleThreadBindingRecord[];
  bindTarget: (params: {
    channelId: string;
    targetSessionKey: string;
    agentId?: string;
    label?: string;
    boundBy?: string;
    introText?: string;
    /** When set, posts the intro as a reply in the given thread and binds to it. */
    replyToId?: string;
    /** When false and replyToId is set, skip the intro POST and use replyToId directly. */
    sendIntro?: boolean;
  }) => Promise<PumbleThreadBindingRecord | null>;
  unbindThread: (params: {
    threadRootId: string;
    reason?: string;
    sendFarewell?: boolean;
  }) => PumbleThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    reason?: string;
    sendFarewell?: boolean;
  }) => PumbleThreadBindingRecord[];
  stop: () => void;
};

export const PUMBLE_THREAD_BINDINGS_VERSION = 1 as const;
export const PUMBLE_THREAD_BINDINGS_SWEEP_INTERVAL_MS = 120_000;
export const DEFAULT_PUMBLE_THREAD_BINDING_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PUMBLE_FAREWELL_TEXT =
  "Session ended. Messages here will no longer be routed.";
