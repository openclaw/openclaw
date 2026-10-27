import {
  buildCredentialSafetyPrompt,
  splitExtraSystemPrompt,
  buildDelegationGuidanceSection,
  buildUiPresentationPrompt,
  buildSkillWorkshopPromptSection,
  resolveMainSessionDelegationMode,
  SKILL_WORKSHOP_TOOL_NAME,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { listRegisteredPluginAgentPromptGuidance } from "openclaw/plugin-sdk/plugin-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isMessageOnlyCodexSourceReply,
  isSystemAgentOnlyCodexDynamicToolAllowlist,
  shouldDisableCodexToolSearchForModel,
} from "./dynamic-tool-profile.js";
import {
  CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE,
  type CodexDynamicToolSpec,
} from "./protocol.js";
import { isCodexResponsesOAuthRun } from "./responses-oauth.js";

export type CodexThreadPromptContext = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "agentId"
  | "sessionKey"
  | "modelId"
  | "disableTools"
  | "disableMessageTool"
  | "delegationCapability"
  | "pluginHarnessToolPolicyRestricted"
  | "requireWorkspaceOnly"
  | "toolsAllow"
  | "sourceReplyDeliveryMode"
  | "promptMode"
  | "extraSystemPrompt"
  | "extraSystemPromptTurnContext"
  | "gitCoauthorPrompt"
  | "runtimePlan"
>;

/** Complete current snapshot for the existing parent-local inference relay. */
export function buildCodexConversationTurnInstructions(
  params: Pick<CodexThreadPromptContext, "extraSystemPrompt" | "extraSystemPromptTurnContext">,
  availableDynamicTools: readonly CodexDynamicToolSpec[],
): string {
  const availableNames = availableDynamicTools.flatMap((spec) =>
    spec.type === "namespace" ? spec.tools.map((tool) => `${spec.name}.${tool.name}`) : [spec.name],
  );
  return [
    "Current OpenClaw conversation instructions (replace earlier conversation context, not persistent policy):",
    splitExtraSystemPrompt(params).turn ?? "No additional conversation instructions for this turn.",
    `Current OpenClaw tool bindings for this turn (accepted declarations alone do not grant execution): ${availableNames.length ? availableNames.toSorted().join(", ") : "none"}.`,
  ].join("\n\n");
}

