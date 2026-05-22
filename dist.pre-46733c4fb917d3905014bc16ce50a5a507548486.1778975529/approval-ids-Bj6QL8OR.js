import { n as normalizeMatrixUserId } from "./allowlist-D4tMTIu9.js";
//#region extensions/matrix/src/approval-ids.ts
function normalizeMatrixApproverId(value) {
	return normalizeMatrixUserId(String(value)) || void 0;
}
//#endregion
export { normalizeMatrixApproverId as t };
