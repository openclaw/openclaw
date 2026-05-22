//#region src/daemon/arg-split.ts
function splitArgsPreservingQuotes(value, options) {
	const args = [];
	let current = "";
	let quoteChar = null;
	const escapeMode = options?.escapeMode ?? "none";
	const quoteChars = new Set(options?.quoteChars ?? ["\""]);
	const quoteStart = options?.quoteStart ?? "anywhere";
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (escapeMode === "backslash" && char === "\\") {
			if (i + 1 < value.length) {
				current += value[i + 1];
				i++;
			}
			continue;
		}
		if (escapeMode === "backslash-quote-only" && char === "\\" && i + 1 < value.length && value[i + 1] === "\"") {
			current += "\"";
			i++;
			continue;
		}
		if (quoteChars.has(char)) {
			if (quoteChar === char) {
				quoteChar = null;
				continue;
			}
			const canOpenQuote = quoteStart === "anywhere" || current.length === 0;
			if (!quoteChar && canOpenQuote) {
				quoteChar = char;
				continue;
			}
		}
		if (!quoteChar && /\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) args.push(current);
	return args;
}
//#endregion
export { splitArgsPreservingQuotes as t };
