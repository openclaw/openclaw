import { n as stylePromptMessage, t as stylePromptHint } from "./prompt-style-DH7LpiPN.js";
import { select } from "@clack/prompts";
//#region src/terminal/prompt-select-styled-params.ts
const defaultStylers = {
	message: stylePromptMessage,
	hint: stylePromptHint
};
function styleSelectParams(params, stylers = defaultStylers) {
	return {
		...params,
		message: stylers.message(params.message),
		options: params.options.map((opt) => {
			const hint = "hint" in opt && typeof opt.hint === "string" ? opt.hint : void 0;
			return hint === void 0 ? opt : {
				...opt,
				hint: stylers.hint(hint)
			};
		})
	};
}
//#endregion
//#region src/terminal/prompt-select-styled.ts
function selectStyled(params) {
	return select(styleSelectParams(params));
}
//#endregion
export { selectStyled as t };
