import { c as resolveConfiguredAcpBindingSpecFromRecord, i as resolveConfiguredBindingRecordBySessionKey, l as toResolvedConfiguredAcpBinding, r as resolveConfiguredBindingRecord } from "./binding-registry-dyeOsusx.js";
//#region src/acp/persistent-bindings.resolve.ts
function resolveConfiguredAcpBindingRecord(params) {
	const resolved = resolveConfiguredBindingRecord(params);
	return resolved ? toResolvedConfiguredAcpBinding(resolved.record) : null;
}
function resolveConfiguredAcpBindingSpecBySessionKey(params) {
	const resolved = resolveConfiguredBindingRecordBySessionKey(params);
	return resolved ? resolveConfiguredAcpBindingSpecFromRecord(resolved.record) : null;
}
//#endregion
export { resolveConfiguredAcpBindingSpecBySessionKey as n, resolveConfiguredAcpBindingRecord as t };
