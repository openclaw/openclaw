//#region src/utils/normalize-secret-input.ts
/**
* Secret normalization for copy/pasted credentials.
*
* Common footgun: line breaks (especially `\r`) embedded in API keys/tokens.
* We strip line breaks anywhere, then trim whitespace at the ends.
*
* Another frequent source of runtime failures is rich-text/Unicode artifacts
* (smart punctuation, box-drawing chars, etc.) pasted into API keys. These can
* break HTTP header construction (`ByteString` violations). Drop non-Latin1
* code points so malformed keys fail as auth errors instead of crashing request
* setup.
*
* Intentionally does NOT remove ordinary spaces inside the string to avoid
* silently altering "Bearer <token>" style values.
*/
function normalizeSecretInput(value) {
	if (typeof value !== "string") return "";
	const collapsed = value.replace(/[\r\n\u2028\u2029]+/g, "");
	let latin1Only = "";
	for (const char of collapsed) {
		const codePoint = char.codePointAt(0);
		if (typeof codePoint === "number" && codePoint <= 255) latin1Only += char;
	}
	return latin1Only.trim();
}
function normalizeOptionalSecretInput(value) {
	const normalized = normalizeSecretInput(value);
	return normalized ? normalized : void 0;
}
//#endregion
export { normalizeSecretInput as n, normalizeOptionalSecretInput as t };
