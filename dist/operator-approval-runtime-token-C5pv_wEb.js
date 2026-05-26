import { randomBytes, timingSafeEqual } from "node:crypto";
//#region src/gateway/operator-approval-runtime-token.ts
let approvalRuntimeToken = null;
function getOperatorApprovalRuntimeToken() {
	approvalRuntimeToken ??= randomBytes(32).toString("base64url");
	return approvalRuntimeToken;
}
function isOperatorApprovalRuntimeToken(value) {
	const token = value?.trim();
	if (!token) return false;
	const expected = getOperatorApprovalRuntimeToken();
	const tokenBytes = Buffer.from(token);
	const expectedBytes = Buffer.from(expected);
	return tokenBytes.length === expectedBytes.length && timingSafeEqual(tokenBytes, expectedBytes);
}
//#endregion
export { isOperatorApprovalRuntimeToken as n, getOperatorApprovalRuntimeToken as t };
