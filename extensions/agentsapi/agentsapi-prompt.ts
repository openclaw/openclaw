import type { AgentToolParam } from "openai/resources/beta/agents/agents";
import {
  resolveAgentWorkspaceMemoryRouting,
  shouldIncludeAgentHarnessRuntimeContext,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
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
import type { AgentsApiEnvironment } from "./config.js";

const OPENAI_HOSTED_ENVIRONMENT_INSTRUCTIONS = [
  "You are the OpenClaw assistant. Use your hosted Linux workspace for commands and files.",
  "OpenClaw functions run in the Gateway and use its workspace; your hosted VM owns shell commands and VM files.",
  "Input attachments are mapped to hosted VM paths in each user message. Write deliverable files under /workspace/outputs; OpenClaw transfers them and attaches them to your final reply after your turn completes.",
  "Gateway messaging functions cannot open hosted VM paths. Finish your assistant turn to deliver hosted output attachments.",
].join("\n\n");

const SELF_HOSTED_ENVIRONMENT_INSTRUCTIONS = [
  "You are the OpenClaw assistant. Use your connected self-hosted executor for commands and workspace files.",
  "OpenClaw functions run in the Gateway and use its workspace. Native shell commands and file operations run in your connected executor's workspace.",
  "Input attachments prepared by the workspace provider are identified by execution-only paths in the current user message. Use those paths with executor tools; original Gateway media paths are not executor paths. Other attachment references are not proof of a transferred file.",
  "OpenClaw does not automatically transfer output files from this executor through the Agents API.",
].join("\n\n");

/** The native session owns this snapshot until OpenClaw resets its binding. */
export async function buildAgentsApiInstructions(
  params: AgentHarnessAttemptParamsV2,
  tools: readonly AgentToolParam.AgentToolConfigParamFunction[],
  environment: AgentsApiEnvironment,
): Promise<string> {
  const toolNames = new Set(tools.map((tool) => tool.name));
  const workspaceDir = params.bootstrapWorkspaceDir ?? params.workspaceDir;
  const { memoryToolNames, memoryToolRouted } = resolveAgentWorkspaceMemoryRouting({
    config: params.config,
    agentId: params.agentId,
    workspaceDir,
    toolNames,
  });
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
    memoryTools: shouldIncludeAgentHarnessRuntimeContext(params)
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
    environment.type === "openai_hosted"
      ? OPENAI_HOSTED_ENVIRONMENT_INSTRUCTIONS
      : `${SELF_HOSTED_ENVIRONMENT_INSTRUCTIONS}\n\nYour executor workspace directory is ${JSON.stringify(environment.workspace_directory)}.`,
    environment.type === "openai_hosted"
      ? "OpenClaw workspace files below are Gateway-owned instruction and reference snapshots. Their paths identify their source, not files available in your hosted VM. Do not try to reread or edit those paths with hosted shell or file tools."
      : "OpenClaw workspace files below are Gateway-owned instruction and reference snapshots. Their paths identify their source, not files available in your connected executor. Do not try to reread or edit those paths with executor shell or file tools.",
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

export function buildAgentsApiTurnInput(
  params: AgentHarnessAttemptParamsV2,
  tools: readonly AgentToolParam.AgentToolConfigParamFunction[],
  prompt: string,
  mappingText: string,
  environmentType: AgentsApiEnvironment["type"],
): string {
  // Deduplicate only after prompt hooks; a replacement prompt still needs
  // the workspace owner's freshly prepared executor paths.
  const attachmentNote =
    environmentType === "self_hosted" && prompt.endsWith(`\n\n${mappingText}`) ? "" : mappingText;
  return [buildAgentsApiTurnContext(params, tools), prompt, attachmentNote]
    .filter(Boolean)
    .join("\n\n");
}

/** Current facts use the existing input carrier, not immutable session instructions. */
function buildAgentsApiTurnContext(
  params: AgentHarnessAttemptParamsV2,
  tools: readonly AgentToolParam.AgentToolConfigParamFunction[],
): string | undefined {
  if (!shouldIncludeAgentHarnessRuntimeContext(params)) {
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

function joinSections(sections: readonly (string | undefined)[]): string {
  return sections.filter((section) => section?.trim()).join("\n\n");
}
