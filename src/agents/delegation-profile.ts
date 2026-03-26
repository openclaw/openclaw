import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import {
  resolveStoredSubagentCapabilities,
  resolveSubagentRolePresetDefaults,
  normalizeSubagentRolePreset,
} from "./subagent-capabilities.js";
import { getSubagentRunByChildSessionKey } from "./subagent-registry.js";
import { normalizeToolName } from "./tool-policy.js";

const DELEGATION_TOOL_NAMES = [
  "agents_list",
  "sessions_spawn",
  "subagents",
  "sessions_list",
  "sessions_history",
  "sessions_send",
] as const;

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function buildDelegationProfile(params: {
  sessionKey?: string;
  spawnedBy?: string | null;
  workspaceDir?: string;
  tools: AgentTool[];
  config?: OpenClawConfig;
}): SessionSystemPromptReport["delegationProfile"] {
  const sessionKey = normalizeText(params.sessionKey);
  if (!sessionKey) {
    return undefined;
  }

  const capabilities = resolveStoredSubagentCapabilities(sessionKey, {
    cfg: params.config,
  });
  const runRecord = getSubagentRunByChildSessionKey(sessionKey);
  const toolNames = new Set(params.tools.map((tool) => normalizeToolName(tool.name)));
  const delegationToolsAllowed = DELEGATION_TOOL_NAMES.filter((toolName) =>
    toolNames.has(toolName),
  );
  const delegationToolsBlocked = DELEGATION_TOOL_NAMES.filter(
    (toolName) => !toolNames.has(toolName),
  );
  const parentSessionKey =
    normalizeText(params.spawnedBy) ?? normalizeText(runRecord?.requesterSessionKey);
  const rolePreset = capabilities.rolePreset ?? normalizeSubagentRolePreset(runRecord?.rolePreset);
  const rolePresetDefaults =
    capabilities.rolePresetDefaults ?? resolveSubagentRolePresetDefaults(rolePreset);

  return {
    role: capabilities.role,
    ...(rolePreset ? { rolePreset } : {}),
    ...(rolePresetDefaults
      ? {
          promptMode: rolePresetDefaults.promptMode,
          toolBias: rolePresetDefaults.toolBias,
          verificationPosture: rolePresetDefaults.verificationPosture,
          artifactWriteScope: rolePresetDefaults.artifactWriteScope,
        }
      : {}),
    controlScope: capabilities.controlScope,
    depth: capabilities.depth,
    canSpawn: capabilities.canSpawn,
    canControlChildren: capabilities.canControlChildren,
    workspaceSource: parentSessionKey ? "inherited" : "primary",
    workspaceDir: normalizeText(params.workspaceDir) ?? normalizeText(runRecord?.workspaceDir),
    buildRunId: normalizeText(runRecord?.buildRunId),
    buildRunDir: normalizeText(runRecord?.buildRunDir),
    parentSessionKey,
    requesterSessionKey: normalizeText(runRecord?.requesterSessionKey),
    task: normalizeText(runRecord?.task),
    label: normalizeText(runRecord?.label),
    delegationToolsAllowed,
    delegationToolsBlocked,
  };
}
