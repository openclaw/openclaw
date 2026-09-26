import path from "node:path";
import {
  buildCredentialSafetyPrompt,
  buildDelegationGuidanceSection,
  buildHarnessVisibleReplyGuidance,
  buildSkillWorkshopPromptSection,
  buildTemporalContextText,
  buildUiPresentationPrompt,
  buildWatchedSessionsHarnessContext,
  embeddedAgentLog,
  prepareAgentWorkspaceContext,
  resolveMainSessionDelegationMode,
  SKILL_WORKSHOP_TOOL_NAME,
  type AgentHarnessAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { AgentsApiFunctionDeclaration } from "./agentsapi-client.js";

/** The native session owns this snapshot until OpenClaw resets its binding. */
export async function buildAgentsApiInstructions(
  params: AgentHarnessAttemptParamsV2,
  tools: readonly AgentsApiFunctionDeclaration[],
): Promise<string> {
  const toolNames = new Set(tools.map((tool) => tool.name));
  const workspaceDir = params.bootstrapWorkspaceDir ?? params.workspaceDir;
  const memoryToolNames = ["memory_search", "memory_get"].filter((name) => toolNames.has(name));
  const memoryToolRouted =
    memoryToolNames.length > 0 &&
    params.config !== undefined &&
    params.agentId !== undefined &&
    path.resolve(resolveAgentWorkspaceDir(params.config, params.agentId)) ===
      path.resolve(workspaceDir);
  // Use the same loader, privacy rules, personal-user selection and budgets as Codex.
  // Preparation failure must remain retryable before a native session is bound.
  const workspace = await prepareAgentWorkspaceContext({
    scope: "full",
    workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    bootstrapUserProfileId: params.bootstrapUserProfileId,
    agentId: params.agentId,
    chatType: params.chatType,
    contextMode: params.bootstrapContextMode,
    runKind: params.bootstrapContextRunKind,
    warn: (message) => embeddedAgentLog.warn(message),
    memoryToolRouted,
    memoryTools: shouldIncludeRuntimeContext(params)
      ? { toolNames: [...toolNames], citationsMode: params.config?.memory?.citations }
      : undefined,
  });
  const messageTool = tools.find((tool) => tool.name === "message");
  const fullPrompt = params.promptMode !== "minimal" && params.promptMode !== "none";
  const delegationAvailable =
    params.disableTools !== true &&
    params.delegationCapability !== "report_only" &&
    params.sourceReplyDeliveryMode !== "message_tool_only";
  return joinSections([
    "You are the OpenClaw assistant. Use your hosted Linux workspace for commands and files.",
    "OpenClaw functions run in the Gateway and use its workspace; your hosted VM owns shell commands and VM files.",
    "Uploaded attachments are mapped to hosted VM paths in each user message. Files you finish writing under /workspace/outputs are transferred and attached to your final reply after your turn completes.",
    "Gateway messaging functions cannot open VM paths. Complete your assistant turn to deliver VM output attachments. Image generation is unavailable.",
    "OpenClaw workspace files below are Gateway-owned instruction and reference snapshots. Their paths identify their source, not files available in your hosted VM. Do not try to reread or edit those paths with hosted shell or file tools.",
    workspace.instructionSnapshot.instructions,
    workspace.personaInstructions,
    workspace.promptContextFiles.length
      ? [
          "## OpenClaw Workspace Context",
          "Supporting project reference from the Gateway workspace:",
          ...workspace.promptContextFiles.map((file) => `### ${file.path}\n\n${file.content}`),
        ].join("\n\n")
      : undefined,
    workspace.memoryRecallInstructions,
    workspace.memoryReferenceFiles.length
      ? [
          "## OpenClaw Workspace Memory",
          `MEMORY.md is a memory file, not an instruction file. Its contents are not embedded here. Use ${memoryToolNames.join(" or ")} when durable memory is relevant.`,
          ...workspace.memoryReferenceFiles.map((file) => `- ${file.path}`),
        ].join("\n\n")
      : undefined,
    toolNames.has(SKILL_WORKSHOP_TOOL_NAME)
      ? buildSkillWorkshopPromptSection().join("\n")
      : undefined,
    delegationAvailable
      ? buildDelegationGuidanceSection({
          mode: resolveMainSessionDelegationMode(params),
          isMinimal: !fullPrompt,
          hiddenDelegationTool: toolNames.has("sessions_spawn") ? "`sessions_spawn`" : "",
          hasVisibleSessionSpawn: toolNames.has("sessions_spawn"),
          hasSessionsYield: toolNames.has("sessions_yield"),
          hasSubagentsList: toolNames.has("subagents"),
          hasSessionsSend: toolNames.has("sessions_send"),
        }).join("\n")
      : undefined,
    params.disableTools !== true && fullPrompt
      ? buildUiPresentationPrompt({
          screenToolName: toolNames.has("screen") ? "screen" : undefined,
          showWidgetToolName: toolNames.has("show_widget") ? "show_widget" : undefined,
          dashboardToolName: toolNames.has("dashboard") ? "dashboard" : undefined,
          portalToolName: toolNames.has("portal") ? "portal" : undefined,
          messageTool,
        })
      : undefined,
    // Without Gateway control tools, omit the shared builder's CLI setup hint:
    // the hosted VM cannot configure the Gateway with a local OpenClaw CLI.
    buildCredentialSafetyPrompt(
      toolNames.has("openclaw") || toolNames.has("gateway")
        ? { controlToolsAvailable: true }
        : undefined,
    ),
    params.gitCoauthorPrompt,
    params.extraSystemPrompt,
  ]);
}

/** Current facts use the existing input carrier, not immutable session instructions. */
export function buildAgentsApiTurnContext(
  params: AgentHarnessAttemptParamsV2,
  tools: readonly AgentsApiFunctionDeclaration[],
): string | undefined {
  if (!shouldIncludeRuntimeContext(params)) {
    return undefined;
  }
  const toolNames = new Set(tools.map((tool) => tool.name));
  return joinSections([
    "OpenClaw runtime context for this turn (replaces earlier runtime facts):",
    buildTemporalContextText({
      configuredTimezone: params.config?.agents?.defaults?.userTimezone,
      sessionStatusAvailable: toolNames.has("session_status"),
    }),
    params.hostCapabilities.activeComputerContext?.() ??
      "Current active computer: active_node=unknown (host presence unavailable)",
    buildHarnessVisibleReplyGuidance({
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      messageToolAvailable: toolNames.has("message"),
      requireExplicitMessageTarget: params.requireExplicitMessageTarget,
    }),
    params.permissionChange?.notice,
    buildWatchedSessionsHarnessContext({
      config: params.config,
      sessionKey: params.sessionKey,
      toolNames,
    }),
    "Current user request:",
  ]);
}

function shouldIncludeRuntimeContext(params: AgentHarnessAttemptParamsV2): boolean {
  return !(
    params.bootstrapContextMode === "lightweight" && params.bootstrapContextRunKind === "cron"
  );
}

function joinSections(sections: readonly (string | undefined)[]): string {
  return sections.filter((section) => section?.trim()).join("\n\n");
}
