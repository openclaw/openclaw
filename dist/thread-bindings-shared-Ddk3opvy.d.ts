import { c as SessionBindingRecord } from "./session-binding.types-cd2c9es6.js";

//#region extensions/matrix/src/matrix/thread-bindings-shared.d.ts
type MatrixThreadBindingTargetKind = "subagent" | "acp";
type MatrixThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetKind: MatrixThreadBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};
type MatrixThreadBindingManager = {
  accountId: string;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversation: (params: {
    conversationId: string;
    parentConversationId?: string;
  }) => MatrixThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => MatrixThreadBindingRecord[];
  listBindings: () => MatrixThreadBindingRecord[];
  touchBinding: (bindingId: string, at?: number) => MatrixThreadBindingRecord | null;
  setIdleTimeoutBySessionKey: (params: {
    targetSessionKey: string;
    idleTimeoutMs: number;
  }) => MatrixThreadBindingRecord[];
  setMaxAgeBySessionKey: (params: {
    targetSessionKey: string;
    maxAgeMs: number;
  }) => MatrixThreadBindingRecord[];
  persist: () => Promise<void>;
  stop: () => void;
};
declare function getMatrixThreadBindingManager(accountId: string): MatrixThreadBindingManager | null;
declare function setMatrixThreadBindingIdleTimeoutBySessionKey(params: {
  accountId: string;
  targetSessionKey: string;
  idleTimeoutMs: number;
}): SessionBindingRecord[];
declare function setMatrixThreadBindingMaxAgeBySessionKey(params: {
  accountId: string;
  targetSessionKey: string;
  maxAgeMs: number;
}): SessionBindingRecord[];
declare function resetMatrixThreadBindingsForTests(): void;
//#endregion
export { setMatrixThreadBindingMaxAgeBySessionKey as a, setMatrixThreadBindingIdleTimeoutBySessionKey as i, getMatrixThreadBindingManager as n, resetMatrixThreadBindingsForTests as r, MatrixThreadBindingManager as t };