import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { T as ReplyToMode } from "./types.base-DS--yneR.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";
import { R as ChannelThreadingAdapter } from "./types.core-BkmTlRzr.js";
import { a as SessionBindingCapabilities, c as SessionBindingRecord, i as SessionBindingBindInput, l as SessionBindingUnbindInput, r as ConversationRef } from "./session-binding.types-cd2c9es6.js";
import { t as PairingChannel } from "./pairing-store.types-Drbj8_It.js";
import { i as ConfiguredBindingResolution, r as ConfiguredBindingRecordResolution } from "./binding-types-DQsJy66I.js";
//#region src/bindings/records.d.ts
declare function createConversationBindingRecord(input: SessionBindingBindInput): Promise<SessionBindingRecord>;
declare function getConversationBindingCapabilities(params: {
  channel: string;
  accountId: string;
}): SessionBindingCapabilities;
declare function listSessionBindingRecords(targetSessionKey: string): SessionBindingRecord[];
declare function resolveConversationBindingRecord(conversation: ConversationRef): SessionBindingRecord | null;
declare function touchConversationBindingRecord(bindingId: string, at?: number): void;
declare function unbindConversationBindingRecord(input: SessionBindingUnbindInput): Promise<SessionBindingRecord[]>;
//#endregion
//#region src/channels/plugins/configured-binding-registry.d.ts
declare function primeConfiguredBindingRegistry$1(params: {
  cfg: OpenClawConfig;
}): {
  bindingCount: number;
  channelCount: number;
};
declare function resolveConfiguredBindingRecord$1(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ConfiguredBindingRecordResolution | null;
declare function resolveConfiguredBindingRecordForConversation$1(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): ConfiguredBindingRecordResolution | null;
declare function resolveConfiguredBinding$1(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): ConfiguredBindingResolution | null;
declare function resolveConfiguredBindingRecordBySessionKey$1(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): ConfiguredBindingRecordResolution | null;
//#endregion
//#region src/channels/plugins/binding-registry.d.ts
declare function primeConfiguredBindingRegistry(...args: Parameters<typeof primeConfiguredBindingRegistry$1>): ReturnType<typeof primeConfiguredBindingRegistry$1>;
declare function resolveConfiguredBindingRecord(...args: Parameters<typeof resolveConfiguredBindingRecord$1>): ReturnType<typeof resolveConfiguredBindingRecord$1>;
declare function resolveConfiguredBindingRecordForConversation(...args: Parameters<typeof resolveConfiguredBindingRecordForConversation$1>): ReturnType<typeof resolveConfiguredBindingRecordForConversation$1>;
declare function resolveConfiguredBinding(...args: Parameters<typeof resolveConfiguredBinding$1>): ReturnType<typeof resolveConfiguredBinding$1>;
declare function resolveConfiguredBindingRecordBySessionKey(...args: Parameters<typeof resolveConfiguredBindingRecordBySessionKey$1>): ReturnType<typeof resolveConfiguredBindingRecordBySessionKey$1>;
//#endregion
//#region src/channels/plugins/binding-targets.d.ts
declare function ensureConfiguredBindingTargetReady(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution | null;
}): Promise<{
  ok: true;
} | {
  ok: false;
  error: string;
}>;
declare function resetConfiguredBindingTargetInPlace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: "new" | "reset";
  commandSource?: string;
}): Promise<{
  ok: true;
} | {
  ok: false;
  skipped?: boolean;
  error?: string;
}>;
declare function ensureConfiguredBindingTargetSession(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution;
}): Promise<{
  ok: true;
  sessionKey: string;
} | {
  ok: false;
  sessionKey: string;
  error: string;
}>;
//#endregion
//#region src/channels/conversation-label.d.ts
declare function resolveConversationLabel(ctx: MsgContext): string | undefined;
//#endregion
//#region src/channels/session-meta.d.ts
declare function recordInboundSessionMetaSafe(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  ctx: MsgContext;
  onError?: (error: unknown) => void;
}): Promise<void>;
//#endregion
//#region src/channels/plugins/threading-helpers.d.ts
type ReplyToModeResolver = NonNullable<ChannelThreadingAdapter["resolveReplyToMode"]>;
declare function createStaticReplyToModeResolver(mode: ReplyToMode): ReplyToModeResolver;
declare function createTopLevelChannelReplyToModeResolver(channelId: string): ReplyToModeResolver;
declare function createScopedAccountReplyToModeResolver<TAccount>(params: {
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
  resolveReplyToMode: (account: TAccount, chatType?: string | null) => ReplyToMode | null | undefined;
  fallback?: ReplyToMode;
}): ReplyToModeResolver;
//#endregion
//#region src/pairing/pairing-labels.d.ts
declare function resolvePairingIdLabel(channel: PairingChannel): string;
//#endregion
export { listSessionBindingRecords as _, recordInboundSessionMetaSafe as a, unbindConversationBindingRecord as b, ensureConfiguredBindingTargetSession as c, resolveConfiguredBinding as d, resolveConfiguredBindingRecord as f, getConversationBindingCapabilities as g, createConversationBindingRecord as h, createTopLevelChannelReplyToModeResolver as i, resetConfiguredBindingTargetInPlace as l, resolveConfiguredBindingRecordForConversation as m, createScopedAccountReplyToModeResolver as n, resolveConversationLabel as o, resolveConfiguredBindingRecordBySessionKey as p, createStaticReplyToModeResolver as r, ensureConfiguredBindingTargetReady as s, resolvePairingIdLabel as t, primeConfiguredBindingRegistry as u, resolveConversationBindingRecord as v, touchConversationBindingRecord as y };