//#region src/commands/doctor/shared/config-mutation-state.ts
function applyDoctorConfigMutation(params) {
	if (params.mutation.changes.length === 0) return params.state;
	return {
		cfg: params.shouldRepair ? params.mutation.config : params.state.cfg,
		candidate: params.mutation.config,
		pendingChanges: true,
		fixHints: !params.shouldRepair && params.fixHint ? [...params.state.fixHints, params.fixHint] : params.state.fixHints
	};
}
//#endregion
export { applyDoctorConfigMutation as t };
