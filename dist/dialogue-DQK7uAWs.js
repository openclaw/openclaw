import { a as parseCrestodianOperation, t as describeCrestodianPersistentOperation } from "./operations-Bw7QWTg3.js";
import { r as loadCrestodianOverview } from "./overview-Be1048jt.js";
//#region src/crestodian/dialogue.ts
function approvalQuestion(operation) {
	return `Apply this operation: ${describeCrestodianPersistentOperation(operation)}?`;
}
function isYes(input) {
	return /^(y|yes|apply|do it|approved?)$/i.test(input.trim());
}
async function resolveCrestodianOperation(input, runtime, opts) {
	const operation = parseCrestodianOperation(input);
	if (!shouldAskAssistant(input, operation)) return operation;
	const overview = await (opts.loadOverview ?? loadCrestodianOverview)();
	const plan = await (opts.planWithAssistant ?? (await import("./assistant-C2mKfd_f.js")).planCrestodianCommand)({
		input,
		overview
	});
	if (!plan) return operation;
	const planned = parseCrestodianOperation(plan.command);
	if (planned.kind === "none") return operation;
	logAssistantPlan(runtime, plan, overview);
	return planned;
}
function shouldAskAssistant(input, operation) {
	if (operation.kind !== "none") return false;
	const trimmed = input.trim().toLowerCase();
	if (!trimmed || trimmed === "quit" || trimmed === "exit") return false;
	return true;
}
function logAssistantPlan(runtime, plan, overview) {
	const modelLabel = plan.modelLabel ?? overview.defaultModel ?? "configured model";
	runtime.log(`[crestodian] planner: ${modelLabel}`);
	if (plan.reply) runtime.log(plan.reply);
	runtime.log(`[crestodian] interpreted: ${plan.command}`);
}
//#endregion
export { isYes as n, resolveCrestodianOperation as r, approvalQuestion as t };
