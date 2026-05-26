//#region src/plugin-sdk/memory-host-markdown.ts
function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isLineWhitespace(value) {
	return /^[\t \r\n]*$/.test(value);
}
function withTrailingNewline(content) {
	return content.endsWith("\n") ? content : `${content}\n`;
}
function replaceManagedMarkdownBlock(params) {
	const managedBlock = `${params.heading ? `${params.heading}\n` : ""}${params.startMarker}\n${params.body}\n${params.endMarker}`;
	const headingPattern = params.heading ? `${escapeRegex(params.heading)}(?:[ \t]*(?:\r\n|\n|\r))+[ \t]*` : "";
	const existingPattern = new RegExp(`${headingPattern}${escapeRegex(params.startMarker)}[\\s\\S]*?${escapeRegex(params.endMarker)}`, "g");
	const matches = Array.from(params.original.matchAll(existingPattern));
	if (matches.length > 0) {
		let updated = "";
		let lastEnd = 0;
		matches.forEach((match, index) => {
			const matchStart = match.index ?? 0;
			const matchEnd = matchStart + match[0].length;
			const betweenMatches = params.original.slice(lastEnd, matchStart);
			if (index === 0) {
				updated += params.original.slice(0, matchStart);
				updated += managedBlock;
			} else if (!isLineWhitespace(betweenMatches)) updated += betweenMatches;
			lastEnd = matchEnd;
		});
		return updated + params.original.slice(lastEnd);
	}
	const trimmed = params.original.trimEnd();
	if (trimmed.length === 0) return `${managedBlock}\n`;
	return `${trimmed}\n\n${managedBlock}\n`;
}
//#endregion
export { withTrailingNewline as n, replaceManagedMarkdownBlock as t };
