import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { u as prepareScopedSetupConfig } from "./setup-helpers-BC9z9VvG.js";
import "./setup-DPvocg6M.js";
import { a as resolveMatrixAccountConfig } from "./account-config-C6EZ3oG4.js";
import { r as resolveDefaultMatrixAccountId } from "./accounts-CAjG_HwT.js";
import { i as validateMatrixSetupInput, n as applyMatrixSetupAccountConfig, t as resolveMatrixSetupDmAllowFrom } from "./setup-dm-policy-WanD6L9B.js";
import { t as resolveMatrixConfigFieldPath } from "./config-paths-DExRbAi8.js";
import { n as updateMatrixAccountConfig } from "./config-update-yy_QFIrd.js";
//#region extensions/matrix/src/setup-core.ts
const channel = "matrix";
function resolveMatrixSetupAccountId(params) {
	return normalizeAccountId(params.accountId?.trim() || params.name?.trim() || "default");
}
function resolveMatrixSetupWizardAccountId(cfg, accountId) {
	return normalizeAccountId(accountId?.trim() || resolveDefaultMatrixAccountId(cfg) || "default");
}
function setMatrixDmPolicy(cfg, policy, accountId) {
	const resolvedAccountId = resolveMatrixSetupWizardAccountId(cfg, accountId);
	const existing = resolveMatrixAccountConfig({
		cfg,
		accountId: resolvedAccountId
	});
	const allowFrom = resolveMatrixSetupDmAllowFrom(policy, existing.dm?.allowFrom);
	return updateMatrixAccountConfig(cfg, resolvedAccountId, { dm: {
		...existing.dm,
		policy,
		allowFrom
	} });
}
function createMatrixSetupWizardProxy(loadWizardModule) {
	let wizardPromise = null;
	const loadWizard = () => {
		wizardPromise ??= loadWizardModule().then((module) => module.matrixSetupWizard);
		return wizardPromise;
	};
	return {
		channel,
		getStatus: async (ctx) => await (await loadWizard()).getStatus(ctx),
		configure: async (ctx) => await (await loadWizard()).configure(ctx),
		configureInteractive: async (ctx) => {
			const wizard = await loadWizard();
			return await (wizard.configureInteractive ?? wizard.configure)(ctx);
		},
		configureWhenConfigured: async (ctx) => {
			const wizard = await loadWizard();
			return await (wizard.configureWhenConfigured ?? wizard.configureInteractive ?? wizard.configure)(ctx);
		},
		afterConfigWritten: async (ctx) => await (await loadWizard()).afterConfigWritten?.(ctx),
		dmPolicy: {
			label: "Matrix",
			channel,
			policyKey: "channels.matrix.dm.policy",
			allowFromKey: "channels.matrix.dm.allowFrom",
			resolveConfigKeys: (cfg, accountId) => {
				const resolvedAccountId = resolveMatrixSetupWizardAccountId(cfg, accountId);
				return {
					policyKey: resolveMatrixConfigFieldPath(cfg, resolvedAccountId, "dm.policy"),
					allowFromKey: resolveMatrixConfigFieldPath(cfg, resolvedAccountId, "dm.allowFrom")
				};
			},
			getCurrent: (cfg, accountId) => resolveMatrixAccountConfig({
				cfg,
				accountId: resolveMatrixSetupWizardAccountId(cfg, accountId)
			}).dm?.policy ?? "pairing",
			setPolicy: (cfg, policy, accountId) => setMatrixDmPolicy(cfg, policy, accountId),
			promptAllowFrom: async (params) => {
				const promptAllowFrom = (await loadWizard()).dmPolicy?.promptAllowFrom;
				return promptAllowFrom ? await promptAllowFrom(params) : params.cfg;
			}
		},
		disable: (cfg) => ({
			...cfg,
			channels: {
				...cfg.channels,
				matrix: {
					...cfg.channels?.matrix,
					enabled: false
				}
			}
		})
	};
}
const matrixSetupAdapter = {
	resolveAccountId: ({ accountId, input }) => resolveMatrixSetupAccountId({
		accountId,
		name: input?.name
	}),
	resolveBindingAccountId: ({ accountId, agentId }) => resolveMatrixSetupAccountId({
		accountId,
		name: agentId
	}),
	applyAccountName: ({ cfg, accountId, name }) => prepareScopedSetupConfig({
		cfg,
		channelKey: channel,
		accountId,
		name
	}),
	validateInput: ({ accountId, input }) => validateMatrixSetupInput({
		accountId,
		input
	}),
	applyAccountConfig: ({ cfg, accountId, input }) => applyMatrixSetupAccountConfig({
		cfg,
		accountId,
		input
	}),
	afterAccountConfigWritten: async ({ previousCfg, cfg, accountId, runtime }) => {
		const { runMatrixSetupBootstrapAfterConfigWrite } = await import("./setup-bootstrap-Mm_izHsm.js");
		await runMatrixSetupBootstrapAfterConfigWrite({
			previousCfg,
			cfg,
			accountId,
			runtime
		});
	}
};
//#endregion
export { matrixSetupAdapter as n, createMatrixSetupWizardProxy as t };
