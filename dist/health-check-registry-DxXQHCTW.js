//#region src/flows/health-check-registry.ts
const REGISTRY = /* @__PURE__ */ new Map();
var HealthCheckRegistrationError = class extends Error {
	constructor(checkId) {
		super(`health check already registered: ${checkId}`);
		this.checkId = checkId;
		this.code = "OC_DOCTOR_DUPLICATE_CHECK";
		this.name = "HealthCheckRegistrationError";
	}
};
function registerHealthCheck(check) {
	if (REGISTRY.has(check.id)) throw new HealthCheckRegistrationError(check.id);
	REGISTRY.set(check.id, check);
}
function listHealthChecks() {
	return [...REGISTRY.values()];
}
function getHealthCheck(id) {
	return REGISTRY.get(id);
}
function clearHealthChecksForTest() {
	REGISTRY.clear();
}
//#endregion
export { registerHealthCheck as i, getHealthCheck as n, listHealthChecks as r, clearHealthChecksForTest as t };
