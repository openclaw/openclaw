import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasPairedCardRenderer } from "../../../infra/device-pairing.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.js";
import { resolveSessionGitCoauthorPrompt } from "../../git-coauthor-prompt.js";
import { prepareProgressCardToolForOpenClawTools } from "../../openclaw-tools.registration.js";
import { resolveUtilityModelRefForAgent } from "../../utility-model.js";

const INCOGNITO_SYSTEM_PROMPT =
  "This chat is incognito; do not store its conversation content in memory files or long-term notes.";
const PROGRESS_CARD_SYSTEM_PROMPT =
  "Create a card with progress_card only for substantial work with at least two meaningful sequential steps, never for greetings, quick questions, or single-step requests. For measurable work with a known total, prefer a leading progress bar labeled with what is measured and observed completed/total counts; never invent percentages. Update or clear existing cards as needed.";

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
  let extraSystemPrompt = params.extraSystemPrompt;
  const incognito =
    isIncognitoSessionKey(params.sessionKey) ||
    (params.storePath &&
      isIncognitoOpenClawAgentSqlitePath(params.storePath, { agentId: params.agentId }));
  if (incognito) {
    const existing = extraSystemPrompt?.trim();
    extraSystemPrompt = existing
      ? `${existing}\n\n${INCOGNITO_SYSTEM_PROMPT}`
      : INCOGNITO_SYSTEM_PROMPT;
  }
  const mainSession =
    !params.sessionKey ||
    canonicalizeMainSessionAlias({
      cfg: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }) ===
      canonicalizeMainSessionAlias({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: resolveAgentMainSessionKey({ cfg: params.config, agentId: params.agentId }),
      });
  // Pairing can change between attempts below the prompt-cache boundary; Codex
  // receives the changed developer instruction on its next thread.
  if (
    !mainSession &&
    (await prepareProgressCardToolForOpenClawTools({
      agentId: params.agentId,
      agentSessionKey: params.sessionKey,
      config: params.config,
      modelId: params.modelId,
      modelProvider: params.provider,
      runtimeToolAllowlist: params.toolsAllow,
    })) &&
    (await hasPairedCardRenderer())
  ) {
    const provider = params.provider.trim().toLowerCase();
    const modelId = params.modelId.trim();
    const authProfileId = params.authProfileId?.trim();
    const modelRef = `${provider}/${modelId}${authProfileId ? `@${authProfileId}` : ""}`;
    const utilityModelRef = resolveUtilityModelRefForAgent({
      cfg: params.config ?? {},
      agentId: params.agentId,
      primaryProvider: provider,
      primaryModelRef: modelRef,
    });
    if (utilityModelRef !== modelRef) {
      const existing = extraSystemPrompt?.trim();
      extraSystemPrompt = existing
        ? `${existing}\n\n${PROGRESS_CARD_SYSTEM_PROMPT}`
        : PROGRESS_CARD_SYSTEM_PROMPT;
    }
  }
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
