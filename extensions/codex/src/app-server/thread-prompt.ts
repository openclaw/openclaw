import {
  buildAgentHarnessBasePrompt,
  buildAgentRuntimePlan,
  buildCredentialSafetyPrompt,
  buildDelegationGuidanceSection,
  buildUiPresentationPrompt,
  isHostScopedAgentToolActive,
  listToolPromptGuidance,
  resolveMainSessionDelegationMode,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { listRegisteredPluginAgentPromptGuidance } from "openclaw/plugin-sdk/plugin-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { deniesCodexNativeDelegation } from "../../native-tool-policy.js";
import { readCodexConfigValue } from "./config-layer-policy.js";
import { joinPresentSections } from "./developer-instruction-sections.js";
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
import type { CodexThreadConfigurationOptions } from "./thread-configuration-options.js";

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
  | "pluginHarnessToolPolicySafeDeniedTools"
  | "requireWorkspaceOnly"
  | "toolsAllow"
  | "sourceReplyDeliveryMode"
  | "promptMode"
  | "extraSystemPrompt"
  | "extraSystemPromptTurnContext"
  | "gitCoauthorPrompt"
  | "runtimePlan"
> &
  Partial<Pick<EmbeddedRunAttemptParams, "workspaceDir">>;

// Obligations of Codex's model prompt that outlive it: its channels, steering, compaction,
// and native tools still exist when OpenClaw's base prompt replaces that text.
const CODEX_RUNTIME_GUIDANCE = [
  "## Codex Runtime",
  "Commentary is the progress channel. The final message ends your turn and must stand alone, including every answer the user is still waiting for.",
  "A user message that arrives during work steers the active task: apply corrections, answer briefly, and continue unless they cancel or replace it.",
  "Automatic compaction does not end a task: continue from the summary without restarting finished work or repeating delivered updates.",
];

const CODEX_NATIVE_TOOL_GUIDANCE = [
  "Search with `rg` or `rg --files` when available. Batch independent reads in one `functions.exec` with `Promise.allSettled`; keep dependent, mutating, or approval-gated steps sequential.",
  "Shell command text is code: `JSON.stringify()` is not shell escaping, and backticks or `$()` in `cmd` still execute. Never repurpose `$HOME` or `$CODEX_HOME`.",
  "If automatic approval review rejects an action you cannot complete more safely, name the action and the stated reason.",
  "Connected app tools are exposed directly or load through `tool_search`; app mentions look like `[$app-name](app://connector_id)`. Plugins are not invoked directly: use their skills, apps, and `mcp__server__tool` tools.",
];

/** Ring-zero threads pin empty base instructions, so their policy stays in the developer carrier. */
function isCodexRingZeroThread(
  params: Pick<CodexThreadPromptContext, "toolsAllow">,
  hostSystemAgentActive?: boolean,
): boolean {
  return (
    (hostSystemAgentActive ?? isHostScopedAgentToolActive("openclaw")) &&
    isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow)
  );
}

function listDynamicToolNames(dynamicTools: readonly CodexDynamicToolSpec[] | undefined) {
  return (dynamicTools ?? [])
    .flatMap((spec) => (spec.type === "namespace" ? spec.tools : [spec]))
    .map((tool) => tool.name.trim())
    .filter(Boolean);
}

/**
 * Replaces Codex's model prompt with the regular OpenClaw policy. Codex pins this text in
 * the rollout, so it renders from thread-stable facts only: the thread fingerprint
 * covers it, and a changed render reaches an existing thread on its next cold resume.
 */
function buildCodexBaseInstructions(
  params: CodexThreadPromptContext,
  options: {
    dynamicTools?: readonly CodexDynamicToolSpec[];
    nativeCodeModeEnabled?: boolean;
    nativeModelProvider?: string;
  } = {},
): string {
  const nativeToolsEnabled = options.nativeCodeModeEnabled !== false;
  const promptMode = params.promptMode ?? "full";
  const toolNames = [
    ...listDynamicToolNames(options.dynamicTools),
    ...(nativeToolsEnabled ? ["exec"] : []),
  ];
  // Supervision strips the outer plan because auth and routing stay native. Only this prompt
  // resolver is used here, so the thread's provider owns its guidance as a regular run's does.
  const promptPlan =
    params.runtimePlan ??
    (options.nativeModelProvider
      ? buildAgentRuntimePlan({
          config: params.config,
          workspaceDir: params.workspaceDir,
          provider: options.nativeModelProvider,
          modelId: params.modelId,
        })
      : undefined);
  return joinPresentSections(
    buildAgentHarnessBasePrompt({
      config: params.config,
      toolNames,
      promptMode,
      promptContribution: promptPlan?.prompt.resolveSystemPromptContribution({
        config: params.config,
        provider: promptPlan.prompt.provider,
        modelId: params.modelId,
        promptMode,
        agentId: params.agentId,
      }),
      nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
        surface: "codex_app_server",
        includeLegacyGlobalGuidance: false,
      }),
    }),
    promptMode === "none"
      ? undefined
      : [...CODEX_RUNTIME_GUIDANCE, ...(nativeToolsEnabled ? CODEX_NATIVE_TOOL_GUIDANCE : [])].join(
          "\n",
        ),
  );
}

// Neither key has a Codex default, so a string in the effective config is authored.
function hasAuthoredCodexBaseInstructions(
  options: Pick<CodexThreadConfigurationOptions, "config" | "nativeConfig">,
): boolean {
  return ["model_instructions_file", "instructions"].some((key) =>
    [options.config, options.nativeConfig?.config].some(
      (config) => config !== undefined && typeof readCodexConfigValue(config, key) === "string",
    ),
  );
}

