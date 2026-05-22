//#region extensions/slack/src/resolve-allowlist-common.ts
function readSlackNextCursor(response) {
	const next = response.response_metadata?.next_cursor?.trim();
	return next ? next : void 0;
}
async function collectSlackCursorItems(params) {
	const items = [];
	let cursor;
	do {
		const response = await params.fetchPage(cursor);
		items.push(...params.collectPageItems(response));
		cursor = readSlackNextCursor(response);
	} while (cursor);
	return items;
}
function resolveSlackAllowlistEntries(params) {
	const results = [];
	for (const input of params.entries) {
		const parsed = params.parseInput(input);
		if (parsed.id) {
			const match = params.findById(params.lookup, parsed.id);
			results.push(params.buildIdResolved({
				input,
				parsed,
				match
			}));
			continue;
		}
		const resolved = params.resolveNonId({
			input,
			parsed,
			lookup: params.lookup
		});
		if (resolved) {
			results.push(resolved);
			continue;
		}
		results.push(params.buildUnresolved(input));
	}
	return results;
}
//#endregion
export { resolveSlackAllowlistEntries as n, collectSlackCursorItems as t };
