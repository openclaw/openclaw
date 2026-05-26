import { Buffer } from "node:buffer";
//#region src/gateway/server/close-reason.ts
const CLOSE_REASON_MAX_BYTES = 120;
function truncateCloseReason(reason, maxBytes = CLOSE_REASON_MAX_BYTES) {
	if (!reason) return "invalid handshake";
	const buf = Buffer.from(reason);
	if (buf.length <= maxBytes) return reason;
	return buf.subarray(0, maxBytes).toString();
}
//#endregion
export { truncateCloseReason as t };
