//#region src/plugins/api-facades.ts
function attachPluginApiFacades(api) {
	api.session = {
		state: { registerSessionExtension: (...args) => api.registerSessionExtension(...args) },
		workflow: {
			enqueueNextTurnInjection: (...args) => api.enqueueNextTurnInjection(...args),
			registerSessionSchedulerJob: (...args) => api.registerSessionSchedulerJob(...args),
			sendSessionAttachment: (...args) => api.sendSessionAttachment(...args),
			scheduleSessionTurn: (...args) => api.scheduleSessionTurn(...args),
			unscheduleSessionTurnsByTag: (...args) => api.unscheduleSessionTurnsByTag(...args)
		},
		controls: {
			registerSessionAction: (...args) => api.registerSessionAction(...args),
			registerControlUiDescriptor: (...args) => api.registerControlUiDescriptor(...args)
		}
	};
	api.agent = { events: {
		registerAgentEventSubscription: (...args) => api.registerAgentEventSubscription(...args),
		emitAgentEvent: (...args) => api.emitAgentEvent(...args)
	} };
	api.runContext = {
		setRunContext: (...args) => api.setRunContext(...args),
		getRunContext: (...args) => api.getRunContext(...args),
		clearRunContext: (...args) => api.clearRunContext(...args)
	};
	api.lifecycle = { registerRuntimeLifecycle: (...args) => api.registerRuntimeLifecycle(...args) };
	return api;
}
//#endregion
export { attachPluginApiFacades as t };
