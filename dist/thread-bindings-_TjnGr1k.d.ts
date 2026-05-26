import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
//#region extensions/telegram/src/thread-bindings.d.ts
type TelegramBindingTargetKind = "subagent" | "acp";
type TelegramThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  targetKind: TelegramBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  metadata?: Record<string, unknown>;
};
type TelegramThreadBindingManager = {
  accountId: string;
  shouldPersistMutations: () => boolean;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversationId: (conversationId: string) => TelegramThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => TelegramThreadBindingRecord[];
  listBindings: () => TelegramThreadBindingRecord[];
  touchConversation: (conversationId: string, at?: number) => TelegramThreadBindingRecord | null;
  unbindConversation: (params: {
    conversationId: string;
    reason?: string;
    sendFarewell?: boolean;
  }) => TelegramThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    reason?: string;
    sendFarewell?: boolean;
  }) => TelegramThreadBindingRecord[];
  stop: () => void;
};
declare function createTelegramThreadBindingManager(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  persist?: boolean;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  enableSweeper?: boolean;
}): TelegramThreadBindingManager;
declare function getTelegramThreadBindingManager(accountId?: string): TelegramThreadBindingManager | null;
declare function setTelegramThreadBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): TelegramThreadBindingRecord[];
declare function setTelegramThreadBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): TelegramThreadBindingRecord[];
declare function resetTelegramThreadBindingsForTests(): Promise<void>;
//#endregion
export { setTelegramThreadBindingMaxAgeBySessionKey as a, setTelegramThreadBindingIdleTimeoutBySessionKey as i, getTelegramThreadBindingManager as n, resetTelegramThreadBindingsForTests as r, createTelegramThreadBindingManager as t };