import { n as compareAuthChoiceGroups, t as buildAuthChoiceGroups } from "./auth-choice-options-DBrbPlbn.js";
//#region src/commands/auth-choice-prompt.ts
const BACK_VALUE = "__back";
const MORE_VALUE = "__more";
function isGroupFeatured(group) {
	return group.options.some((option) => option.onboardingFeatured);
}
function groupToOption(group) {
	return {
		value: group.value,
		label: group.label,
		hint: group.hint
	};
}
async function promptAuthChoiceGrouped(params) {
	const { groups, skipOption } = buildAuthChoiceGroups(params);
	const availableGroups = groups.filter((group) => group.options.length > 0);
	const groupById = new Map(availableGroups.map((group) => [group.value, group]));
	const featuredGroups = availableGroups.filter(isGroupFeatured).toSorted(compareAuthChoiceGroups);
	const moreGroups = [...availableGroups].toSorted(compareAuthChoiceGroups);
	const pickMethod = async (group) => {
		if (group.options.length === 1) return group.options[0].value;
		return await params.prompter.select({
			message: `${group.label} auth method`,
			options: [...group.options, {
				value: BACK_VALUE,
				label: "Back"
			}]
		});
	};
	const pickFromMore = async () => {
		while (true) {
			const options = moreGroups.map(groupToOption);
			options.push({
				value: BACK_VALUE,
				label: "Back"
			});
			const selection = await params.prompter.select({
				message: "Model/auth provider",
				options,
				searchable: true
			});
			if (selection === BACK_VALUE) return BACK_VALUE;
			const group = groupById.get(selection);
			if (!group) continue;
			const method = await pickMethod(group);
			if (method === BACK_VALUE) continue;
			return method;
		}
	};
	const runFlat = async () => {
		while (true) {
			const flatOptions = moreGroups.map(groupToOption);
			if (skipOption) flatOptions.push({
				value: skipOption.value,
				label: skipOption.label
			});
			const selection = await params.prompter.select({
				message: "Model/auth provider",
				options: flatOptions,
				searchable: true
			});
			if (selection === "skip") return "skip";
			const group = groupById.get(selection);
			if (!group || group.options.length === 0) {
				await params.prompter.note("No auth methods available for that provider.", "Model/auth choice");
				continue;
			}
			const method = await pickMethod(group);
			if (method === BACK_VALUE) continue;
			return method;
		}
	};
	if (featuredGroups.length === 0) return runFlat();
	while (true) {
		const topTier = featuredGroups.map(groupToOption);
		topTier.push({
			value: MORE_VALUE,
			label: "More…"
		});
		if (skipOption) topTier.push({
			value: skipOption.value,
			label: skipOption.label
		});
		const topSelection = await params.prompter.select({
			message: "Model/auth provider",
			options: topTier
		});
		if (topSelection === "skip") return "skip";
		if (topSelection === MORE_VALUE) {
			const more = await pickFromMore();
			if (more === BACK_VALUE) continue;
			return more;
		}
		const group = groupById.get(topSelection);
		if (!group || group.options.length === 0) {
			await params.prompter.note("No auth methods available for that provider.", "Model/auth choice");
			continue;
		}
		const method = await pickMethod(group);
		if (method === BACK_VALUE) continue;
		return method;
	}
}
//#endregion
export { promptAuthChoiceGrouped as t };
