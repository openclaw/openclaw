import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
const FILE_REF_EXTENSIONS_WITH_TLD = new Set([
	"md",
	"go",
	"py",
	"pl",
	"sh",
	"am",
	"at",
	"be",
	"cc"
]);
function isAutoLinkedFileRef(href, label) {
	if (href.replace(/^https?:\/\//i, "") !== label) return false;
	const dotIndex = label.lastIndexOf(".");
	if (dotIndex < 1) return false;
	const ext = normalizeLowercaseStringOrEmpty(label.slice(dotIndex + 1));
	if (!FILE_REF_EXTENSIONS_WITH_TLD.has(ext)) return false;
	const segments = label.split("/");
	if (segments.length > 1) {
		for (let i = 0; i < segments.length - 1; i += 1) if (segments[i]?.includes(".")) return false;
	}
	return true;
}
//#endregion
export { isAutoLinkedFileRef as n, FILE_REF_EXTENSIONS_WITH_TLD as t };
