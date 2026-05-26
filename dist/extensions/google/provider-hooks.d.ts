import { r as AnyAgentTool } from "../../common-5s-NiX7e.js";
import { $t as ProviderNormalizeToolSchemasContext, An as ProviderSanitizeReplayHistoryContext, Mn as ProviderToolSchemaDiagnostic, Wn as ProviderDefaultThinkingPolicyContext, gn as ProviderReplayPolicyContext, hn as ProviderReplayPolicy, mn as ProviderReasoningOutputModeContext, pn as ProviderReasoningOutputMode } from "../../types-lCXG2pW_.js";
import { d as createGoogleThinkingStreamWrapper } from "../../provider-stream-shared-DIx4tURD.js";
import * as _$_earendil_works_pi_agent_core0 from "@earendil-works/pi-agent-core";

//#region extensions/google/provider-hooks.d.ts
declare const GOOGLE_GEMINI_PROVIDER_HOOKS: {
  resolveThinkingProfile: ({
    modelId
  }: ProviderDefaultThinkingPolicyContext) => {
    levels: ({
      id: "off";
    } | {
      id: "minimal";
    } | {
      id: "low";
    } | {
      id: "medium";
    } | {
      id: "adaptive";
    } | {
      id: "high";
    })[];
  };
  wrapStreamFn: typeof createGoogleThinkingStreamWrapper;
  normalizeToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => AnyAgentTool[];
  inspectToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => ProviderToolSchemaDiagnostic[];
  buildReplayPolicy?: ((ctx: ProviderReplayPolicyContext) => ProviderReplayPolicy | null | undefined) | undefined;
  sanitizeReplayHistory?: ((ctx: ProviderSanitizeReplayHistoryContext) => Promise<_$_earendil_works_pi_agent_core0.AgentMessage[] | null | undefined> | _$_earendil_works_pi_agent_core0.AgentMessage[] | null | undefined) | undefined;
  resolveReasoningOutputMode?: ((ctx: ProviderReasoningOutputModeContext) => ProviderReasoningOutputMode | null | undefined) | undefined;
};
//#endregion
export { GOOGLE_GEMINI_PROVIDER_HOOKS };