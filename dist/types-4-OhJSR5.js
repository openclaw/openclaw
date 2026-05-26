//#region src/flows/types.ts
function sortFlowContributionsByLabel(contributions) {
	return [...contributions].toSorted((left, right) => left.option.label.localeCompare(right.option.label) || left.option.value.localeCompare(right.option.value));
}
//#endregion
export { sortFlowContributionsByLabel as t };
