import { tn as AgentBinding } from "./types.openclaw-BLF4DJTX.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { _ as ChannelConfiguredBindingConversationRef, v as ChannelConfiguredBindingMatch, y as ChannelConfiguredBindingProvider } from "./types.adapters-y0dBEomF.js";
import { c as SessionBindingRecord, r as ConversationRef } from "./session-binding.types-cd2c9es6.js";

//#region src/channels/plugins/binding-types.d.ts
type ConfiguredBindingConversation = ConversationRef;
type ConfiguredBindingChannel = ChannelId;
type ConfiguredBindingRuleConfig = AgentBinding;
type StatefulBindingTargetDescriptor = {
  kind: "stateful";
  driverId: string;
  sessionKey: string;
  agentId: string;
  label?: string;
};
type ConfiguredBindingRecordResolution = {
  record: SessionBindingRecord;
  statefulTarget: StatefulBindingTargetDescriptor;
};
type ConfiguredBindingTargetFactory = {
  driverId: string;
  materialize: (params: {
    accountId: string;
    conversation: ChannelConfiguredBindingConversationRef;
  }) => ConfiguredBindingRecordResolution;
};
type CompiledConfiguredBinding = {
  channel: ConfiguredBindingChannel;
  accountPattern?: string;
  binding: ConfiguredBindingRuleConfig;
  bindingConversationId: string;
  target: ChannelConfiguredBindingConversationRef;
  agentId: string;
  provider: ChannelConfiguredBindingProvider;
  targetFactory: ConfiguredBindingTargetFactory;
};
type ConfiguredBindingResolution = ConfiguredBindingRecordResolution & {
  conversation: ConfiguredBindingConversation;
  compiledBinding: CompiledConfiguredBinding;
  match: ChannelConfiguredBindingMatch;
};
//#endregion
export { StatefulBindingTargetDescriptor as a, ConfiguredBindingResolution as i, ConfiguredBindingConversation as n, ConfiguredBindingRecordResolution as r, CompiledConfiguredBinding as t };