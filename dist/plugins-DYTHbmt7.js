import "./registry-Bf5TpUad.js";
//#region src/channels/plugins/approvals.ts
function resolveChannelApprovalCapability(plugin) {
	return plugin?.approvalCapability;
}
function resolveChannelApprovalAdapter(plugin) {
	const capability = resolveChannelApprovalCapability(plugin);
	if (!capability) return;
	if (!capability.delivery && !capability.nativeRuntime && !capability.render && !capability.native) return;
	return {
		describeExecApprovalSetup: capability.describeExecApprovalSetup,
		delivery: capability.delivery,
		nativeRuntime: capability.nativeRuntime,
		render: capability.render,
		native: capability.native
	};
}
//#endregion
export { resolveChannelApprovalCapability as n, resolveChannelApprovalAdapter as t };
