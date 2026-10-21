import type { SessionConfig } from "@github/copilot-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  resolveAgentHarnessBeforePromptBuildResult,
  runAgentHarnessLlmInputHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readResolvedAttemptPath, type resolvePoolAcquire } from "./attempt-config.js";
import { isRawCopilotModelRun } from "./attempt-mode.js";
import {
  assertCopilotAttemptHostCapabilities,
  COPILOT_ASK_USER_AVAILABLE_TOOLS,
  COPILOT_SETTLED_FINALIZATION_SYSTEM_MESSAGE,
} from "./attempt-types.js";
import type { AttemptParamsLike, CopilotAgentEndHookParams, ModelRef } from "./attempt-types.js";
import { createHooksBridge } from "./hooks-bridge.js";
import { createPermissionBridge, rejectAllPolicy } from "./permission-bridge.js";
import { buildCopilotPromptGuidance } from "./prompt-guidance.js";
import type { ResolvedCopilotProvider } from "./provider-bridge.js";
import { createCopilotIsolatedSessionRestrictions } from "./session-restrictions.js";
import { shouldForceCopilotMessageTool, type createCopilotToolBridge } from "./tool-bridge.js";
import { createCopilotUserInputBridge } from "./user-input-bridge.js";
import { loadCopilotWorkspaceInstructions } from "./workspace-bootstrap.js";
export async function createCopilotSessionSetup(params: {
  attempt: AttemptParamsLike;
  byokProxy: Awaited<ReturnType<typeof import("./byok-proxy.js").createCopilotByokProxy>>;
  effectiveCwd: string | undefined;
  effectiveWorkspaceDir: string | undefined;
  hookContext: CopilotAgentEndHookParams["ctx"];
  modelRef: ModelRef;
  messages: AgentMessage[];
  poolAcquire: ReturnType<typeof resolvePoolAcquire>;
  ringZeroSystemAgentRun: boolean;
  promptToolPolicy?: Awaited<ReturnType<typeof createCopilotToolBridge>>["promptToolPolicy"];
  sessionProvider: ResolvedCopilotProvider;
  settledToolFinalization: boolean;
  signal: AbortSignal | undefined;
}) {
  const {
    attempt: input,
    byokProxy,
    effectiveCwd,
    effectiveWorkspaceDir,
    hookContext,
    modelRef,
    messages,
    poolAcquire,
    ringZeroSystemAgentRun,
    promptToolPolicy,
    sessionProvider,
    settledToolFinalization,
    signal,
  } = params;
  const ordinaryAttemptInput = settledToolFinalization
    ? undefined
    : (() => {
        assertCopilotAttemptHostCapabilities(input);
        return input;
      })();
  const workspaceBootstrapInstructions = ordinaryAttemptInput
    ? await loadCopilotWorkspaceInstructions({
        attempt: ordinaryAttemptInput,
        effectiveWorkspaceDir,
        warn: (message) => console.warn(message),
      })
    : undefined;
  const forceToolNames =
    ordinaryAttemptInput && shouldForceCopilotMessageTool(ordinaryAttemptInput)
      ? (["message"] as const)
      : undefined;
  let promptPolicyResult: ReturnType<NonNullable<typeof promptToolPolicy>["apply"]> | undefined;
  let promptBuild: Awaited<ReturnType<typeof resolveAgentHarnessBeforePromptBuildResult>>;
  if (settledToolFinalization) {
    promptBuild = { prompt: input.prompt, developerInstructions: "" };
  } else if (isRawCopilotModelRun(input)) {
    promptPolicyResult = promptToolPolicy?.apply();
    promptBuild = { prompt: input.prompt, developerInstructions: "" };
  } else {
    if (!ordinaryAttemptInput) {
      throw new Error("Copilot ordinary attempt authority is unavailable.");
    }
    if (!promptToolPolicy) {
      throw new Error("Copilot ordinary attempts require a prompt tool policy.");
    }
    promptBuild = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: input.prompt,
      developerInstructions: {
        build: ({ toolsAllow }) => {
          promptPolicyResult = promptToolPolicy.apply({ toolsAllow, forceToolNames });
          return buildCopilotPromptGuidance({
            attempt: input,
            callableToolNames: promptPolicyResult.callableToolNames,
            toolSchemaDirectoryPrompt: promptPolicyResult.toolSchemaDirectoryPrompt,
            requireExplicitMessageTarget: promptToolPolicy.requireExplicitMessageTarget,
            workspaceBootstrapInstructions,
          });
        },
      },
      messages,
      ctx: hookContext,
      bootstrapContextRunKind: input.bootstrapContextRunKind,
      toolAuthority: {
        fingerprint: input.toolAuthorityFingerprint,
        activeToolNames: () => promptPolicyResult?.callableToolNames ?? [],
        assertActive: ordinaryAttemptInput.hostCapabilities.assertActive,
      },
    });
  }
  const attemptInput =
    promptBuild.prompt === input.prompt ? input : { ...input, prompt: promptBuild.prompt };
  const promptTools = promptPolicyResult?.tools ?? [];
  const finalDeveloperInstructions = promptBuild.developerInstructions;
  // Restricted turns may expose native ask_user only when its policy-filtered
  // OpenClaw equivalent survived the canonical tool catalog.
  const includeAskUser =
    !ringZeroSystemAgentRun &&
    (attemptInput.pluginHarnessToolPolicyRestricted !== true ||
      promptTools.some((tool) => tool.name === "ask_user"));
  let promptImagesCount = 0;
  const emitLlmInput = (prompt: string, additionalContext?: string) => {
    if (settledToolFinalization) {
      return;
    }
    runAgentHarnessLlmInputHook({
      event: {
        runId: input.runId,
        sessionId: input.sessionId,
        provider: modelRef.provider,
        model: modelRef.id,
        ...(finalDeveloperInstructions ? { systemPrompt: finalDeveloperInstructions } : {}),
        prompt: additionalContext ? `${prompt}\n\n${additionalContext}` : prompt,
        historyMessages: [],
        imagesCount: promptImagesCount,
        tools: promptTools,
      },
      ctx: hookContext,
    });
  };
  const hasNativePromptHook =
    !settledToolFinalization && Boolean(attemptInput.hooksConfig?.onUserPromptSubmitted);
  const userInputBridge = settledToolFinalization
    ? undefined
    : (() => {
        assertCopilotAttemptHostCapabilities(attemptInput);
        return createCopilotUserInputBridge({ paramsForRun: attemptInput, signal });
      })();
  const buildSessionConfig = (provider: ResolvedCopilotProvider): SessionConfig => {
    const onUserInputRequest = userInputBridge?.onUserInputRequest;
    const permissionPolicy = settledToolFinalization
      ? rejectAllPolicy
      : (attemptInput.permissionPolicy ?? rejectAllPolicy);
    const hooks = settledToolFinalization
      ? undefined
      : createHooksBridge(
          attemptInput.hooksConfig,
          hasNativePromptHook
            ? {
                onUserPromptSubmitted: ({ additionalContext, prompt }) =>
                  emitLlmInput(prompt, additionalContext),
              }
            : undefined,
        );
    const availableTools = promptTools.map((tool) => tool.name);
    if (includeAskUser) {
      availableTools.push(...COPILOT_ASK_USER_AVAILABLE_TOOLS);
    }
    return {
      model: modelRef.id,
      onPermissionRequest: createPermissionBridge(permissionPolicy),
      ...(onUserInputRequest ? { onUserInputRequest } : {}),
      ...(provider.provider ? { provider: provider.provider } : {}),
      ...(hooks ? { hooks } : {}),
      ...(attemptInput.enableSessionTelemetry !== undefined
        ? { enableSessionTelemetry: attemptInput.enableSessionTelemetry }
        : {}),
      ...(settledToolFinalization
        ? {}
        : attemptInput.infiniteSessionConfig
          ? { infiniteSessions: attemptInput.infiniteSessionConfig }
          : {}),
      reasoningEffort: attemptInput.reasoningEffort,
      tools: promptTools,
      availableTools: [...new Set(availableTools)],
      ...(settledToolFinalization ? createCopilotIsolatedSessionRestrictions() : {}),
      workingDirectory:
        effectiveCwd ?? effectiveWorkspaceDir ?? readResolvedAttemptPath(attemptInput.workspaceDir),
      ...(!settledToolFinalization &&
      effectiveWorkspaceDir &&
      effectiveCwd &&
      effectiveCwd !== effectiveWorkspaceDir
        ? { instructionDirectories: [effectiveWorkspaceDir] }
        : {}),
      ...(poolAcquire.auth.authMode === "gitHubToken" && poolAcquire.auth.gitHubToken
        ? { gitHubToken: poolAcquire.auth.gitHubToken }
        : {}),
      ...(settledToolFinalization
        ? {
            systemMessage: {
              mode: "customize" as const,
              content: COPILOT_SETTLED_FINALIZATION_SYSTEM_MESSAGE,
            },
          }
        : finalDeveloperInstructions
          ? {
              systemMessage: {
                mode: "append" as const,
                content: finalDeveloperInstructions,
              },
            }
          : {}),
    };
  };
  const sessionConfig = buildSessionConfig(sessionProvider);
  const compactionSessionConfig = byokProxy
    ? buildSessionConfig(poolAcquire.provider)
    : sessionConfig;
  return {
    attemptInput,
    compactionSessionConfig,
    emitLlmInput,
    hasNativePromptHook,
    sessionConfig,
    setPromptImagesCount: (count: number) => {
      promptImagesCount = count;
    },
    userInputBridge,
  };
}
