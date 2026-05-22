import { a as asRecord } from "./record-coerce-aMlBWINm.js";
//#region src/shared/node-list-parse.ts
function parsePairingList(value) {
	const obj = asRecord(value);
	return {
		pending: Array.isArray(obj.pending) ? obj.pending : [],
		paired: Array.isArray(obj.paired) ? obj.paired : []
	};
}
function parseNodeList(value) {
	const obj = asRecord(value);
	return Array.isArray(obj.nodes) ? obj.nodes : [];
}
//#endregion
export { parsePairingList as n, parseNodeList as t };
