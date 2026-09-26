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
  provider: string;
  model: string;
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

export function buildCliCompactionRuntimeContext(params: CliCompactionRuntimeContextParams) {
  return {
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: params.sessionKey,
      messageChannel: params.messageChannel,
      messageProvider: params.messageChannel,
      agentAccountId: params.agentAccountId,
      authProfileId: params.authProfileId,
      workspaceDir: params.workspaceDir,
      cwd: params.cwd,
      agentDir: params.agentDir,
      config: params.cfg,
      skillsSnapshot: params.skillsSnapshot,
      senderIsOwner: params.senderIsOwner,
      provider: params.provider,
      modelId: params.model,
      harnessRuntime: params.harnessRuntime,
      modelSelectionLocked: params.modelSelectionLocked,
      thinkLevel: params.thinkLevel,
      extraSystemPrompt: params.extraSystemPrompt,
    }),
    currentTokenCount: params.currentTokenCount,
    tokenBudget: params.contextTokenBudget,
    trigger: params.trigger,
  };
}
