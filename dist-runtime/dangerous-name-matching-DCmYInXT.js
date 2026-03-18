//#region src/config/dangerous-name-matching.ts
function isDangerousNameMatchingEnabled(config) {
	return config?.dangerouslyAllowNameMatching === true;
}
//#endregion
export { isDangerousNameMatchingEnabled as t };
