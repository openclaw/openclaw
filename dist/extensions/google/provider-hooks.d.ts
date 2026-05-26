import { r as AnyAgentTool } from "../../common-BDN0bXby.js";
import { Fn as ProviderSanitizeReplayHistoryContext, Ln as ProviderToolSchemaDiagnostic, Yn as ProviderDefaultThinkingPolicyContext, Zn as ProviderThinkingProfile, bn as ProviderReplayPolicy, in as ProviderNormalizeToolSchemasContext, vn as ProviderReasoningOutputMode, xn as ProviderReplayPolicyContext, yn as ProviderReasoningOutputModeContext } from "../../types-Vx7Jq4_-2.js";
import { d as createGoogleThinkingStreamWrapper } from "../../provider-stream-shared-BeJa0RWE.js";
//#region extensions/google/provider-hooks.d.ts
declare const GOOGLE_GEMINI_PROVIDER_HOOKS: {
  resolveThinkingProfile: (context: ProviderDefaultThinkingPolicyContext) => ProviderThinkingProfile | undefined;
  wrapStreamFn: typeof createGoogleThinkingStreamWrapper;
  normalizeToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => AnyAgentTool[];
  inspectToolSchemas: (ctx: ProviderNormalizeToolSchemasContext) => ProviderToolSchemaDiagnostic[];
  buildReplayPolicy?: ((ctx: ProviderReplayPolicyContext) => ProviderReplayPolicy | null | undefined) | undefined;
  sanitizeReplayHistory?: ((ctx: ProviderSanitizeReplayHistoryContext) => Promise<import("@earendil-works/pi-agent-core").AgentMessage[] | null | undefined> | import("@earendil-works/pi-agent-core").AgentMessage[] | null | undefined) | undefined;
  resolveReasoningOutputMode?: ((ctx: ProviderReasoningOutputModeContext) => ProviderReasoningOutputMode | null | undefined) | undefined;
};
//#endregion
export { GOOGLE_GEMINI_PROVIDER_HOOKS };