//#region src/polls.ts
function normalizePollInput(input, options = {}) {
	const question = input.question.trim();
	if (!question) throw new Error("Poll question is required");
	const cleaned = (input.options ?? []).map((option) => option.trim()).filter(Boolean);
	if (cleaned.length < 2) throw new Error("Poll requires at least 2 options");
	if (options.maxOptions !== void 0 && cleaned.length > options.maxOptions) throw new Error(`Poll supports at most ${options.maxOptions} options`);
	const maxSelectionsRaw = input.maxSelections;
	const maxSelections = typeof maxSelectionsRaw === "number" && Number.isFinite(maxSelectionsRaw) ? Math.floor(maxSelectionsRaw) : 1;
	if (maxSelections < 1) throw new Error("maxSelections must be at least 1");
	if (maxSelections > cleaned.length) throw new Error("maxSelections cannot exceed option count");
	const durationSecondsRaw = input.durationSeconds;
	const durationSeconds = typeof durationSecondsRaw === "number" && Number.isFinite(durationSecondsRaw) ? Math.floor(durationSecondsRaw) : void 0;
	if (durationSeconds !== void 0 && durationSeconds < 1) throw new Error("durationSeconds must be at least 1");
	const durationRaw = input.durationHours;
	const durationHours = typeof durationRaw === "number" && Number.isFinite(durationRaw) ? Math.floor(durationRaw) : void 0;
	if (durationHours !== void 0 && durationHours < 1) throw new Error("durationHours must be at least 1");
	if (durationSeconds !== void 0 && durationHours !== void 0) throw new Error("durationSeconds and durationHours are mutually exclusive");
	return {
		question,
		options: cleaned,
		maxSelections,
		durationSeconds,
		durationHours
	};
}
function normalizePollDurationHours(value, options) {
	const base = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : options.defaultHours;
	return Math.min(Math.max(base, 1), options.maxHours);
}

//#endregion
export { normalizePollInput as n, normalizePollDurationHours as t };