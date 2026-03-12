import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { t as buildAuthChoiceGroups } from "./auth-choice-options-Ts0OLtZJ.js";

//#region src/commands/auth-choice-prompt.ts
var auth_choice_prompt_exports = /* @__PURE__ */ __exportAll({ promptAuthChoiceGrouped: () => promptAuthChoiceGrouped });
const BACK_VALUE = "__back";
async function promptAuthChoiceGrouped(params) {
	const { groups, skipOption } = buildAuthChoiceGroups(params);
	const availableGroups = groups.filter((group) => group.options.length > 0);
	while (true) {
		const providerOptions = [...availableGroups.map((group) => ({
			value: group.value,
			label: group.label,
			hint: group.hint
		})), ...skipOption ? [skipOption] : []];
		const providerSelection = await params.prompter.select({
			message: "Model/auth provider",
			options: providerOptions
		});
		if (providerSelection === "skip") return "skip";
		const group = availableGroups.find((candidate) => candidate.value === providerSelection);
		if (!group || group.options.length === 0) {
			await params.prompter.note("No auth methods available for that provider.", "Model/auth choice");
			continue;
		}
		if (group.options.length === 1) return group.options[0].value;
		const methodSelection = await params.prompter.select({
			message: `${group.label} auth method`,
			options: [...group.options, {
				value: BACK_VALUE,
				label: "Back"
			}]
		});
		if (methodSelection === BACK_VALUE) continue;
		return methodSelection;
	}
}

//#endregion
export { promptAuthChoiceGrouped as n, auth_choice_prompt_exports as t };