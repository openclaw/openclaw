import { r as AnyAgentTool } from "../../common-BDN0bXby.js";
import { bi as EmbeddedRunAttemptParams } from "../../types-CRFXnxy2.js";
import { a as CodexDynamicToolSpec, c as CodexThreadStartParams, d as JsonObject, i as CodexPluginConfig, l as CodexTurnEnvironmentParams, n as CodexAppServerRuntimeOptions, o as CodexSandboxPolicy, s as CodexThreadResumeParams, u as CodexTurnStartParams } from "../../client-DWZAI6aL.js";

//#region extensions/codex/src/app-server/thread-lifecycle.d.ts
declare function buildThreadStartParams(params: EmbeddedRunAttemptParams, options: {
  cwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  config?: JsonObject;
  nativeCodeModeEnabled?: boolean;
  nativeCodeModeOnlyEnabled?: boolean;
  environmentSelection?: CodexTurnEnvironmentParams[];
}): CodexThreadStartParams;
declare function buildThreadResumeParams(params: EmbeddedRunAttemptParams, options: {
  threadId: string;
  authProfileId?: string;
  appServer: CodexAppServerRuntimeOptions;
  dynamicTools?: CodexDynamicToolSpec[];
  developerInstructions?: string;
  config?: JsonObject;
  nativeCodeModeEnabled?: boolean;
  nativeCodeModeOnlyEnabled?: boolean;
}): CodexThreadResumeParams;
declare function buildTurnStartParams(params: EmbeddedRunAttemptParams, options: {
  threadId: string;
  cwd: string;
  appServer: CodexAppServerRuntimeOptions;
  promptText?: string;
  sandboxPolicy?: CodexSandboxPolicy;
  environmentSelection?: CodexTurnEnvironmentParams[];
  heartbeatCollaborationInstructions?: string;
}): CodexTurnStartParams;
//#endregion
//#region extensions/codex/test-api.d.ts
type CodexHarnessPromptSnapshot = {
  developerInstructions: string;
  threadStartParams: ReturnType<typeof buildThreadStartParams>;
  threadResumeParams: ReturnType<typeof buildThreadResumeParams>;
  turnStartParams: ReturnType<typeof buildTurnStartParams>;
};
declare function resolveCodexPromptSnapshotAppServerOptions(pluginConfig?: unknown): CodexAppServerRuntimeOptions;
declare function buildCodexHarnessPromptSnapshot(params: {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  threadId: string;
  dynamicTools: CodexDynamicToolSpec[];
  appServer: CodexAppServerRuntimeOptions;
  config?: JsonObject;
  promptText?: string;
  developerInstructionAdditions?: string;
  heartbeatCollaborationInstructions?: string;
}): CodexHarnessPromptSnapshot;
declare function createCodexDynamicToolSpecsForPromptSnapshot(params: {
  tools: AnyAgentTool[];
  pluginConfig?: Pick<CodexPluginConfig, "codexDynamicToolsLoading" | "codexDynamicToolsExclude">;
  directToolNames?: Iterable<string>;
}): CodexDynamicToolSpec[];
//#endregion
export { buildCodexHarnessPromptSnapshot, createCodexDynamicToolSpecsForPromptSnapshot, resolveCodexPromptSnapshotAppServerOptions };