//#region src/infra/npm-integrity.ts
function normalizeIntegrity(value) {
	const normalized = value?.trim();
	return normalized ? normalized : void 0;
}
async function resolveNpmIntegrityDrift(params) {
	const expectedIntegrity = normalizeIntegrity(params.expectedIntegrity);
	const actualIntegrity = normalizeIntegrity(params.resolution.integrity);
	if (!expectedIntegrity || !actualIntegrity) return { proceed: true };
	if (expectedIntegrity === actualIntegrity) return { proceed: true };
	const integrityDrift = {
		expectedIntegrity,
		actualIntegrity
	};
	const payload = params.createPayload({
		spec: params.spec,
		expectedIntegrity: integrityDrift.expectedIntegrity,
		actualIntegrity: integrityDrift.actualIntegrity,
		resolution: params.resolution
	});
	let proceed = false;
	if (params.onIntegrityDrift) proceed = await params.onIntegrityDrift(payload);
	else params.warn?.(payload);
	return {
		integrityDrift,
		proceed,
		payload
	};
}
async function resolveNpmIntegrityDriftWithDefaultMessage(params) {
	const driftResult = await resolveNpmIntegrityDrift({
		spec: params.spec,
		expectedIntegrity: params.expectedIntegrity,
		resolution: params.resolution,
		createPayload: (drift) => ({ ...drift }),
		onIntegrityDrift: params.onIntegrityDrift,
		warn: (driftPayload) => {
			params.warn?.(`Integrity drift detected for ${driftPayload.resolution.resolvedSpec ?? driftPayload.spec}: expected ${driftPayload.expectedIntegrity}, got ${driftPayload.actualIntegrity}`);
		}
	});
	if (!driftResult.proceed && driftResult.payload) return {
		integrityDrift: driftResult.integrityDrift,
		error: `aborted: npm package integrity drift detected for ${driftResult.payload.resolution.resolvedSpec ?? driftResult.payload.spec}`
	};
	return { integrityDrift: driftResult.integrityDrift };
}
//#endregion
export { resolveNpmIntegrityDriftWithDefaultMessage as t };
