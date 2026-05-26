import { a as SessionBindingCapabilities, c as SessionBindingRecord, i as SessionBindingBindInput, l as SessionBindingUnbindInput, o as SessionBindingErrorCode, r as ConversationRef, s as SessionBindingPlacement } from "./session-binding.types-cd2c9es6.js";

//#region src/infra/outbound/session-binding-service.d.ts
declare class SessionBindingError extends Error {
  readonly code: SessionBindingErrorCode;
  readonly details?: {
    channel?: string;
    accountId?: string;
    placement?: SessionBindingPlacement;
  } | undefined;
  constructor(code: SessionBindingErrorCode, message: string, details?: {
    channel?: string;
    accountId?: string;
    placement?: SessionBindingPlacement;
  } | undefined);
}
declare function isSessionBindingError(error: unknown): error is SessionBindingError;
type SessionBindingService = {
  bind: (input: SessionBindingBindInput) => Promise<SessionBindingRecord>;
  getCapabilities: (params: {
    channel: string;
    accountId: string;
  }) => SessionBindingCapabilities;
  listBySession: (targetSessionKey: string) => SessionBindingRecord[];
  resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
  touch: (bindingId: string, at?: number) => void;
  unbind: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};
type SessionBindingAdapterCapabilities = {
  placements?: SessionBindingPlacement[];
  bindSupported?: boolean;
  unbindSupported?: boolean;
};
type SessionBindingAdapter = {
  channel: string;
  accountId: string;
  capabilities?: SessionBindingAdapterCapabilities;
  bind?: (input: SessionBindingBindInput) => Promise<SessionBindingRecord | null>;
  listBySession: (targetSessionKey: string) => SessionBindingRecord[];
  resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
  touch?: (bindingId: string, at?: number) => void;
  unbind?: (input: SessionBindingUnbindInput) => Promise<SessionBindingRecord[]>;
};
declare function registerSessionBindingAdapter(adapter: SessionBindingAdapter): void;
declare function unregisterSessionBindingAdapter(params: {
  channel: string;
  accountId: string;
  adapter?: SessionBindingAdapter;
}): void;
declare function getSessionBindingService(): SessionBindingService;
declare const testing: {
  resetSessionBindingAdaptersForTests(): void;
  getRegisteredAdapterKeys(): string[];
};
//#endregion
export { getSessionBindingService as a, testing as c, SessionBindingService as i, unregisterSessionBindingAdapter as l, SessionBindingAdapterCapabilities as n, isSessionBindingError as o, SessionBindingError as r, registerSessionBindingAdapter as s, SessionBindingAdapter as t };