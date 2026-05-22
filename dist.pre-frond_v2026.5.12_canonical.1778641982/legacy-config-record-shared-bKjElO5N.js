import { c as isRecord } from "./utils-D5swhEXt.js";
//#region src/commands/doctor/shared/legacy-config-record-shared.ts
function cloneRecord(value) {
	return { ...value };
}
function ensureRecord(target, key) {
	const current = target[key];
	if (isRecord(current)) return current;
	const next = {};
	target[key] = next;
	return next;
}
function hasOwnKey(target, key) {
	return Object.prototype.hasOwnProperty.call(target, key);
}
//#endregion
export { ensureRecord as n, hasOwnKey as r, cloneRecord as t };
