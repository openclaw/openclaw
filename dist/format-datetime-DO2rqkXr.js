//#region src/infra/format-time/format-datetime.ts
/**
* Centralized date/time formatting utilities.
*
* All formatters are timezone-aware, using Intl.DateTimeFormat.
* Consolidates duplicated formatUtcTimestamp / formatZonedTimestamp / resolveExplicitTimezone
* that previously lived in envelope.ts and session-updates.ts.
*/
/**
* Validate an IANA timezone string. Returns the string if valid, undefined otherwise.
*/
function resolveTimezone(value) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(/* @__PURE__ */ new Date());
		return value;
	} catch {
		return;
	}
}
/**
* Format a Date as a UTC timestamp string.
*
* Without seconds: `2024-01-15T14:30Z`
* With seconds:    `2024-01-15T14:30:05Z`
*/
function formatUtcTimestamp(date, options) {
	const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	const hh = String(date.getUTCHours()).padStart(2, "0");
	const min = String(date.getUTCMinutes()).padStart(2, "0");
	if (!options?.displaySeconds) return `${yyyy}-${mm}-${dd}T${hh}:${min}Z`;
	return `${yyyy}-${mm}-${dd}T${hh}:${min}:${String(date.getUTCSeconds()).padStart(2, "0")}Z`;
}
/**
* Format a Date with timezone display using Intl.DateTimeFormat.
*
* Without seconds: `2024-01-15 14:30 EST`
* With seconds:    `2024-01-15 14:30:05 EST`
*
* Returns undefined if Intl formatting fails.
*/
function formatZonedTimestamp(date, options) {
	try {
		const intlOptions = {
			timeZone: options?.timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			timeZoneName: "short"
		};
		if (options?.displaySeconds) intlOptions.second = "2-digit";
		const parts = new Intl.DateTimeFormat("en-US", intlOptions).formatToParts(date);
		const pick = (type) => parts.find((part) => part.type === type)?.value;
		const yyyy = pick("year");
		const mm = pick("month");
		const dd = pick("day");
		const hh = pick("hour");
		const min = pick("minute");
		const sec = options?.displaySeconds ? pick("second") : void 0;
		const tz = [...parts].toReversed().find((part) => part.type === "timeZoneName")?.value?.trim();
		if (!yyyy || !mm || !dd || !hh || !min) return;
		if (options?.displaySeconds && sec) return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}${tz ? ` ${tz}` : ""}`;
		return `${yyyy}-${mm}-${dd} ${hh}:${min}${tz ? ` ${tz}` : ""}`;
	} catch {
		return;
	}
}
//#endregion
export { formatZonedTimestamp as n, resolveTimezone as r, formatUtcTimestamp as t };
