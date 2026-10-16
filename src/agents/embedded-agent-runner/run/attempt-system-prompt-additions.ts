import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSessionGitCoauthorPrompt } from "../../git-coauthor-prompt.js";
import { appendIncognitoSystemPrompt } from "../../incognito-system-prompt.js";
import { appendProgressCardSystemPrompt } from "../../progress-card-system-prompt.js";

/** Prepares host-owned additions before either embedded or plugin harness dispatch. */
export async function prepareAttemptSystemPromptAdditions(params: {
  agentId: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  extraSystemPrompt?: string;
  modelId: string;
  provider: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
  toolsAllow?: string[];
}) {
  const extraSystemPrompt = await appendProgressCardSystemPrompt({
    ...params,
    extraSystemPrompt: appendIncognitoSystemPrompt(params),
  });
  const gitCoauthorPrompt = await resolveSessionGitCoauthorPrompt({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    storePath: params.storePath,
  });
  // Credit has its own retained prompt placement; do not fold it into dynamic additions.
  return { extraSystemPrompt, gitCoauthorPrompt };
}
