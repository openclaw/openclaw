import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ExecElevatedDefaults } from "../bash-tools.js";
import type { SkillSnapshot } from "../skills.js";

export type EmbeddedCompactionRuntimeContext = {
  sessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  authProfileId?: string;
  workspaceDir: string;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string;
  provider?: string;
  model?: string;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
};

/**
 * Resolve the compaction model override from config, falling back to the
 * caller-supplied provider/model. This ensures the runtime context always
 * carries the correct compaction model regardless of which context engine
 * handles the actual compact() call.
 */
function resolveCompactionModel(params: {
  config?: OpenClawConfig;
  provider?: string | null;
  modelId?: string | null;
  authProfileId?: string | null;
}): { provider: string | undefined; model: string | undefined; authProfileId: string | undefined } {
  const override = params.config?.agents?.defaults?.compaction?.model?.trim();
  if (!override) {
    return {
      provider: params.provider ?? undefined,
      model: params.modelId ?? undefined,
      authProfileId: params.authProfileId ?? undefined,
    };
  }
  const slashIdx = override.indexOf("/");
  if (slashIdx > 0) {
    const overrideProvider = override.slice(0, slashIdx).trim();
    const overrideModel = override.slice(slashIdx + 1).trim() || undefined;
    // When switching provider via override, drop the primary auth profile to
    // avoid sending the wrong credentials.
    const authProfileId =
      overrideProvider !== (params.provider ?? "")?.trim()
        ? undefined
        : (params.authProfileId ?? undefined);
    return { provider: overrideProvider, model: overrideModel, authProfileId };
  }
  return {
    provider: params.provider ?? undefined,
    model: override,
    authProfileId: params.authProfileId ?? undefined,
  };
}

export function buildEmbeddedCompactionRuntimeContext(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  authProfileId?: string | null;
  workspaceDir: string;
  agentDir: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  senderId?: string | null;
  provider?: string | null;
  modelId?: string | null;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  bashElevated?: ExecElevatedDefaults;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
}): EmbeddedCompactionRuntimeContext {
  const resolved = resolveCompactionModel({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    authProfileId: params.authProfileId,
  });
  return {
    sessionKey: params.sessionKey ?? undefined,
    messageChannel: params.messageChannel ?? undefined,
    messageProvider: params.messageProvider ?? undefined,
    agentAccountId: params.agentAccountId ?? undefined,
    currentChannelId: params.currentChannelId ?? undefined,
    currentThreadTs: params.currentThreadTs ?? undefined,
    currentMessageId: params.currentMessageId ?? undefined,
    authProfileId: resolved.authProfileId,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.config,
    skillsSnapshot: params.skillsSnapshot,
    senderIsOwner: params.senderIsOwner,
    senderId: params.senderId ?? undefined,
    provider: resolved.provider,
    model: resolved.model,
    thinkLevel: params.thinkLevel,
    reasoningLevel: params.reasoningLevel,
    bashElevated: params.bashElevated,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
  };
}
