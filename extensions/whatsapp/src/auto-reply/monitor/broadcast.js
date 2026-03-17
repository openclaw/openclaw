import {
  buildAgentSessionKey,
  deriveLastRoutePolicy
} from "../../../../../src/routing/resolve-route.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_MAIN_KEY,
  normalizeAgentId
} from "../../../../../src/routing/session-key.js";
import { formatError } from "../../session.js";
import { whatsappInboundLog } from "../loggers.js";
function buildBroadcastRouteKeys(params) {
  const sessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
    peer: {
      kind: params.msg.chatType === "group" ? "group" : "direct",
      id: params.peerId
    },
    dmScope: params.cfg.session?.dmScope,
    identityLinks: params.cfg.session?.identityLinks
  });
  const mainSessionKey = buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: DEFAULT_MAIN_KEY
  });
  return {
    sessionKey,
    mainSessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({
      sessionKey,
      mainSessionKey
    })
  };
}
async function maybeBroadcastMessage(params) {
  const broadcastAgents = params.cfg.broadcast?.[params.peerId];
  if (!broadcastAgents || !Array.isArray(broadcastAgents)) {
    return false;
  }
  if (broadcastAgents.length === 0) {
    return false;
  }
  const strategy = params.cfg.broadcast?.strategy || "parallel";
  whatsappInboundLog.info(`Broadcasting message to ${broadcastAgents.length} agents (${strategy})`);
  const agentIds = params.cfg.agents?.list?.map((agent) => normalizeAgentId(agent.id));
  const hasKnownAgents = (agentIds?.length ?? 0) > 0;
  const groupHistorySnapshot = params.msg.chatType === "group" ? params.groupHistories.get(params.groupHistoryKey) ?? [] : void 0;
  const processForAgent = async (agentId) => {
    const normalizedAgentId = normalizeAgentId(agentId);
    if (hasKnownAgents && !agentIds?.includes(normalizedAgentId)) {
      whatsappInboundLog.warn(`Broadcast agent ${agentId} not found in agents.list; skipping`);
      return false;
    }
    const routeKeys = buildBroadcastRouteKeys({
      cfg: params.cfg,
      msg: params.msg,
      route: params.route,
      peerId: params.peerId,
      agentId: normalizedAgentId
    });
    const agentRoute = {
      ...params.route,
      agentId: normalizedAgentId,
      ...routeKeys
    };
    try {
      return await params.processMessage(params.msg, agentRoute, params.groupHistoryKey, {
        groupHistory: groupHistorySnapshot,
        suppressGroupHistoryClear: true
      });
    } catch (err) {
      whatsappInboundLog.error(`Broadcast agent ${agentId} failed: ${formatError(err)}`);
      return false;
    }
  };
  if (strategy === "sequential") {
    for (const agentId of broadcastAgents) {
      await processForAgent(agentId);
    }
  } else {
    await Promise.allSettled(broadcastAgents.map(processForAgent));
  }
  if (params.msg.chatType === "group") {
    params.groupHistories.set(params.groupHistoryKey, []);
  }
  return true;
}
export {
  maybeBroadcastMessage
};
