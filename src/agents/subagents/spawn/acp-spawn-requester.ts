import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listSessionBindingsBySessionAsync } from "../../../infra/outbound/session-binding-service.js";
import {
  isSubagentSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";
import { deliveryContextFromSession } from "../../../utils/delivery-context.read.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import {
  resolveRequesterOriginForChild,
  resolveSpawnRequesterConversationTarget,
} from "../../spawn-requester-origin.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";
import {
  hasSessionLocalHeartbeatRelayRoute,
  isHeartbeatEnabledForSessionAgent,
} from "./acp-spawn-heartbeat.js";

type AcpSpawnRequesterContext = {
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentThreadTs?: string | number;
  currentConversationOrigin?: import("../../../gateway/mcp-grant-store.js").McpCurrentConversationOrigin;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
};

export type AcpSpawnRequesterState = {
  isSubagentSession: boolean;
  hasActiveSubagentBinding: boolean;
  hasThreadContext: boolean;
  heartbeatEnabled: boolean;
  heartbeatRelayRouteUsable: boolean;
  origin: ReturnType<typeof normalizeDeliveryContext>;
};

export async function readAcpSpawnParentDeliveryContext(params: {
  parentSessionKey: string;
  requesterAgentId: string;
  assertActive?: () => void;
}) {
  return await withSessionEntryReadOnlyInWorker(
    {
      sessionKey: params.parentSessionKey,
      agentId: resolveAgentIdFromSessionKey(params.parentSessionKey, params.requesterAgentId),
      clone: false,
    },
    () => params.assertActive?.(),
    async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return deliveryContextFromSession(read.value);
    },
  );
}

export function resolveRequesterInternalSessionKey(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
}): string {
  const { alias } = resolveMainSessionAlias(params.cfg);
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  return requesterSessionKey
    ? resolveInternalSessionKey({ key: requesterSessionKey, alias })
    : alias;
}

export async function resolveAcpSpawnRequesterState(params: {
  cfg: OpenClawConfig;
  parentSessionKey?: string;
  requesterAgentId: string;
  ownerAgentId: string;
  ctx: AcpSpawnRequesterContext;
  assertActive?: () => void;
}): Promise<AcpSpawnRequesterState> {
  const requesterParsedSession = parseAgentSessionKey(params.parentSessionKey);
  const isSubagentSession =
    Boolean(requesterParsedSession) && isSubagentSessionKey(params.parentSessionKey);
  const [hasActiveSubagentBinding, heartbeatRelayRouteUsable] = await Promise.all([
    isSubagentSession && params.parentSessionKey
      ? listSessionBindingsBySessionAsync(params.parentSessionKey).then((records) =>
          records.some((record) => record.targetKind === "subagent" && record.status !== "ended"),
        )
      : false,
    params.parentSessionKey && params.requesterAgentId
      ? hasSessionLocalHeartbeatRelayRoute({
          cfg: params.cfg,
          parentSessionKey: params.parentSessionKey,
          requesterAgentId: params.requesterAgentId,
          assertActive: params.assertActive,
        })
      : false,
  ]);
  params.assertActive?.();
  const hasThreadContext =
    typeof params.ctx.agentThreadId === "string"
      ? Boolean(normalizeOptionalString(params.ctx.agentThreadId))
      : params.ctx.agentThreadId != null;
  // ACP thread binding uses the same requester-conversation resolution as native
  // spawn: an explicit agentTo wins, and CLI runtimes without `agentTo` fall
  // back to currentMessagingTarget/currentChannelId/currentThreadTs (issue #158945).
  const requesterConversation = resolveSpawnRequesterConversationTarget(params.ctx);
  return {
    isSubagentSession,
    hasActiveSubagentBinding,
    hasThreadContext,
    heartbeatEnabled: isHeartbeatEnabledForSessionAgent({
      cfg: params.cfg,
      requesterAgentId: params.requesterAgentId,
      sessionKey: params.parentSessionKey,
    }),
    heartbeatRelayRouteUsable,
    origin: resolveRequesterOriginForChild({
      cfg: params.cfg,
      targetAgentId: params.ownerAgentId,
      requesterAgentId: params.requesterAgentId,
      requesterChannel: params.ctx.agentChannel,
      requesterAccountId: params.ctx.agentAccountId,
      requesterTo: requesterConversation.to,
      requesterThreadId: requesterConversation.threadId,
      requesterGroupSpace: params.ctx.agentGroupSpace,
      requesterMemberRoleIds: params.ctx.agentMemberRoleIds,
    }),
  };
}

export function shouldStreamAcpSpawnToParent(params: {
  spawnMode: "run" | "session";
  requestThreadBinding: boolean;
  streamToParentRequested: boolean;
  requester: AcpSpawnRequesterState;
}): boolean {
  // Thread-bound requesters require an explicit request to avoid unsolicited progress chatter.
  const implicitStreamToParent =
    params.spawnMode === "run" &&
    !params.requestThreadBinding &&
    params.requester.isSubagentSession &&
    !params.requester.hasActiveSubagentBinding &&
    !params.requester.hasThreadContext &&
    params.requester.heartbeatEnabled &&
    params.requester.heartbeatRelayRouteUsable;

  return params.streamToParentRequested || implicitStreamToParent;
}
