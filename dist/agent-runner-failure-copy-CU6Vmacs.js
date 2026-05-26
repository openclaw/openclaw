//#region src/auto-reply/reply/agent-runner-failure-copy.ts
const GENERIC_EXTERNAL_RUN_FAILURE_TEXT = "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";
const HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT = "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available.";
function isGenericExternalRunFailureText(text) {
	return text?.trim() === GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
}
function replaceGenericExternalRunFailureText(text) {
	if (isGenericExternalRunFailureText(text)) return {
		text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
		replaced: true
	};
	const genericStart = text.indexOf(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
	if (genericStart < 0) return {
		text,
		replaced: false
	};
	if (text.slice(genericStart + 110).trim()) return {
		text,
		replaced: false
	};
	const prefix = text.slice(0, genericStart).trimEnd();
	return {
		text: prefix ? `${prefix} ${HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT}` : HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
		replaced: true
	};
}
//#endregion
export { HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT as n, replaceGenericExternalRunFailureText as r, GENERIC_EXTERNAL_RUN_FAILURE_TEXT as t };
