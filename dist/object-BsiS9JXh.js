//#region src/commands/doctor/shared/object.ts
function asObjectRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
//#endregion
export { asObjectRecord as t };
