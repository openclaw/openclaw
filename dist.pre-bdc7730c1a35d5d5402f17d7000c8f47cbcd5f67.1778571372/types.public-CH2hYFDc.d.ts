import { n as ChannelConfigSchema } from "./types.config-UH9n_VwT.js";
import { t as ChannelId } from "./channel-id.types-DU-7hQII.js";
import { n as ChannelMessageAdapterShape } from "./types-BJJUY3hp.js";
import { n as ChannelOutboundAdapter } from "./outbound.types-DgglYInj.js";
import { E as ChannelMeta, I as ChannelStreamingAdapter, K as ChannelMessageActionName$1, R as ChannelThreadingAdapter, T as ChannelMessagingAdapter, a as ChannelAgentPromptAdapter, c as ChannelCapabilities, o as ChannelAgentTool, s as ChannelAgentToolFactory, v as ChannelMentionAdapter, y as ChannelMessageActionAdapter } from "./types.core-D5GEzFhB.js";
import { c as ChannelSetupWizardAdapter, s as ChannelSetupWizard } from "./setup-wizard-types-C7T1IHR5.js";
import { A as ChannelGroupAdapter, B as ChannelSecretsAdapter, D as ChannelElevatedAdapter, H as ChannelSetupAdapter, M as ChannelLifecycleAdapter, O as ChannelGatewayAdapter, S as ChannelDoctorAdapter, U as ChannelStatusAdapter, V as ChannelSecurityAdapter, b as ChannelConversationBindingSupport, g as ChannelConfigAdapter, i as ChannelApprovalCapability, j as ChannelHeartbeatAdapter, m as ChannelCommandAdapter, n as ChannelAllowlistAdapter, u as ChannelAuthAdapter, x as ChannelDirectoryAdapter, y as ChannelConfiguredBindingProvider, z as ChannelResolverAdapter } from "./types.adapters-BGkc2cju.js";
import { t as ChannelPairingAdapter } from "./pairing.types-DUJitQXT.js";

//#region src/channels/plugins/types.plugin.d.ts
/** Full capability contract for a native channel plugin. */
type ChannelPluginSetupWizard = ChannelSetupWizard | ChannelSetupWizardAdapter;
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