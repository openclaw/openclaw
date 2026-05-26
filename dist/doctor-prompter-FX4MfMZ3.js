import { n as stylePromptMessage, t as stylePromptHint } from "./prompt-style-DH7LpiPN.js";
import { a as guardCancel } from "./onboard-helpers-BaLdeEkj.js";
import { n as resolveDoctorRepairMode, r as shouldAutoApproveDoctorFix } from "./doctor-repair-mode-BP5nXXgX.js";
import { confirm, select } from "@clack/prompts";
//#region src/commands/doctor-prompter.ts
function createDoctorPrompter(params) {
	const repairMode = resolveDoctorRepairMode(params.options);
	const confirmDefault = async (p) => {
		if (shouldAutoApproveDoctorFix(repairMode)) return true;
		if (repairMode.nonInteractive) return false;
		if (!repairMode.canPrompt) return p.initialValue ?? false;
		return guardCancel(await confirm({
			...p,
			message: stylePromptMessage(p.message)
		}), params.runtime);
	};
	return {
		confirm: confirmDefault,
		confirmAutoFix: confirmDefault,
		confirmAggressiveAutoFix: async (p) => {
			if (shouldAutoApproveDoctorFix(repairMode, { requiresForce: true })) return true;
			if (repairMode.nonInteractive) return false;
			if (repairMode.shouldRepair && !repairMode.shouldForce) return false;
			if (!repairMode.canPrompt) return p.initialValue ?? false;
			return guardCancel(await confirm({
				...p,
				message: stylePromptMessage(p.message)
			}), params.runtime);
		},
		confirmRuntimeRepair: async (p) => {
			const { requiresInteractiveConfirmation, ...confirmParams } = p;
			if (requiresInteractiveConfirmation !== true && shouldAutoApproveDoctorFix(repairMode, { blockDuringUpdate: true })) return true;
			if (requiresInteractiveConfirmation === true && !repairMode.canPrompt) return false;
			if (repairMode.nonInteractive) return false;
			if (!repairMode.canPrompt) return confirmParams.initialValue ?? false;
			return guardCancel(await confirm({
				...confirmParams,
				message: stylePromptMessage(confirmParams.message)
			}), params.runtime);
		},
		select: async (p, fallback) => {
			if (!repairMode.canPrompt || repairMode.shouldRepair) return fallback;
			return guardCancel(await select({
				...p,
				message: stylePromptMessage(p.message),
				options: p.options.map((opt) => opt.hint === void 0 ? opt : {
					...opt,
					hint: stylePromptHint(opt.hint)
				})
			}), params.runtime);
		},
		shouldRepair: repairMode.shouldRepair,
		shouldForce: repairMode.shouldForce,
		repairMode
	};
}
//#endregion
export { createDoctorPrompter };
