//#region src/media/base64.ts
function estimateBase64DecodedBytes(base64) {
	let effectiveLen = 0;
	for (let i = 0; i < base64.length; i += 1) {
		if (base64.charCodeAt(i) <= 32) continue;
		effectiveLen += 1;
	}
	if (effectiveLen === 0) return 0;
	let padding = 0;
	let end = base64.length - 1;
	while (end >= 0 && base64.charCodeAt(end) <= 32) end -= 1;
	if (end >= 0 && base64[end] === "=") {
		padding = 1;
		end -= 1;
		while (end >= 0 && base64.charCodeAt(end) <= 32) end -= 1;
		if (end >= 0 && base64[end] === "=") padding = 2;
	}
	const estimated = Math.floor(effectiveLen * 3 / 4) - padding;
	return Math.max(0, estimated);
}
function isBase64DataChar(code) {
	return code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47;
}
/**
* Normalize and validate a base64 string.
* Returns canonical base64 (no whitespace) or undefined when invalid.
*/
function canonicalizeBase64(base64) {
	let cleaned = "";
	let padding = 0;
	let sawPadding = false;
	for (let i = 0; i < base64.length; i += 1) {
		const code = base64.charCodeAt(i);
		if (code <= 32) continue;
		if (code === 61) {
			padding += 1;
			if (padding > 2) return;
			sawPadding = true;
			cleaned += "=";
			continue;
		}
		if (sawPadding || !isBase64DataChar(code)) return;
		cleaned += base64[i];
	}
	if (!cleaned || cleaned.length % 4 !== 0) return;
	return cleaned;
}
//#endregion
export { estimateBase64DecodedBytes as n, canonicalizeBase64 as t };
