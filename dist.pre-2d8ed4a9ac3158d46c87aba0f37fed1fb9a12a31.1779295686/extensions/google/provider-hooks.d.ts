import { r as AnyAgentTool } from "../../common-BLkNF-zo.js";
import { Fn as ProviderSanitizeReplayHistoryContext, Ln as ProviderToolSchemaDiagnostic, Yn as ProviderDefaultThinkingPolicyContext, bn as ProviderReplayPolicy, in as ProviderNormalizeToolSchemasContext, vn as ProviderReasoningOutputMode, xn as ProviderReplayPolicyContext, yn as ProviderReasoningOutputModeContext } from "../../types-D0OCNFd4.js";
import { d as createGoogleThinkingStreamWrapper } from "../../provider-stream-shared-CP0UGy_N.js";
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