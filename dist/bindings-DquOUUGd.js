//#region src/config/bindings.ts
function normalizeBindingType(binding) {
	return binding.type === "acp" ? "acp" : "route";
}
function isRouteBinding(binding) {
	return normalizeBindingType(binding) === "route";
}
function isAcpBinding(binding) {
	return normalizeBindingType(binding) === "acp";
}
function listConfiguredBindings(cfg) {
	return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}
function listRouteBindings(cfg) {
	return listConfiguredBindings(cfg).filter(isRouteBinding);
}
function listAcpBindings(cfg) {
	return listConfiguredBindings(cfg).filter(isAcpBinding);
}
//#endregion
export { listRouteBindings as i, listAcpBindings as n, listConfiguredBindings as r, isRouteBinding as t };
