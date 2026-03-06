//#region src/infra/runtime-status.ts
function formatRuntimeStatusWithDetails({ status, pid, state, details = [] }) {
	const runtimeStatus = status ?? "unknown";
	const fullDetails = [];
	if (pid) fullDetails.push(`pid ${pid}`);
	if (state && state.toLowerCase() !== runtimeStatus) fullDetails.push(`state ${state}`);
	for (const detail of details) if (detail) fullDetails.push(detail);
	return fullDetails.length > 0 ? `${runtimeStatus} (${fullDetails.join(", ")})` : runtimeStatus;
}

//#endregion
export { formatRuntimeStatusWithDetails as t };