import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentIdentity } from "./identity.js";
import {
  loadAgentIdentityFromWorkspace,
  type AgentIdentityFile,
} from "./identity-file.js";

export type AgentIdentityPrompt = {
  name?: string;
  emoji?: string;
  theme?: string;
  creature?: string;
  vibe?: string;
};

function normalizeValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function mergeIdentity(
  configured?: { name?: string; emoji?: string; theme?: string },
  fromFile?: AgentIdentityFile | null,
): AgentIdentityPrompt | null {
  const merged: AgentIdentityPrompt = {
    name: normalizeValue(configured?.name ?? fromFile?.name),
    emoji: normalizeValue(configured?.emoji ?? fromFile?.emoji),
    theme: normalizeValue(configured?.theme ?? fromFile?.theme),
    creature: normalizeValue(fromFile?.creature),
    vibe: normalizeValue(fromFile?.vibe),
  };
  if (!Object.values(merged).some(Boolean)) {
    return null;
  }
  return merged;
}

export function resolveAgentIdentityPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
}): AgentIdentityPrompt | null {
  const configured =
    params.config && params.agentId
      ? resolveAgentIdentity(params.config, params.agentId)
      : undefined;
  const fromFile = params.workspaceDir
    ? loadAgentIdentityFromWorkspace(params.workspaceDir)
    : null;
  return mergeIdentity(configured, fromFile);
}
