import { Dt as isRich, Ot as theme } from "./entry.js";

//#region src/terminal/prompt-style.ts
const stylePromptMessage = (message) => isRich() ? theme.accent(message) : message;
const stylePromptTitle = (title) => title && isRich() ? theme.heading(title) : title;
const stylePromptHint = (hint) => hint && isRich() ? theme.muted(hint) : hint;

//#endregion
export { stylePromptMessage as n, stylePromptTitle as r, stylePromptHint as t };