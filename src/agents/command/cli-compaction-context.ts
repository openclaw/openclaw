import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { buildEmbeddedCompactionRuntimeContext } from "../embedded-agent-runner/compaction-runtime-context.js";

export type CliCompactionContext = {
  sessionAgentId: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  workspaceDir: string;
  cwd?: string;
  agentDir: string;
  /** Selected model provider (for example "anthropic"). */
  provider: string;
  model: string;
  /** CLI backend that ran the turn (for example "claude-cli"); owns native compaction policy. */
  cliBackendId?: string;
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  agentAccountId?: string;
  senderIsOwner?: boolean;
  thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  extraSystemPrompt?: string;
};

type CliCompactionRuntimeContextParams = CliCompactionContext & {
  authProfileId?: string;
  harnessRuntime?: string;
  modelSelectionLocked?: boolean;
  currentTokenCount: number;
  contextTokenBudget: number;
  trigger: string;
};

export function buildCliCompactionParams(params: CliCompactionContext) {
  return {
    agentId: params.sessionAgentId,
    config: params.cfg,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    agentDir: params.agentDir,
    provider: params.provider,
    model: params.model,
    skillsSnapshot: params.skillsSnapshot,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
    senderIsOwner: params.senderIsOwner,
    thinkLevel: params.thinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
  };
}

export function buildCliCompactionRuntimeContext(params: CliCompactionRuntimeContextParams) {
  return {
    ...buildEmbeddedCompactionRuntimeContext({
      ...buildCliCompactionParams(params),
      messageProvider: params.messageChannel,
      authProfileId: params.authProfileId,
      modelId: params.model,
      harnessRuntime: params.harnessRuntime,
      modelSelectionLocked: params.modelSelectionLocked,
    }),
    currentTokenCount: params.currentTokenCount,
    tokenBudget: params.contextTokenBudget,
    trigger: params.trigger,
  };
}
