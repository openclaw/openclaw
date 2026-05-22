import { n as normalizeMatrixUserId } from "./allowlist-BwAIjoym.js";
//#region extensions/matrix/src/approval-ids.ts
function normalizeMatrixApproverId(value) {
	return normalizeMatrixUserId(String(value)) || void 0;
}
//#endregion
export { normalizeMatrixApproverId as t };
