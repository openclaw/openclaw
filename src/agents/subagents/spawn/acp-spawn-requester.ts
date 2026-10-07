import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { readAcpResumeSessionOwner } from "../../../acp/runtime/session-meta-resume.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
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
import { resolveRequesterOriginForChild } from "../../spawn-requester-origin.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";

type AcpSpawnRequesterContext = {
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
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
  targetAgentId: string;
  ctx: AcpSpawnRequesterContext;
  assertActive?: () => void;
}): Promise<AcpSpawnRequesterState> {
  const bindingService = getSessionBindingService();
  const requesterParsedSession = parseAgentSessionKey(params.parentSessionKey);
  const isSubagentSession =
    Boolean(requesterParsedSession) && isSubagentSessionKey(params.parentSessionKey);
  const hasActiveSubagentBinding =
    isSubagentSession && params.parentSessionKey
      ? bindingService
          .listBySession(params.parentSessionKey)
          .some((record) => record.targetKind === "subagent" && record.status !== "ended")
      : false;
  const hasThreadContext =
    typeof params.ctx.agentThreadId === "string"
      ? Boolean(normalizeOptionalString(params.ctx.agentThreadId))
      : params.ctx.agentThreadId != null;
  return {
    isSubagentSession,
    hasActiveSubagentBinding,
    hasThreadContext,
    sessionRelayRouteUsable: Boolean(
      params.parentSessionKey &&
      params.cfg.session?.scope !== "global" &&
      hasDeliveryTargetFields(
        await readAcpSpawnParentDeliveryContext({
          parentSessionKey: params.parentSessionKey,
          requesterAgentId: params.requesterAgentId,
          assertActive: params.assertActive,
        }),
      ),
    ),
    origin: resolveRequesterOriginForChild({
      cfg: params.cfg,
      targetAgentId: params.targetAgentId,
      requesterAgentId: params.requesterAgentId,
      requesterChannel: params.ctx.agentChannel,
      requesterAccountId: params.ctx.agentAccountId,
      requesterTo: params.ctx.agentTo,
      requesterThreadId: params.ctx.agentThreadId,
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

export async function validateAcpResumeSessionOwnership(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  backendId?: string;
  requesterSessionKey?: string;
  resumeSessionId?: string;
  assertCurrent?: () => void;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const resumeSessionId = normalizeOptionalString(params.resumeSessionId);
  if (!resumeSessionId) {
    return { ok: true };
  }
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  if (!requesterSessionKey) {
    return {
      ok: false,
      error: "sessions_spawn resumeSessionId requires an active requester session context.",
    };
  }

  const owner = await readAcpResumeSessionOwner({
    cfg: params.cfg,
    agentId: params.targetAgentId,
    backendId: normalizeOptionalLowercaseString(params.backendId),
    resumeSessionId,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent?.();
  if (
    owner &&
    (owner.sessionKey === requesterSessionKey ||
      normalizeOptionalString(owner.entry.spawnedBy) === requesterSessionKey ||
      normalizeOptionalString(owner.entry.parentSessionKey) === requesterSessionKey)
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      "sessions_spawn resumeSessionId is only allowed for ACP sessions previously recorded for this requester. Omit resumeSessionId to start a fresh ACP session.",
  };
}
