import { n as ChannelConfigSchema } from "./types.config-CKJTcS4X.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { n as ChannelMessageAdapterShape } from "./types-CxkJAgkR.js";
import { n as ChannelOutboundAdapter } from "./outbound.types-D7agCOHK.js";
import { E as ChannelMeta, I as ChannelStreamingAdapter, K as ChannelMessageActionName$1, R as ChannelThreadingAdapter, T as ChannelMessagingAdapter, a as ChannelAgentPromptAdapter, c as ChannelCapabilities, o as ChannelAgentTool, s as ChannelAgentToolFactory, v as ChannelMentionAdapter, y as ChannelMessageActionAdapter } from "./types.core-BkmTlRzr.js";
import { c as ChannelSetupWizardAdapter, s as ChannelSetupWizard } from "./setup-wizard-types-BKBpG8mO.js";
import { A as ChannelGroupAdapter, B as ChannelSecretsAdapter, D as ChannelElevatedAdapter, H as ChannelSetupAdapter, M as ChannelLifecycleAdapter, O as ChannelGatewayAdapter, S as ChannelDoctorAdapter, U as ChannelStatusAdapter, V as ChannelSecurityAdapter, b as ChannelConversationBindingSupport, g as ChannelConfigAdapter, i as ChannelApprovalCapability, j as ChannelHeartbeatAdapter, m as ChannelCommandAdapter, n as ChannelAllowlistAdapter, u as ChannelAuthAdapter, x as ChannelDirectoryAdapter, y as ChannelConfiguredBindingProvider, z as ChannelResolverAdapter } from "./types.adapters-y0dBEomF.js";
import { Go as OperatorScope } from "./index-CaLNQFzV.js";
import { t as ChannelPairingAdapter } from "./pairing.types-DRe9rMoD.js";

//#region src/channels/plugins/types.plugin.d.ts
/** Full capability contract for a native channel plugin. */
type ChannelPluginSetupWizard = ChannelSetupWizard | ChannelSetupWizardAdapter;
type ChannelGatewayMethodDescriptor = {
  name: string;
  scope?: OperatorScope;
  description?: string;
};
type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  defaults?: {
    queue?: {
      debounceMs?: number;
    };
  };
  reload?: {
    configPrefixes: string[];
    noopPrefixes?: string[];
  };
  setupWizard?: ChannelPluginSetupWizard;
  config: ChannelConfigAdapter<ResolvedAccount>;
  configSchema?: ChannelConfigSchema;
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>;
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  outbound?: ChannelOutboundAdapter;
  status?: ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
  gatewayMethods?: string[];
  gatewayMethodDescriptors?: ChannelGatewayMethodDescriptor[];
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;
  auth?: ChannelAuthAdapter;
  approvalCapability?: ChannelApprovalCapability;
  elevated?: ChannelElevatedAdapter;
  commands?: ChannelCommandAdapter;
  lifecycle?: ChannelLifecycleAdapter;
  secrets?: ChannelSecretsAdapter;
  allowlist?: ChannelAllowlistAdapter;
  doctor?: ChannelDoctorAdapter;
  bindings?: ChannelConfiguredBindingProvider;
  conversationBindings?: ChannelConversationBindingSupport;
  streaming?: ChannelStreamingAdapter;
  threading?: ChannelThreadingAdapter;
  message?: ChannelMessageAdapterShape;
  messaging?: ChannelMessagingAdapter;
  agentPrompt?: ChannelAgentPromptAdapter;
  directory?: ChannelDirectoryAdapter;
  resolver?: ChannelResolverAdapter;
  actions?: ChannelMessageActionAdapter;
  heartbeat?: ChannelHeartbeatAdapter;
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
};
//#endregion
//#region src/channels/plugins/types.public.d.ts
type ChannelMessageActionName = ChannelMessageActionName$1;
//#endregion
export { ChannelPlugin as n, ChannelMessageActionName as t };