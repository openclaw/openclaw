import { r as AnyAgentTool } from "../../common-PkdSYxsi.js";
import { hi as EmbeddedRunAttemptParams } from "../../types-ItMBrbf4.js";
import { a as CodexDynamicToolSpec, c as CodexTurnStartParams, i as CodexPluginConfig, l as JsonObject, n as CodexAppServerRuntimeOptions, o as CodexThreadResumeParams, s as CodexThreadStartParams } from "../../client-d4WfAU2k.js";

//#region extensions/codex/src/app-server/thread-lifecycle.d.ts
declare function buildThreadStartParams(params: EmbeddedRunAttemptParams, options: {
  cwd: string;
  dynamicTools: CodexDynamicToolSpec[];
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  config?: JsonObject;
}): CodexThreadStartParams;
declare function buildThreadResumeParams(params: EmbeddedRunAttemptParams, options: {
  threadId: string;
  authProfileId?: string;
  appServer: CodexAppServerRuntimeOptions;
  developerInstructions?: string;
  config?: JsonObject;
}): CodexThreadResumeParams;
declare function buildTurnStartParams(params: EmbeddedRunAttemptParams, options: {
  threadId: string;
  cwd: string;
  appServer: CodexAppServerRuntimeOptions;
  promptText?: string;
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
}): CodexHarnessPromptSnapshot;
declare function createCodexDynamicToolSpecsForPromptSnapshot(params: {
  tools: AnyAgentTool[];
  pluginConfig?: Pick<CodexPluginConfig, "codexDynamicToolsLoading" | "codexDynamicToolsExclude">;
  directToolNames?: Iterable<string>;
}): CodexDynamicToolSpec[];
//#endregion
export { buildCodexHarnessPromptSnapshot, createCodexDynamicToolSpecsForPromptSnapshot, resolveCodexPromptSnapshotAppServerOptions };