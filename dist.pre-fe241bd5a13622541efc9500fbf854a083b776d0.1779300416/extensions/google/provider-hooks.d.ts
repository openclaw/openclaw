import { r as AnyAgentTool } from "../../common-D4gcZLB7.js";
import { Fn as ProviderSanitizeReplayHistoryContext, Ln as ProviderToolSchemaDiagnostic, Yn as ProviderDefaultThinkingPolicyContext, bn as ProviderReplayPolicy, in as ProviderNormalizeToolSchemasContext, vn as ProviderReasoningOutputMode, xn as ProviderReplayPolicyContext, yn as ProviderReasoningOutputModeContext } from "../../types-Dw7_sm4q.js";
import { d as createGoogleThinkingStreamWrapper } from "../../provider-stream-shared-BcW5kOQW.js";
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
  sanitizeReplayHistory?: ((ctx: ProviderSanitizeReplayHistoryContext) => Promise<import("@earendil-works/pi-agent-core").AgentMessage[] | null | undefined> | import("@earendil-works/pi-agent-core").AgentMessage[] | null | undefined) | undefined;
  resolveReasoningOutputMode?: ((ctx: ProviderReasoningOutputModeContext) => ProviderReasoningOutputMode | null | undefined) | undefined;
};
//#endregion
export { GOOGLE_GEMINI_PROVIDER_HOOKS };