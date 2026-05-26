//#region src/channels/plugins/target-resolvers.ts
function buildUnresolvedTargetResults(inputs, note) {
	return inputs.map((input) => ({
		input,
		resolved: false,
		note
	}));
}
async function resolveTargetsWithOptionalToken(params) {
	const token = params.token?.trim();
	if (!token) return buildUnresolvedTargetResults(params.inputs, params.missingTokenNote);
	return (await params.resolveWithToken({
		token,
		inputs: params.inputs
	})).map(params.mapResolved);
}
//#endregion
export { resolveTargetsWithOptionalToken as n, buildUnresolvedTargetResults as t };
