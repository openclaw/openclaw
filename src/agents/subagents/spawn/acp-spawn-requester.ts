import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  attributeDelegatedSessionCreator,
  buildSessionCreationStamp,
  inheritSessionGitContributorProfileIds,
} from "../../../config/sessions/session-entry-provenance.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listSessionBindingsBySessionAsync } from "../../../infra/outbound/session-binding-service.js";
import {
  isSubagentSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";
import { deliveryContextFromSession } from "../../../utils/delivery-context.read.js";
import {
  hasDeliveryTargetFields,
  normalizeDeliveryContext,
} from "../../../utils/delivery-context.shared.js";
import {
  resolveRequesterOriginForChild,
  resolveSpawnRequesterConversationTarget,
  type SpawnRequesterConversationSource,
} from "../../spawn-requester-origin.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";

type AcpSpawnRequesterContext = SpawnRequesterConversationSource & {
  agentChannel?: string;
  agentAccountId?: string;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
};

export type AcpSpawnRequesterState = {
  isSubagentSession: boolean;
  hasActiveSubagentBinding: boolean;
  hasThreadContext: boolean;
  sessionRelayRouteUsable: boolean;
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
  const hasActiveSubagentBinding =
    isSubagentSession && params.parentSessionKey
      ? (await listSessionBindingsBySessionAsync(params.parentSessionKey)).some(
          (record) => record.targetKind === "subagent" && record.status !== "ended",
        )
      : false;
  params.assertActive?.();
  const requesterConversation = resolveSpawnRequesterConversationTarget(params.ctx);
  const hasThreadContext = requesterConversation.threadId != null;
  const sessionRelayRouteUsable = Boolean(
    isSubagentSession &&
    !hasActiveSubagentBinding &&
    !hasThreadContext &&
    params.parentSessionKey &&
    params.cfg.session?.scope !== "global" &&
    hasDeliveryTargetFields(
      await readAcpSpawnParentDeliveryContext({
        parentSessionKey: params.parentSessionKey,
        requesterAgentId: params.requesterAgentId,
        assertActive: params.assertActive,
      }),
    ),
  );
  params.assertActive?.();
  return {
    isSubagentSession,
    hasActiveSubagentBinding,
    hasThreadContext,
    sessionRelayRouteUsable,
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
    params.requester.sessionRelayRouteUsable;

  return params.streamToParentRequested || implicitStreamToParent;
}

/** Build immutable creator facts from the requester captured before spawn awaits. */
export function buildAcpSpawnCreationStamp(params: {
  cfg: OpenClawConfig;
  parentEntry?: SessionEntry;
  requesterAgentId: string;
  requesterSessionKey: string;
  creatorProfileId?: string;
  gitContributorProfileId?: string;
}) {
  return buildSessionCreationStamp({
    via: "spawn",
    actor: attributeDelegatedSessionCreator(
      { type: "agent", id: params.requesterAgentId },
      params.creatorProfileId,
    ),
    inheritedGitContributorProfileIds: inheritSessionGitContributorProfileIds(params.parentEntry, {
      config: params.cfg,
      agentId: params.requesterAgentId,
      sessionKey: params.requesterSessionKey,
      requesterProfileId: params.gitContributorProfileId,
    }),
  });
}
