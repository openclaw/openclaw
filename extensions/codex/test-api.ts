/**
 * Test-only helpers for producing Codex app-server prompt snapshots and dynamic
 * tool specs without starting a live app-server.
 */
import {
  isSubagentSessionKey,
  type AnyAgentTool,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  type CodexAppServerRuntimeOptions,
  resolveCodexAppServerRuntimeOptions,
  type CodexPluginConfig,
} from "./src/app-server/config.js";
import { joinPresentSections } from "./src/app-server/developer-instruction-sections.js";
import { filterCodexDynamicTools } from "./src/app-server/dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./src/app-server/dynamic-tools.js";
import {
  flattenCodexDynamicToolFunctions,
  type CodexDynamicToolSpec,
  type JsonObject,
} from "./src/app-server/protocol.js";
import { buildDeveloperInstructions } from "./src/app-server/thread-prompt.js";
import {
  buildThreadResumeParams,
  buildThreadStartParams,
} from "./src/app-server/thread-requests.js";
import {
  buildCodexParentLocalInstructions,
  buildTurnStartParams,
} from "./src/app-server/turn-params.js";

export { CODEX_APP_SERVER_VERSION } from "./src/app-server/version.js";
export { createCodexDynamicToolBridge };

/** Keeps host integration tests on the plugin's test boundary without exposing runtime internals. */
export async function createCodexSessionInitializationFixtureForTest(params: {
  runtime: PluginRuntime;
  workspaceDir: string;
}) {
  // Snapshot scripts also load this barrel outside Vitest; load its test fixture only on demand.
  const { createCodexSessionInitializationFixture } =
    await import("./src/app-server/session-initialization.test-support.js");
  return await createCodexSessionInitializationFixture(params);
}

// Host finalizer fixtures opt into Vitest hooks without affecting snapshot consumers.
export const loadCodexSettledFinalizerTestFixture = () =>
  import("./src/app-server/settled-turn-finalizer.test-support.js");

export const loadCodexNativeSubagentMonitorTestFixture = () =>
  import("./src/app-server/native-subagent-monitor.test-support.js");

export const loadCodexAbortTranscriptTestFixture = () =>
  import("./src/app-server/transcript-abort.test-support.js");

type CodexHarnessPromptSnapshot = {
  developerInstructions: string;
  parentLocalInstructions: string | null;
  threadStartParams: Awaited<ReturnType<typeof buildThreadStartParams>>;
  threadResumeParams: Awaited<ReturnType<typeof buildThreadResumeParams>>;
  turnStartParams: Awaited<ReturnType<typeof buildTurnStartParams>>;
};

/** Resolves deterministic app-server options for prompt snapshot tests. */
export function resolveCodexPromptSnapshotAppServerOptions(
  pluginConfig?: unknown,
): CodexAppServerRuntimeOptions {
  return resolveCodexAppServerRuntimeOptions({
    pluginConfig,
    env: {},
    requirementsToml: null,
  });
}

/** Builds thread/resume/turn prompt payload snapshots for a Codex harness attempt. */
export async function buildCodexHarnessPromptSnapshot(params: {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  threadId: string;
  dynamicTools: CodexDynamicToolSpec[];
  appServer: CodexAppServerRuntimeOptions;
  config?: JsonObject;
  promptText?: string;
  developerInstructionAdditions?: string;
  personaInstructions?: string;
}): Promise<CodexHarnessPromptSnapshot> {
  const developerInstructions = joinPresentSections(
    buildDeveloperInstructions(params.attempt, {
      dynamicTools: params.dynamicTools,
    }),
    params.developerInstructionAdditions,
  );
  return {
    developerInstructions,
    parentLocalInstructions: buildCodexParentLocalInstructions(params.attempt, {
      personaInstructions: params.personaInstructions,
    }),
    threadStartParams: await buildThreadStartParams(params.attempt, {
      cwd: params.cwd,
      dynamicTools: params.dynamicTools,
      appServer: params.appServer,
      developerInstructions,
      config: params.config,
    }),
    threadResumeParams: await buildThreadResumeParams(params.attempt, {
      threadId: params.threadId,
      appServer: params.appServer,
      developerInstructions,
      config: params.config,
    }),
    turnStartParams: await buildTurnStartParams(params.attempt, {
      threadId: params.threadId,
      cwd: params.cwd,
      appServer: params.appServer,
      promptText: params.promptText,
      parentLocalEgress: true,
      messageToolAvailable: flattenCodexDynamicToolFunctions(params.dynamicTools).some(
        (tool) => tool.name === "message",
      ),
      requireExplicitMessageTarget:
        params.attempt.requireExplicitMessageTarget ??
        isSubagentSessionKey(params.attempt.sessionKey),
      sessionStatusAvailable: flattenCodexDynamicToolFunctions(params.dynamicTools).some(
        (tool) => tool.name === "session_status",
      ),
    }),
  };
}

/** Converts harness tools into Codex dynamic-tool specs for prompt snapshot tests. */
export function createCodexDynamicToolSpecsForPromptSnapshot(params: {
  tools: AnyAgentTool[];
  pluginConfig?: Pick<CodexPluginConfig, "codexDynamicToolsLoading" | "codexDynamicToolsExclude">;
  directToolNames?: Iterable<string>;
}): CodexDynamicToolSpec[] {
  const filteredTools = filterCodexDynamicTools(params.tools, params.pluginConfig ?? {});
  return createCodexDynamicToolBridge({
    tools: filteredTools,
    signal: new AbortController().signal,
    loading: params.pluginConfig?.codexDynamicToolsLoading ?? "searchable",
    directToolNames: params.directToolNames,
  }).specs;
}
export { createCanonicalForkFixture as createCanonicalForkFixtureForTest } from "./src/app-server/canonical-fork.test-support.js";

export {
  CODEX_NATIVE_TOOL_REQUIREMENTS,
  CODEX_TOOL_POLICY_SAFE_DENY_NAMES,
} from "./native-tool-policy.js";
export { buildCodexRuntimeThreadConfigForRun } from "./src/app-server/thread-requests.js";
