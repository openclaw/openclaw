//#region src/normalization.ts
function hasMediaNormalizationEntry(entry) {
	return Boolean(entry && (entry.requested !== void 0 || entry.applied !== void 0 || entry.derivedFrom !== void 0 || (entry.supportedValues?.length ?? 0) > 0));
}
//#endregion
export { hasMediaNormalizationEntry };
