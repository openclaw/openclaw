//#region src/sessions/input-provenance.ts
const INPUT_PROVENANCE_KIND_VALUES = [
	"external_user",
	"inter_session",
	"internal_system"
];
function normalizeOptionalString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function isInputProvenanceKind(value) {
	return typeof value === "string" && INPUT_PROVENANCE_KIND_VALUES.includes(value);
}
function normalizeInputProvenance(value) {
	if (!value || typeof value !== "object") return;
	const record = value;
	if (!isInputProvenanceKind(record.kind)) return;
	return {
		kind: record.kind,
		sourceSessionKey: normalizeOptionalString(record.sourceSessionKey),
		sourceChannel: normalizeOptionalString(record.sourceChannel),
		sourceTool: normalizeOptionalString(record.sourceTool)
	};
}
function applyInputProvenanceToUserMessage(message, inputProvenance) {
	if (!inputProvenance) return message;
	if (message.role !== "user") return message;
	if (normalizeInputProvenance(message.provenance)) return message;
	return {
		...message,
		provenance: inputProvenance
	};
}
function isInterSessionInputProvenance(value) {
	return normalizeInputProvenance(value)?.kind === "inter_session";
}
function hasInterSessionUserProvenance(message) {
	if (!message || message.role !== "user") return false;
	return isInterSessionInputProvenance(message.provenance);
}

//#endregion
export { normalizeInputProvenance as i, applyInputProvenanceToUserMessage as n, hasInterSessionUserProvenance as r, INPUT_PROVENANCE_KIND_VALUES as t };