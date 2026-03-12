//#region src/commands/text-format.ts
const shortenText = (value, maxLen) => {
	const chars = Array.from(value);
	if (chars.length <= maxLen) return value;
	return `${chars.slice(0, Math.max(0, maxLen - 1)).join("")}…`;
};

//#endregion
export { shortenText as t };