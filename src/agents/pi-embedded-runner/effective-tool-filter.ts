import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AnyAgentTool } from "../tools/common.js";
import { applyFinalEffectiveToolPolicy } from "./effective-tool-policy.js";

/**
 * Filter tools for the LLM system prompt so that MCP server tools
 * respect `tools.allow` and all other allowlist policies.
 *
 * The bug (issue #78788) was that `effectiveTools` passed to the
 * system-prompt generation still contained **all** MCP tools, even when
 * `tools.allow` explicitly restricted them.  The allowlist was only
 * enforced at tool-call time, not at prompt-construction time.
 *
 * This helper re-applies the full effective-tool policy to the
 * **combined** tool list so the model never sees disallowed tools.
 */
export function filterToolsForSystemPrompt(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  sandboxToolPolicy?: { allow?: string[]; deny?: string[] };
  sessionKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  agentAccountId?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  senderIsOwner?: boolean;
  warn: (message: string) => void;
}): AnyAgentTool[] {
  // Re-use the same policy pipeline that filters bundled tools.
  // The first pass (inside compact.ts) filters bundled tools only;
  // this second pass guarantees the *combined* list is clean.
  return applyFinalEffectiveToolPolicy({
    bundledTools: params.tools,
    config: params.config,
    sandboxToolPolicy: params.sandboxToolPolicy,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    messageProvider: params.messageProvider,
    agentAccountId: params.agentAccountId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    warn: params.warn,
  });
}
