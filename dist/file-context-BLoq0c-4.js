import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { D as sanitizeUntrustedFileName } from "./fs-safe-DpJlqO1z.js";
import "./fs-safe-advanced-BQymc1Ql.js";
//#region src/media/file-context.ts
const XML_ESCAPE_MAP = {
	"<": "&lt;",
	">": "&gt;",
	"&": "&amp;",
	"\"": "&quot;",
	"'": "&apos;"
};
function xmlEscapeAttr(value) {
	return value.replace(/[<>&"']/g, (char) => XML_ESCAPE_MAP[char] ?? char);
}
function escapeFileBlockContent(value) {
	return value.replace(/<\s*\/\s*file\s*>/gi, "&lt;/file&gt;").replace(/<\s*file\b/gi, "&lt;file");
}
function sanitizeFileName(value, fallbackName) {
	return sanitizeUntrustedFileName(normalizeOptionalString(typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ") : void 0) ?? "", fallbackName);
}
function renderFileContextBlock(params) {
	const fallbackName = normalizeOptionalString(params.fallbackName) ?? "attachment";
	const safeName = sanitizeFileName(params.filename, fallbackName);
	const safeContent = escapeFileBlockContent(params.content);
	const mimeType = normalizeOptionalString(params.mimeType);
	const attrs = [`name="${xmlEscapeAttr(safeName)}"`, mimeType ? `mime="${xmlEscapeAttr(mimeType)}"` : void 0].filter(Boolean).join(" ");
	if (params.surroundContentWithNewlines === false) return `<file ${attrs}>${safeContent}</file>`;
	return `<file ${attrs}>\n${safeContent}\n</file>`;
}
//#endregion
export { renderFileContextBlock as t };
