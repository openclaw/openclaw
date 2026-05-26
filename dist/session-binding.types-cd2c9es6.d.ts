//#region src/infra/outbound/session-binding.types.d.ts
type BindingTargetKind = "subagent" | "session";
type BindingStatus = "active" | "ending" | "ended";
type SessionBindingPlacement = "current" | "child";
type SessionBindingErrorCode = "BINDING_ADAPTER_UNAVAILABLE" | "BINDING_CAPABILITY_UNSUPPORTED" | "BINDING_CREATE_FAILED";
type ConversationRef = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};
type SessionBindingRecord = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  status: BindingStatus;
  boundAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};
type SessionBindingBindInput = {
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  conversation: ConversationRef;
  placement?: SessionBindingPlacement;
  metadata?: Record<string, unknown>;
  ttlMs?: number;
};
type SessionBindingUnbindInput = {
  bindingId?: string;
  targetSessionKey?: string;
  reason: string;
};
type SessionBindingCapabilities = {
  adapterAvailable: boolean;
  bindSupported: boolean;
  unbindSupported: boolean;
  placements: SessionBindingPlacement[];
};
//#endregion
export { SessionBindingCapabilities as a, SessionBindingRecord as c, SessionBindingBindInput as i, SessionBindingUnbindInput as l, BindingTargetKind as n, SessionBindingErrorCode as o, ConversationRef as r, SessionBindingPlacement as s, BindingStatus as t };