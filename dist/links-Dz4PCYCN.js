//#region src/terminal/terminal-link.ts
function formatTerminalLink(label, url, opts) {
	const esc = "\x1B";
	const safeLabel = label.replaceAll(esc, "");
	const safeUrl = url.replaceAll(esc, "");
	if (!(opts?.force === true ? true : opts?.force === false ? false : process.stdout.isTTY)) return opts?.fallback ?? `${safeLabel} (${safeUrl})`;
	return `\u001b]8;;${safeUrl}\u0007${safeLabel}\u001b]8;;\u0007`;
}
//#endregion
//#region src/terminal/links.ts
function resolveDocsRoot() {
	return "https://docs.openclaw.ai";
}
function formatDocsLink(path, label, opts) {
	const docsRoot = resolveDocsRoot();
	const trimmed = typeof path === "string" ? path.trim() : "";
	const url = trimmed ? trimmed.startsWith("http") ? trimmed : `${docsRoot}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}` : docsRoot;
	return formatTerminalLink(label ?? url, url, {
		fallback: opts?.fallback ?? url,
		force: opts?.force
	});
}
//#endregion
export { formatDocsLink as t };
