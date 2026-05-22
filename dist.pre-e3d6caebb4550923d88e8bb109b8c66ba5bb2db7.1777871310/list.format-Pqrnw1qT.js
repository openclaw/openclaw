import { n as isRich$1, r as theme } from "./theme-B128avno.js";
//#region src/commands/models/list.format.ts
const isRich = (opts) => isRich$1() && !opts?.json && !opts?.plain;
const pad = (value, size) => value.padEnd(size);
const formatTag = (tag, rich) => {
	if (!rich) return tag;
	if (tag === "default") return theme.success(tag);
	if (tag === "image") return theme.accentBright(tag);
	if (tag === "configured") return theme.accent(tag);
	if (tag === "missing") return theme.error(tag);
	if (tag.startsWith("fallback#")) return theme.warn(tag);
	if (tag.startsWith("img-fallback#")) return theme.warn(tag);
	if (tag.startsWith("alias:")) return theme.accentDim(tag);
	return theme.muted(tag);
};
const truncate = (value, max) => {
	if (value.length <= max) return value;
	if (max <= 3) return value.slice(0, max);
	return `${value.slice(0, max - 3)}...`;
};
//#endregion
export { truncate as i, isRich as n, pad as r, formatTag as t };
