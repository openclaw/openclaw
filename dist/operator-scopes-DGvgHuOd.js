//#region src/gateway/operator-scopes.ts
const ADMIN_SCOPE = "operator.admin";
const READ_SCOPE = "operator.read";
const WRITE_SCOPE = "operator.write";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";
const TALK_SECRETS_SCOPE = "operator.talk.secrets";
const KNOWN_OPERATOR_SCOPES = new Set([
	ADMIN_SCOPE,
	READ_SCOPE,
	WRITE_SCOPE,
	APPROVALS_SCOPE,
	PAIRING_SCOPE,
	TALK_SECRETS_SCOPE
]);
function isOperatorScope(value) {
	return typeof value === "string" && KNOWN_OPERATOR_SCOPES.has(value);
}
//#endregion
export { TALK_SECRETS_SCOPE as a, READ_SCOPE as i, APPROVALS_SCOPE as n, WRITE_SCOPE as o, PAIRING_SCOPE as r, isOperatorScope as s, ADMIN_SCOPE as t };
