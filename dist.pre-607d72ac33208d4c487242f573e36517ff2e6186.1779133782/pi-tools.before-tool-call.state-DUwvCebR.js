//#region src/agents/pi-tools.before-tool-call.state.ts
const adjustedParamsByToolCallId = /* @__PURE__ */ new Map();
function resetAdjustedParamsByToolCallIdForTests() {
	adjustedParamsByToolCallId.clear();
}
//#endregion
export { resetAdjustedParamsByToolCallIdForTests as n, adjustedParamsByToolCallId as t };
