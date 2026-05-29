import { t as normalizeOptionalString } from "./string-D-gmGOgs.mjs";
//#region src/model-ref.ts
function parseGenerationModelRef(raw) {
	const trimmed = normalizeOptionalString(raw);
	if (!trimmed) return null;
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null;
	const provider = normalizeOptionalString(trimmed.slice(0, slashIndex));
	const model = normalizeOptionalString(trimmed.slice(slashIndex + 1));
	return provider && model ? {
		provider,
		model
	} : null;
}
//#endregion
export { parseGenerationModelRef };
