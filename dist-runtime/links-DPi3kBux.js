import { d as init_utils, u as formatTerminalLink } from "./utils-BiUV1eIQ.js";
//#region src/terminal/links.ts
init_utils();
const DOCS_ROOT = "https://docs.openclaw.ai";
function formatDocsLink(path, label, opts) {
	const trimmed = path.trim();
	const url = trimmed.startsWith("http") ? trimmed : `${DOCS_ROOT}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
	return formatTerminalLink(label ?? url, url, {
		fallback: opts?.fallback ?? url,
		force: opts?.force
	});
}
//#endregion
export { formatDocsLink as t };