/**
 * OpenClaw's rendered base, whichever carrier holds it. Ring-zero threads have none, and
 * neither do threads whose before_prompt_build `systemPrompt` replaced OpenClaw's policy.
 */
export function resolveCodexOpenClawBaseInstructions(
  params: CodexThreadPromptContext,
  options: Pick<
    CodexThreadConfigurationOptions,
    | "dynamicTools"
    | "nativeCodeModeEnabled"
    | "nativeModelProvider"
    | "hostSystemAgentActive"
    | "systemPromptReplaced"
  >,
): string | undefined {
  return options.systemPromptReplaced ||
    isCodexRingZeroThread(params, options.hostSystemAgentActive)
    ? undefined
    : buildCodexBaseInstructions(params, options);
}

/**
 * A request base outranks `model_instructions_file` and `instructions`
 * (codex-rs/core/src/config/mod.rs), so with either authored OpenClaw omits the base and
 * carries its policy ahead of the developer instructions. Start and resume place it alike,
 * keeping warm reuse and fork snapshots consistent with the creation request.
 *
 * A replaced system prompt replaces the base too: an explicit empty base outranks the
 * rollout's saved one on a cold resume (codex-rs/core/src/session/mod.rs, base priority
 * order), so an existing thread drops OpenClaw's base in place. A loaded thread ignores
 * the override; the base is part of the configuration fingerprint, so the change takes the
 * cold-resume path. An authored base stays the operator's.
 */
export function placeCodexBaseInstructions(
  params: CodexThreadPromptContext,
  options: CodexThreadConfigurationOptions,
  developerInstructions: string,
  ringZero: { baseInstructions?: string },
): { baseInstructions?: string; developerInstructions: string } {
  if (isCodexRingZeroThread(params, options.hostSystemAgentActive)) {
    return { ...ringZero, developerInstructions };
  }
  const baseInstructions = resolveCodexOpenClawBaseInstructions(params, options);
  if (hasAuthoredCodexBaseInstructions(options)) {
    return { developerInstructions: joinPresentSections(baseInstructions, developerInstructions) };
  }
  return { baseInstructions: baseInstructions ?? "", developerInstructions };
}

/** Move only the exact section annotated by its producer; later policy additions survive. */
export function splitCodexExtraSystemPrompt(
  params: Pick<CodexThreadPromptContext, "extraSystemPrompt" | "extraSystemPromptTurnContext">,
) {
  const prompt = params.extraSystemPrompt;
  const context = params.extraSystemPromptTurnContext;
  if (!prompt || !context?.text || !Number.isInteger(context.start) || context.start < 0) {
    return { persistent: prompt, turn: undefined };
  }
  const end = context.start + context.text.length;
  if (
    prompt.slice(context.start, end) !== context.text ||
    (context.start > 0 && prompt.slice(context.start - 2, context.start) !== "\n\n") ||
    (end < prompt.length && prompt.slice(end, end + 2) !== "\n\n")
  ) {
    return { persistent: prompt, turn: undefined };
  }
  return {
    persistent:
      context.start === 0
        ? prompt.slice(end === prompt.length ? end : end + 2)
        : prompt.slice(0, context.start - 2) + prompt.slice(end),
    turn: context.text,
  };
}

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
    splitCodexExtraSystemPrompt(params).turn ??
      "No additional conversation instructions for this turn.",
    `Current OpenClaw tool bindings for this turn (accepted declarations alone do not grant execution): ${availableNames.length ? availableNames.toSorted().join(", ") : "none"}.`,
  ].join("\n\n");
}

export function buildDeveloperInstructions(
  params: CodexThreadPromptContext,
  options: {
    dynamicTools?: readonly CodexDynamicToolSpec[];
    nativeCodeModeEnabled?: boolean;
    nativeCodeModeOnlyEnabled?: boolean;
    hostSystemAgentActive?: boolean;
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
  // The base prompt owns this policy unless it is empty (ring zero) or identity-only (none).
  const policyInDeveloperCarrier =
    params.promptMode === "none" || isCodexRingZeroThread(params, options.hostSystemAgentActive);
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
    !deniesCodexNativeDelegation(params.pluginHarnessToolPolicySafeDeniedTools) &&
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
    policyInDeveloperCarrier
      ? "You are a personal agent running inside OpenClaw. OpenClaw has dynamic tools for OpenClaw-owned messaging, cron, sessions, media, gateway, and nodes."
      : "OpenClaw has dynamic tools for OpenClaw-owned messaging, cron, sessions, media, gateway, and nodes.",
    deferredToolNames.size > 0
      ? `Deferred searchable OpenClaw dynamic tools available: ${[...deferredToolNames]
          .toSorted((left, right) => left.localeCompare(right))
          .join(", ")}.`
      : undefined,
    deferredToolDiscoveryGuidance,
    policyInDeveloperCarrier ? listToolPromptGuidance(toolNames.keys()).join("\n\n") : undefined,
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
    policyInDeveloperCarrier
      ? buildCredentialSafetyPrompt({
          controlToolsAvailable:
            params.disableTools !== true && (toolNames.has("openclaw") || toolNames.has("gateway")),
        })
      : undefined,
    policyInDeveloperCarrier
      ? listRegisteredPluginAgentPromptGuidance({
          surface: "codex_app_server",
          includeLegacyGlobalGuidance: false,
        }).join("\n")
      : undefined,
    params.gitCoauthorPrompt,
    options.omitConversationTurnContext
      ? splitCodexExtraSystemPrompt(params).persistent
      : params.extraSystemPrompt,
  ];
  return sections.filter((section) => section?.trim()).join("\n\n");
}
