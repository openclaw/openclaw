import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolveHeartbeatConfig,
  resolveHeartbeatIntervalMs,
} from "../../../infra/heartbeat-config.js";
import { isHeartbeatEnabledForAgent } from "../../../infra/heartbeat-summary.js";
import { areHeartbeatsEnabled } from "../../../infra/heartbeat-wake.js";
import { deliveryContextFromSession } from "../../../utils/delivery-context.read.js";
import { hasDeliveryTargetFields } from "../../../utils/delivery-context.shared.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";

export function isHeartbeatEnabledForSessionAgent(params: {
  cfg: OpenClawConfig;
  requesterAgentId?: string;
  sessionKey?: string;
}): boolean {
  if (!areHeartbeatsEnabled()) {
    return false;
  }
  if (!params.sessionKey?.trim()) {
    return true;
  }
  const requesterAgentId = resolveSessionAgentIds({
    config: params.cfg,
    agentId: params.requesterAgentId,
    sessionKey: params.sessionKey,
  }).sessionAgentId;

  if (!isHeartbeatEnabledForAgent(params.cfg, requesterAgentId)) {
    return false;
  }

  return (
    resolveHeartbeatIntervalMs(
      params.cfg,
      undefined,
      resolveHeartbeatConfig(params.cfg, requesterAgentId),
    ) !== null
  );
}

export function hasSessionLocalHeartbeatRelayRoute(params: {
  cfg: OpenClawConfig;
  parentSessionKey: string;
  requesterAgentId: string;
}): boolean {
  const scope = params.cfg.session?.scope ?? "per-sender";
  if (scope === "global") {
    return false;
  }

  const heartbeat = resolveHeartbeatConfig(params.cfg, params.requesterAgentId);
  if (heartbeat?.target !== "last") {
    return false;
  }

  // Explicit delivery overrides are not session-local and can route updates
  // to unrelated destinations (for example a pinned ops channel).
  if (normalizeOptionalString(heartbeat.to) || normalizeOptionalString(heartbeat.accountId)) {
    return false;
  }

  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.requesterAgentId,
  });
  const parentEntry = loadSessionEntryReadOnly({
    storePath,
    sessionKey: params.parentSessionKey,
    clone: false,
  });
  const parentDeliveryContext = deliveryContextFromSession(parentEntry);
  return hasDeliveryTargetFields(parentDeliveryContext);
}
