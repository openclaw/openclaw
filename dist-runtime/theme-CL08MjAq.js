import { n as __esmMin } from "./chunk-DORXReHP.js";
import chalk, { Chalk } from "chalk";
//#region src/terminal/palette.ts
var LOBSTER_PALETTE;
var init_palette = __esmMin((() => {
	LOBSTER_PALETTE = {
		accent: "#FF5A2D",
		accentBright: "#FF7A3D",
		accentDim: "#D14A22",
		info: "#FF8A5B",
		success: "#2FBF71",
		warn: "#FFB020",
		error: "#E23D2D",
		muted: "#8B7F77"
	};
}));
//#endregion
//#region src/terminal/theme.ts
var hasForceColor, baseChalk, hex, theme, isRich, colorize;
var init_theme = __esmMin((() => {
	init_palette();
	hasForceColor = typeof process.env.FORCE_COLOR === "string" && process.env.FORCE_COLOR.trim().length > 0 && process.env.FORCE_COLOR.trim() !== "0";
	baseChalk = process.env.NO_COLOR && !hasForceColor ? new Chalk({ level: 0 }) : chalk;
	hex = (value) => baseChalk.hex(value);
	theme = {
		accent: hex(LOBSTER_PALETTE.accent),
		accentBright: hex(LOBSTER_PALETTE.accentBright),
		accentDim: hex(LOBSTER_PALETTE.accentDim),
		info: hex(LOBSTER_PALETTE.info),
		success: hex(LOBSTER_PALETTE.success),
		warn: hex(LOBSTER_PALETTE.warn),
		error: hex(LOBSTER_PALETTE.error),
		muted: hex(LOBSTER_PALETTE.muted),
		heading: baseChalk.bold.hex(LOBSTER_PALETTE.accent),
		command: hex(LOBSTER_PALETTE.accentBright),
		option: hex(LOBSTER_PALETTE.warn)
	};
	isRich = () => Boolean(baseChalk.level > 0);
	colorize = (rich, color, value) => rich ? color(value) : value;
}));
//#endregion
export { theme as i, init_theme as n, isRich as r, colorize as t };
