import { resolveControlUiSessionLinkBase } from "../config/control-ui-link-base.js";
import { KNOWLEDGE_CONVERSATION_SCRIBE } from "./knowledge-conversation-scribe.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { createEmbeddedCallGateway } from "./tools/embedded-gateway-stub.js";
import { callAgentToolGatewayRequest } from "./tools/in-process-gateway.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSearchTool } from "./tools/sessions-search-tool.js";

export function createOpenClawSessionLookupTools({
  options,
  embedded,
  requesterSessionKey,
  sessionAgentId,
  sessionConfig,
}: {
  options: OpenClawToolsOptions | undefined;
  embedded: boolean;
  requesterSessionKey: string | undefined;
  sessionAgentId: string;
  sessionConfig: OpenClawToolsOptions["config"];
}) {
  // The UI uses this start request ID for both setup and run-once turns. A
  // caller-chosen ID can only narrow tools here; the owner is the admitted agent.
  const sessionReadAgentOnly =
    options?.scheduledToolTargets?.sessionReadAgentOnly === true ||
    (Boolean(requesterSessionKey) &&
      options?.runId?.startsWith(`${KNOWLEDGE_CONVERSATION_SCRIBE}:${requesterSessionKey}:`) ===
        true);
  const lookupOptions = {
    agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
    sandboxed: options?.sandboxed,
    config: sessionConfig,
    callGateway: embedded ? createEmbeddedCallGateway() : callAgentToolGatewayRequest,
    sessionLinkBase: resolveControlUiSessionLinkBase(options?.config),
    sessionReadAgentOnly,
  };
  return [
    createSessionsListTool({
      ...lookupOptions,
      requesterAgentIdOverride: sessionAgentId,
      requesterProfileId: options?.gatewayUiCommandTarget?.profileId,
      supportsActiveOnly: !embedded,
      requireSessionReadOwner: embedded,
    }),
    createSessionsHistoryTool({
      ...lookupOptions,
      requesterAgentIdOverride: sessionAgentId,
      sessionReadScopeKey: options?.sessionReadScopeKey,
    }),
    createSessionsSearchTool({
      ...lookupOptions,
      agentId: sessionAgentId,
      sessionReadScopeKey: options?.sessionReadScopeKey,
    }),
  ];
}