export function buildDeveloperInstructions(
  params: CodexThreadPromptContext,
  options: {
    dynamicTools?: readonly CodexDynamicToolSpec[];
    nativeCodeModeEnabled?: boolean;
    nativeCodeModeOnlyEnabled?: boolean;
    /** The lifecycle must select a compaction-safe carrier before omitting this context. */
    omitConversationTurnContext?: boolean;
  } = {},
): string {
  const deferredToolNames = new Set<string>();
  const toolNames = new Map<string, string>();
  let messageTool: Parameters<typeof buildUiPresentationPrompt>[0]["messageTool"];
  let sessionsSpawnTool: { name: string; parameters: unknown } | undefined;
  let hasSessionsYield = false;
  let hasSeenDirectNamespace = false;
  for (const spec of options.dynamicTools ?? []) {
    const isDirectNamespace =
      spec.type === "namespace" &&
      !hasSeenDirectNamespace &&
      spec.name.trim() === CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE;
    if (isDirectNamespace) {
      hasSeenDirectNamespace = true;
    }
    for (const tool of spec.type === "namespace" ? spec.tools : [spec]) {
      const name = tool.name.trim();
      const qualifiedName = spec.type === "namespace" ? `${spec.name}.${name}` : name;
      if (tool.deferLoading === true && name) {
        deferredToolNames.add(qualifiedName);
      }
      if (!toolNames.has(name)) {
        toolNames.set(name, qualifiedName);
      }
      if (name === "message") {
        messageTool ??= { name: qualifiedName, parameters: tool.inputSchema };
      }
      if (name === "sessions_spawn") {
        sessionsSpawnTool ??= { name: qualifiedName, parameters: tool.inputSchema };
      }
      hasSessionsYield ||= isDirectNamespace && name === "sessions_yield";
    }
  }
  const hasSessionsSpawn = toolNames.has("sessions_spawn");
  const spawnProperties = asOptionalRecord(
    asOptionalRecord(sessionsSpawnTool?.parameters)?.properties,
  );
  const spawnRuntime = asOptionalRecord(spawnProperties?.runtime);
  // Placed workers omit the runtime selector; ordinary sessions advertise its
  // allowed values. Do not instruct the model to pass an unsupported selector.
  const managedDelegationTool = sessionsSpawnTool
    ? !spawnProperties || !Object.hasOwn(spawnProperties, "runtime")
      ? `\`${sessionsSpawnTool.name}\``
      : Array.isArray(spawnRuntime?.enum) && spawnRuntime.enum.includes("subagent")
        ? `\`${sessionsSpawnTool.name}\` with \`runtime="subagent"\``
        : undefined
    : undefined;
  const nativeCommandGuidance = listRegisteredPluginAgentPromptGuidance({
    surface: "codex_app_server",
    includeLegacyGlobalGuidance: false,
  }).join("\n");
  const delegationGuidanceAvailable =
    params.disableTools !== true &&
    params.toolsAllow?.length !== 0 &&
    params.delegationCapability !== "report_only" &&
    !isMessageOnlyCodexSourceReply(params);
  const nativeDelegationAvailable =
    delegationGuidanceAvailable &&
    options.nativeCodeModeEnabled !== false &&
    params.delegationCapability !== "host_only" &&
    params.pluginHarnessToolPolicyRestricted !== true &&
    params.requireWorkspaceOnly !== true &&
    !isCodexResponsesOAuthRun(params) &&
    !isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow) &&
    !shouldDisableCodexToolSearchForModel(params.modelId);
  const deferredToolDiscoveryGuidance =
    (options.nativeCodeModeEnabled === true ? deferredToolNames.size > 0 : toolNames.size > 0) ||
    nativeDelegationAvailable
      ? options.nativeCodeModeEnabled === true
        ? options.nativeCodeModeOnlyEnabled === true
          ? "Deferred tools may be absent from the direct tool list. Use Codex's native JavaScript `exec` to filter `ALL_TOOLS` by name and description, then invoke the matching entry through `tools`. `ALL_TOOLS` and `tools` are JavaScript globals, not shell environment variables. OpenClaw shell command tools are separate from this JavaScript runner. Call directly listed tools by their exact qualified names."
          : "Call directly listed tools by their exact qualified names. Use `tool_search` for deferred tools when it is directly callable. Otherwise use Codex's native JavaScript `exec` to filter `ALL_TOOLS` and invoke the matching entry through `tools`. `ALL_TOOLS` and `tools` are JavaScript globals, not shell environment variables. OpenClaw shell command tools are separate from this JavaScript runner. Do not repeat a completed call to retrieve a result you already have."
        : "Call the supplied OpenClaw tools by their exact qualified names. Shell command tools execute operating-system commands, not JavaScript tool discovery."
      : undefined;
  const sections = [
    "You are a personal agent running inside OpenClaw. OpenClaw has dynamic tools for OpenClaw-owned messaging, cron, sessions, media, gateway, and nodes.",
    deferredToolNames.size > 0
      ? `Deferred searchable OpenClaw dynamic tools available: ${[...deferredToolNames]
          .toSorted((left, right) => left.localeCompare(right))
          .join(", ")}.`
      : undefined,
    deferredToolDiscoveryGuidance,
    toolNames.has(SKILL_WORKSHOP_TOOL_NAME)
      ? buildSkillWorkshopPromptSection().join("\n")
      : undefined,
    // Deferred native tools still need discovery. Inherited dynamic schemas do
    // not give native children OpenClaw executors, so choose that owner up front.
    nativeDelegationAvailable
      ? `Use Codex native \`spawn_agent\` for work that only needs Codex-native tools. \`spawn_agent\` and the other native collaboration tools may be deferred. Native children cannot execute OpenClaw-owned dynamic tools, even when they inherit their schemas.${managedDelegationTool ? ` For new delegated work that needs OpenClaw tools, use ${managedDelegationTool} from the start.` : " Keep work needing OpenClaw tools in this session when no managed worker route is available."} For follow-up work on an existing native child, use the native collaboration tool that starts or queues a new turn. Do not respawn existing work to switch tool routes.`
      : undefined,
    hasSessionsYield && nativeDelegationAvailable
      ? "When a native child's result belongs in a later turn, end the current turn with `openclaw_direct.sessions_yield`; the completion arrives as the next model-visible input. Use native `wait_agent` only for an intentional same-turn wait when the immediate next step is blocked on the child. Never loop-poll for native child completion."
      : undefined,
    delegationGuidanceAvailable
      ? buildDelegationGuidanceSection({
          mode: resolveMainSessionDelegationMode({
            config: params.config,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
          }),
          // Subagent/none prompt modes stay lean and must not be told to delegate further.
          isMinimal: params.promptMode === "minimal" || params.promptMode === "none",
          hiddenDelegationTool: nativeDelegationAvailable
            ? `native \`spawn_agent\` for Codex-native work${managedDelegationTool ? `, or ${managedDelegationTool} for new work needing OpenClaw tools` : ""}`
            : sessionsSpawnTool
              ? (managedDelegationTool ?? `\`${sessionsSpawnTool.name}\``)
              : "",
          hasVisibleSessionSpawn: hasSessionsSpawn,
          hasSessionsYield,
          hasSubagentsList: toolNames.has("subagents"),
          hasSessionsSend: toolNames.has("sessions_send"),
          sessionsCreateToolName: toolNames.get("sessions_create"),
          suggestTaskToolName: toolNames.get("suggest_task"),
        }).join("\n")
      : undefined,
    params.disableTools !== true && params.promptMode !== "minimal" && params.promptMode !== "none"
      ? buildUiPresentationPrompt({
          screenToolName: toolNames.get("screen"),
          showWidgetToolName: toolNames.get("show_widget"),
          dashboardToolName: toolNames.get("dashboard"),
          portalToolName: toolNames.get("portal"),
          messageTool,
        })
      : undefined,
    buildCredentialSafetyPrompt({
      controlToolsAvailable:
        params.disableTools !== true && (toolNames.has("openclaw") || toolNames.has("gateway")),
    }),
    nativeCommandGuidance,
    params.gitCoauthorPrompt,
    options.omitConversationTurnContext
      ? splitExtraSystemPrompt(params).persistent
      : params.extraSystemPrompt,
  ];
  return sections.filter((section) => section?.trim()).join("\n\n");
}
