import type { SessionConfig } from "@github/copilot-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildCredentialSafetyPrompt,
  buildDelegationGuidanceSection,
  buildHarnessVisibleReplyGuidance,
  buildSkillWorkshopPromptSection,
  resolveAgentHarnessBeforePromptBuildResult,
  resolveMainSessionDelegationMode,
  runAgentHarnessLlmInputHook,
  SKILL_WORKSHOP_TOOL_NAME,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  normalizeUniqueStringEntries,
  readNonEmptyStringPreservingWhitespace as readNonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
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
import type { ResolvedCopilotProvider } from "./provider-bridge.js";
import { createCopilotIsolatedSessionRestrictions } from "./session-restrictions.js";
import { shouldForceCopilotMessageTool, type createCopilotToolBridge } from "./tool-bridge.js";
import { createCopilotUserInputBridge } from "./user-input-bridge.js";
import { loadCopilotWorkspaceInstructions } from "./workspace-bootstrap.js";

const COPILOT_HARNESS_IDENTITY =
  "You are a personal agent running inside OpenClaw. Your available OpenClaw capabilities are policy-filtered for this turn; use only the exact tools exposed to you.";

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
          if (isRawCopilotModelRun(input)) {
            return undefined;
          }
          const callableTools = new Set(
            normalizeUniqueStringEntries(promptPolicyResult.callableToolNames),
          );
          const hasSessionsSpawn = callableTools.has("sessions_spawn");
          const isMinimal = input.promptMode === "minimal";
          const extraSystemPrompt = readNonEmptyString(input.extraSystemPrompt)?.trim();
          const delegationGuidance =
            input.disableTools !== true && input.delegationCapability !== "report_only"
              ? buildDelegationGuidanceSection({
                  mode: resolveMainSessionDelegationMode({
                    config: input.config,
                    agentId: input.agentId,
                    sessionKey: input.sessionKey,
                  }),
                  isMinimal,
                  hiddenDelegationTool: hasSessionsSpawn ? "`sessions_spawn`" : "",
                  hasVisibleSessionSpawn: hasSessionsSpawn,
                  hasSessionsYield: callableTools.has("sessions_yield"),
                  hasSubagentsList: callableTools.has("subagents"),
                  hasSessionsSend: callableTools.has("sessions_send"),
                }).join("\n")
              : undefined;
          const sections = [
            COPILOT_HARNESS_IDENTITY,
            promptPolicyResult.toolSchemaDirectoryPrompt,
            callableTools.has(SKILL_WORKSHOP_TOOL_NAME)
              ? buildSkillWorkshopPromptSection().join("\n")
              : undefined,
            delegationGuidance,
            buildHarnessVisibleReplyGuidance({
              sourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
              messageToolAvailable: callableTools.has("message"),
              currentConversation: {
                agentSessionKey: input.sessionKey,
                currentChannelProvider: input.messageChannel ?? input.messageProvider,
                currentChannelId: input.currentChannelId,
                currentMessagingTarget: input.currentMessagingTarget,
              },
              requireExplicitMessageTarget: promptToolPolicy.requireExplicitMessageTarget,
            }),
            buildCredentialSafetyPrompt({
              controlToolsAvailable:
                input.disableTools !== true &&
                (callableTools.has("openclaw") || callableTools.has("gateway")),
            }),
            workspaceBootstrapInstructions?.trim(),
            extraSystemPrompt
              ? `${isMinimal ? "## Subagent Context" : "## Conversation Context"}\n${extraSystemPrompt}`
              : undefined,
          ];
          return sections.filter((section) => section?.trim()).join("\n\n") || undefined;
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
