import { Vt as AcpRuntimeSessionMode, i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { t as ChannelId } from "./channel-id.types-Bpcqw8ci.js";
import { c as SessionBindingRecord } from "./session-binding.types-CfVgcF6b.js";

//#region src/acp/persistent-bindings.types.d.ts
type ConfiguredAcpBindingChannel = ChannelId;
type ConfiguredAcpBindingSpec = {
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string; /** Owning OpenClaw agent id (used for session identity/storage). */
  agentId: string; /** ACP harness agent id override (falls back to agentId when omitted). */
  acpAgentId?: string;
  mode: AcpRuntimeSessionMode;
  cwd?: string;
  backend?: string;
  label?: string;
};
type ResolvedConfiguredAcpBinding = {
  spec: ConfiguredAcpBindingSpec;
  record: SessionBindingRecord;
};
//#endregion
//#region src/acp/persistent-bindings.resolve.d.ts
declare function resolveConfiguredAcpBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ResolvedConfiguredAcpBinding | null;
//#endregion
export { ResolvedConfiguredAcpBinding as n, resolveConfiguredAcpBindingRecord as t };