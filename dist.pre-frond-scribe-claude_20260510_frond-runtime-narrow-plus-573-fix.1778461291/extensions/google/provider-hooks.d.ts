import { r as AnyAgentTool } from "../../common-B0aZxYiS.js";
import { Gt as ProviderNormalizeToolSchemasContext, In as ProviderDefaultThinkingPolicyContext, Sn as ProviderSanitizeReplayHistoryContext, an as ProviderReasoningOutputMode, cn as ProviderReplayPolicyContext, on as ProviderReasoningOutputModeContext, sn as ProviderReplayPolicy, wn as ProviderToolSchemaDiagnostic } from "../../types-BYigPDoy.js";
import { d as createGoogleThinkingStreamWrapper } from "../../provider-stream-shared-ZbGvzeV9.js";
import * as _$_mariozechner_pi_agent_core0 from "@mariozechner/pi-agent-core";

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
  sanitizeReplayHistory?: ((ctx: ProviderSanitizeReplayHistoryContext) => Promise<_$_mariozechner_pi_agent_core0.AgentMessage[] | null | undefined> | _$_mariozechner_pi_agent_core0.AgentMessage[] | null | undefined) | undefined;
  resolveReasoningOutputMode?: ((ctx: ProviderReasoningOutputModeContext) => ProviderReasoningOutputMode | null | undefined) | undefined;
};
//#endregion
export { GOOGLE_GEMINI_PROVIDER_HOOKS };