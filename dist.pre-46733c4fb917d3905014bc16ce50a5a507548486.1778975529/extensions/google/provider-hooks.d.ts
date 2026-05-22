import { r as AnyAgentTool } from "../../common-DUJz-9i6.js";
import { Gn as ProviderDefaultThinkingPolicyContext, Nn as ProviderToolSchemaDiagnostic, _n as ProviderReplayPolicyContext, en as ProviderNormalizeToolSchemasContext, gn as ProviderReplayPolicy, hn as ProviderReasoningOutputModeContext, jn as ProviderSanitizeReplayHistoryContext, mn as ProviderReasoningOutputMode } from "../../types-Dggwf5Fv.js";
import { d as createGoogleThinkingStreamWrapper } from "../../provider-stream-shared-DBWR-1ou.js";
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