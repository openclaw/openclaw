import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { SessionPlanState } from "../../config/sessions/types.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { ResolvedTimeFormat } from "../date-time.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import type { ProviderSystemPromptContribution } from "../system-prompt-contribution.js";
import { buildAgentSystemPrompt, type PromptMode } from "../system-prompt.js";
import type { EmbeddedSandboxInfo } from "./types.js";
import type { ReasoningLevel, ThinkLevel } from "./utils.js";

export function buildPlanModePromptSection(planState?: SessionPlanState): string {
  const lines = [
    "This session is currently in `plan` runtime mode.",
    "Continue planning only until the user confirms the plan.",
    "Do not execute mutation tools or side-effecting actions while plan mode is active.",
    "Do not call tools such as `write`, `edit`, `apply_patch`, `exec`, `process`, `message`, `sessions_send`, or `sessions_spawn` until the user confirms the plan and you call `exit_plan_mode`.",
    "Use `todo_write` to revise the plan, and use `task_create` or `task_update` only for plan tracking when needed.",
  ];
  const content = planState?.content?.trim();
  const todos =
    planState?.todos
      ?.map((todo) => {
        const id = todo.id.trim();
        const text = todo.text.trim();
        if (!id || !text) {
          return undefined;
        }
        return `- [${todo.status.replaceAll("_", " ")}] ${id}: ${text}`;
      })
      .filter((todo): todo is string => Boolean(todo)) ?? [];

  if (content) {
    lines.push("", "Current plan:", content);
  }
  if (todos.length > 0) {
    lines.push("", "Current todos:", ...todos);
  }
  return lines.join("\n");
}

export function buildEmbeddedSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  ownerDisplay?: "raw" | "hash";
  ownerDisplaySecret?: string;
  reasoningTagHint: boolean;
  heartbeatPrompt?: string;
  skillsPrompt?: string;
  docsPath?: string;
  ttsHint?: string;
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  workspaceNotes?: string[];
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  /** Whether ACP-specific routing guidance should be included. Defaults to true. */
  acpEnabled?: boolean;
  runtimeInfo: {
    agentId?: string;
    host: string;
    os: string;
    arch: string;
    node: string;
    model: string;
    provider?: string;
    capabilities?: string[];
    channel?: string;
    /** Supported message actions for the current channel (e.g., react, edit, unsend) */
    channelActions?: string[];
  };
  messageToolHints?: string[];
  sandboxInfo?: EmbeddedSandboxInfo;
  tools: AgentTool[];
  modelAliasLines: string[];
  userTimezone: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  memoryCitationsMode?: MemoryCitationsMode;
  promptContribution?: ProviderSystemPromptContribution;
  planModeActive?: boolean;
  planState?: SessionPlanState;
}): string {
  const prompt = buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    reasoningLevel: params.reasoningLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    ownerDisplay: params.ownerDisplay,
    ownerDisplaySecret: params.ownerDisplaySecret,
    reasoningTagHint: params.reasoningTagHint,
    heartbeatPrompt: params.heartbeatPrompt,
    skillsPrompt: params.skillsPrompt,
    docsPath: params.docsPath,
    ttsHint: params.ttsHint,
    workspaceNotes: params.workspaceNotes,
    reactionGuidance: params.reactionGuidance,
    promptMode: params.promptMode,
    acpEnabled: params.acpEnabled,
    runtimeInfo: params.runtimeInfo,
    messageToolHints: params.messageToolHints,
    sandboxInfo: params.sandboxInfo,
    toolNames: params.tools.map((tool) => tool.name),
    modelAliasLines: params.modelAliasLines,
    userTimezone: params.userTimezone,
    userTime: params.userTime,
    userTimeFormat: params.userTimeFormat,
    contextFiles: params.contextFiles,
    memoryCitationsMode: params.memoryCitationsMode,
    promptContribution: params.promptContribution,
  });
  if (params.planModeActive !== true) {
    return prompt;
  }
  return `${prompt}\n\n## Plan Mode\n${buildPlanModePromptSection(params.planState)}`;
}

export function createSystemPromptOverride(
  systemPrompt: string,
): (defaultPrompt?: string) => string {
  const override = systemPrompt.trim();
  return (_defaultPrompt?: string) => override;
}

export function applySystemPromptOverrideToSession(
  session: AgentSession,
  override: string | ((defaultPrompt?: string) => string),
) {
  const prompt = typeof override === "function" ? override() : override.trim();
  session.agent.state.systemPrompt = prompt;
  const mutableSession = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  mutableSession._baseSystemPrompt = prompt;
  mutableSession._rebuildSystemPrompt = () => prompt;
}
