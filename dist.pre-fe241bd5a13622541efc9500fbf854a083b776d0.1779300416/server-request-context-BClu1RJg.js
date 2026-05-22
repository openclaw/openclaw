import { t as disconnectAllSharedGatewayAuthClients } from "./server-shared-auth-generation-Csm1h6QK.js";
//#region src/gateway/server-request-context.ts
function createGatewayRequestContext(params) {
	const hasApprovalScope = (gatewayClient) => {
		const scopes = Array.isArray(gatewayClient.connect.scopes) ? gatewayClient.connect.scopes : [];
		return scopes.includes("operator.admin") || scopes.includes("operator.approvals");
	};
	return {
		deps: params.deps,
		get cron() {
			return params.runtimeState.cronState.cron;
		},
		get cronStorePath() {
			return params.runtimeState.cronState.storePath;
		},
		getRuntimeConfig: params.getRuntimeConfig,
		execApprovalManager: params.execApprovalManager,
		pluginApprovalManager: params.pluginApprovalManager,
		loadGatewayModelCatalog: params.loadGatewayModelCatalog,
		getHealthCache: params.getHealthCache,
		refreshHealthSnapshot: params.refreshHealthSnapshot,
		logHealth: params.logHealth,
		logGateway: params.logGateway,
		incrementPresenceVersion: params.incrementPresenceVersion,
		getHealthVersion: params.getHealthVersion,
		broadcast: params.broadcast,
		broadcastToConnIds: params.broadcastToConnIds,
		nodeSendToSession: params.nodeSendToSession,
		nodeSendToAllSubscribed: params.nodeSendToAllSubscribed,
		nodeSubscribe: params.nodeSubscribe,
		nodeUnsubscribe: params.nodeUnsubscribe,
		nodeUnsubscribeAll: params.nodeUnsubscribeAll,
		hasConnectedTalkNode: params.hasConnectedTalkNode,
		hasExecApprovalClients: (excludeConnId) => {
			for (const gatewayClient of params.clients) {
				if (excludeConnId && gatewayClient.connId === excludeConnId) continue;
				if (hasApprovalScope(gatewayClient)) return true;
			}
			return false;
		},
		getApprovalClientConnIds: (opts = {}) => {
			const connIds = /* @__PURE__ */ new Set();
			for (const gatewayClient of params.clients) {
				if (!gatewayClient.connId) continue;
				if (opts.excludeConnId && gatewayClient.connId === opts.excludeConnId) continue;
				if (!hasApprovalScope(gatewayClient)) continue;
				if (opts.filter && !opts.filter(gatewayClient, opts.record)) continue;
				connIds.add(gatewayClient.connId);
			}
			return connIds;
		},
		disconnectClientsForDevice: (deviceId, opts) => {
			for (const gatewayClient of params.clients) {
				if (gatewayClient.connect.device?.id !== deviceId) continue;
				if (opts?.role && gatewayClient.connect.role !== opts.role) continue;
				try {
					gatewayClient.socket.close(4001, "device removed");
				} catch {}
			}
		},
		disconnectClientsUsingSharedGatewayAuth: () => {
			disconnectAllSharedGatewayAuthClients(params.clients);
		},
		enforceSharedGatewayAuthGenerationForConfigWrite: params.enforceSharedGatewayAuthGenerationForConfigWrite,
		nodeRegistry: params.nodeRegistry,
		agentRunSeq: params.agentRunSeq,
		chatAbortControllers: params.chatAbortControllers,
		chatAbortedRuns: params.chatAbortedRuns,
		chatRunBuffers: params.chatRunBuffers,
		chatDeltaSentAt: params.chatDeltaSentAt,
		chatDeltaLastBroadcastLen: params.chatDeltaLastBroadcastLen,
		chatDeltaLastBroadcastText: params.chatDeltaLastBroadcastText,
		agentDeltaSentAt: params.agentDeltaSentAt,
		bufferedAgentEvents: params.bufferedAgentEvents,
		addChatRun: params.addChatRun,
		removeChatRun: params.removeChatRun,
		subscribeSessionEvents: params.subscribeSessionEvents,
		unsubscribeSessionEvents: params.unsubscribeSessionEvents,
		subscribeSessionMessageEvents: params.subscribeSessionMessageEvents,
		unsubscribeSessionMessageEvents: params.unsubscribeSessionMessageEvents,
		unsubscribeAllSessionEvents: params.unsubscribeAllSessionEvents,
		getSessionEventSubscriberConnIds: params.getSessionEventSubscriberConnIds,
		registerToolEventRecipient: params.registerToolEventRecipient,
		dedupe: params.dedupe,
		wizardSessions: params.wizardSessions,
		findRunningWizard: params.findRunningWizard,
		purgeWizardSession: params.purgeWizardSession,
		getRuntimeSnapshot: params.getRuntimeSnapshot,
		getEventLoopHealth: params.getEventLoopHealth,
		startChannel: params.startChannel,
		stopChannel: params.stopChannel,
		markChannelLoggedOut: params.markChannelLoggedOut,
		wizardRunner: params.wizardRunner,
		broadcastVoiceWakeChanged: params.broadcastVoiceWakeChanged,
		broadcastVoiceWakeRoutingChanged: params.broadcastVoiceWakeRoutingChanged,
		unavailableGatewayMethods: params.unavailableGatewayMethods
	};
}
//#endregion
export { createGatewayRequestContext };
