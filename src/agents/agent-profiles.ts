/**
 * Agent Profiles: named, built-in harness behavior selected per agent, per
 * model, or as the default (openclaw/rfcs, "Agent Profiles").
 * No prompt text. `openclaw/lean` is the compatibility profile: exactly the lean
 * tool surface that `experimental.localModelLean` switched on. `openclaw/small`
 * is the recommended small-window profile: it trims the prompt and keeps every tool.
 */
import type { AgentProfileId, AgentProfileSelectionSource } from "../config/agent-profile-ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { modelKey } from "../shared/model-key.js";
import { resolveAgentEntry } from "./agent-scope-config.js";
import { resolveSessionAgentIds } from "./agent-scope.js";

type AgentProfile = {
  id: AgentProfileId;
  spec: {
    common: Record<string, never>;
    "openclaw.ai"?: {
      toolProfile?: "lean";
      /** Full prompts drop reference sections; reply, channel and owner guidance stay. */
      promptMode?: "compact";
      /** Ceiling on skills listed in the prompt catalog; 0 lists none. */
      skillsCatalog?: { maxSkills?: number };
      /** Ceiling on injected workspace file characters, across all files. */
      workspaceFiles?: { maxTotalChars?: number };
    };
  };
};

const BUILT_IN_AGENT_PROFILES: Readonly<Record<AgentProfileId, AgentProfile>> = {
  "openclaw/base": { id: "openclaw/base", spec: { common: {} } },
  "openclaw/lean": {
    id: "openclaw/lean",
    spec: { common: {}, "openclaw.ai": { toolProfile: "lean" } },
  },
  "openclaw/small": {
    id: "openclaw/small",
    spec: {
      common: {},
      "openclaw.ai": {
        promptMode: "compact",
        skillsCatalog: { maxSkills: 0 },
        workspaceFiles: { maxTotalChars: 12_000 },
      },
    },
  },
};

export type ResolvedAgentProfile = {
  profile: AgentProfile;
  selectionSource: AgentProfileSelectionSource;
};

export type AgentProfileScope = {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  modelProvider?: string;
  modelId?: string;
};

function isAgentProfileId(value: unknown): value is AgentProfileId {
  return typeof value === "string" && Object.hasOwn(BUILT_IN_AGENT_PROFILES, value);
}

// `auto` and unknown values defer to the next scope; config validation rejects unknown ids.
function explicitProfileId(value: unknown): AgentProfileId | undefined {
  return isAgentProfileId(value) ? value : undefined;
}

// Agent id may arrive explicitly, through the session key, or via config default.
function resolveProfileAgentId(params: AgentProfileScope): string | undefined {
  const explicitAgentId = params.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  if (params.config) {
    return resolveSessionAgentIds({
      config: params.config,
      agentId: explicitAgentId,
      sessionKey: params.sessionKey,
    }).sessionAgentId;
  }
  const parsedSessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  return (
    explicitAgentId ?? (parsedSessionAgentId ? normalizeAgentId(parsedSessionAgentId) : undefined)
  );
}

function modelBinding(
  models: Record<string, { agentProfileId?: string } | undefined> | undefined,
  provider: string | undefined,
  modelId: string | undefined,
): AgentProfileId | undefined {
  if (!models || !provider?.trim() || !modelId?.trim()) {
    return undefined;
  }
  const canonicalKey = modelKey(provider, modelId);
  const rawKey = `${provider.trim()}/${modelId.trim()}`;
  return explicitProfileId(models[canonicalKey]?.agentProfileId ?? models[rawKey]?.agentProfileId);
}

/**
 * Selects one profile. Precedence: agent `agentProfileId`, default
 * `agentProfileId`, the agent's exact model entry, the default exact model
 * entry, then `openclaw/base`.
 */
export function resolveAgentProfile(params: AgentProfileScope): ResolvedAgentProfile {
  const config = params.config;
  const agentId = resolveProfileAgentId(params);
  // The raw entry: resolved agent config merges defaults into agent fields.
  const agent = config && agentId ? resolveAgentEntry(config, agentId) : undefined;
  const defaults = config?.agents?.defaults;
  const candidates: Array<[AgentProfileSelectionSource, AgentProfileId | undefined]> = [
    ["agent-explicit", explicitProfileId(agent?.agentProfileId)],
    ["defaults-explicit", explicitProfileId(defaults?.agentProfileId)],
    ["agent-model", modelBinding(agent?.models, params.modelProvider, params.modelId)],
    ["defaults-model", modelBinding(defaults?.models, params.modelProvider, params.modelId)],
  ];
  for (const [selectionSource, id] of candidates) {
    if (id) {
      return { profile: BUILT_IN_AGENT_PROFILES[id], selectionSource };
    }
  }
  return { profile: BUILT_IN_AGENT_PROFILES["openclaw/base"], selectionSource: "fallback" };
}

export type AgentProfilePromptLimits = NonNullable<AgentProfile["spec"]["openclaw.ai"]>;

/** Prompt-size settings of the selected profile; each one only ever narrows the prompt. */
export function resolveAgentProfilePromptLimits(
  params: AgentProfileScope,
): AgentProfilePromptLimits {
  return resolveAgentProfile(params).profile.spec["openclaw.ai"] ?? {};
}

/** System-prompt inputs for a profile; empty for profiles that leave the prompt alone. */
export function agentProfilePromptParams(profile: AgentProfile): {
  agentProfilePrompt?: { compact?: boolean; maxListedSkills?: number };
} {
  const spec = profile.spec["openclaw.ai"];
  const compact = spec?.promptMode === "compact";
  const maxListedSkills = spec?.skillsCatalog?.maxSkills;
  if (!compact && maxListedSkills === undefined) {
    return {};
  }
  return {
    agentProfilePrompt: {
      ...(compact ? { compact } : {}),
      ...(maxListedSkills === undefined ? {} : { maxListedSkills }),
    },
  };
}
