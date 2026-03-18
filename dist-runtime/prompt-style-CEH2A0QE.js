import { i as theme, n as init_theme, r as isRich } from "./theme-CL08MjAq.js";
//#region src/terminal/prompt-style.ts
init_theme();
const stylePromptMessage = (message) => isRich() ? theme.accent(message) : message;
const stylePromptTitle = (title) => title && isRich() ? theme.heading(title) : title;
const stylePromptHint = (hint) => hint && isRich() ? theme.muted(hint) : hint;
//#endregion
export { stylePromptMessage as n, stylePromptTitle as r, stylePromptHint as t };
