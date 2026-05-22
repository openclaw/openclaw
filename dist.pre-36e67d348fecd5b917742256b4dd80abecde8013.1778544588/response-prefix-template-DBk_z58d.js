import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/auto-reply/reply/response-prefix-template.ts
const TEMPLATE_VAR_PATTERN = /\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;
/**
* Interpolate template variables in a response prefix string.
*
* @param template - The template string with `{variable}` placeholders
* @param context - Context object with values for interpolation
* @returns The interpolated string, or undefined if template is undefined
*
* @example
* resolveResponsePrefixTemplate("[{model} | think:{thinkingLevel}]", {
*   model: "gpt-5.4",
*   thinkingLevel: "high"
* })
* // Returns: "[gpt-5.4 | think:high]"
*/
function resolveResponsePrefixTemplate(template, context) {
	if (!template) return;
	return template.replace(TEMPLATE_VAR_PATTERN, (match, varName) => {
		switch (normalizeLowercaseStringOrEmpty(varName)) {
			case "model": return context.model ?? match;
			case "modelfull": return context.modelFull ?? match;
			case "provider": return context.provider ?? match;
			case "thinkinglevel":
			case "think": return context.thinkingLevel ?? match;
			case "identity.name":
			case "identityname": return context.identityName ?? match;
			default: return match;
		}
	});
}
/**
* Extract short model name from a full model string.
*
* Strips:
* - Provider prefix (e.g., "openai/" from "openai/gpt-5.4")
* - Date suffixes (e.g., "-20260205" from "claude-opus-4-6-20260205")
* - Common version suffixes (e.g., "-latest")
*
* @example
* extractShortModelName("openai/gpt-5.5") // "gpt-5.5"
* extractShortModelName("claude-opus-4-6-20260205") // "claude-opus-4-6"
* extractShortModelName("gpt-5.4-latest") // "gpt-5.4"
*/
function extractShortModelName(fullModel) {
	const slash = fullModel.lastIndexOf("/");
	return (slash >= 0 ? fullModel.slice(slash + 1) : fullModel).replace(/-\d{8}$/, "").replace(/-latest$/, "");
}
//#endregion
export { resolveResponsePrefixTemplate as n, extractShortModelName as t };
