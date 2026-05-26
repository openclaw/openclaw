//#region src/hooks/bundled/compaction-notifier/handler.ts
function readOptionalNumber(context, key) {
	const value = context[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
const handler = async (event) => {
	try {
		const context = event.context;
		if (event.type === "session" && event.action === "compact:before") {
			const messageCount = readOptionalNumber(context, "messageCount");
			const messageSuffix = messageCount !== void 0 && messageCount >= 0 ? ` (${messageCount} messages)` : "";
			event.messages.push(`🧹 Compacting context${messageSuffix} so I can continue without losing history…`);
			return;
		}
		if (event.type === "session" && event.action === "compact:after") {
			const tokensBefore = readOptionalNumber(context, "tokensBefore");
			const tokensAfter = readOptionalNumber(context, "tokensAfter");
			const tokenDelta = tokensBefore !== void 0 && tokensAfter !== void 0 ? ` (${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens)` : "";
			event.messages.push(`✅ Context compacted${tokenDelta}. Continuing from where I left off.`);
		}
	} catch (error) {
		console.warn(`[compaction-notifier] failed: ${error instanceof Error ? error.message : String(error)}`);
	}
};
//#endregion
export { handler as default };
