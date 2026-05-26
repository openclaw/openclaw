import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { T as pathExists } from "./fs-safe-DpJlqO1z.js";
import { g as shortenHomePath, p as resolveUserPath } from "./utils-CKsuXgDI.js";
import { c as normalizeAgentId, t as DEFAULT_AGENT_ID } from "./session-key-DFEyR49L.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir, t as listAgentEntries } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-DDH_zqCr.js";
import { n as saveJsonFile } from "./json-file-C3OPVumq.js";
import { l as resolveAuthStorePath } from "./source-check-BnSDslnj.js";
import { g as loadPersistedAuthProfileStore, m as buildPersistedAuthProfileSecretsStore, n as ensureAuthProfileStore } from "./store-a4exFSck.js";
import { t as buildPortableAuthProfileSecretsStoreForAgentCopy } from "./auth-profiles-vKILPyQ8.js";
import { t as WizardCancelledError } from "./prompts-w_QiqAiL.js";
import { t as createClackPrompter } from "./clack-prompter-DwOyumBC.js";
import { n as logConfigUpdated } from "./logging-BIVQbiBA.js";
import { t as commitConfigWithPendingPluginInstalls } from "./plugins-install-record-commit-ChzTDi9U.js";
import { r as ensureWorkspaceAndSessions } from "./onboard-helpers-D5MK7ND9.js";
import { a as describeBinding, n as buildChannelBindings, r as parseBindingSpecs, t as applyAgentBindings } from "./agents.bindings-nrwDJeoA.js";
import { n as requireValidConfigSnapshot, t as requireValidConfigFileSnapshot$1 } from "./config-validation-DdT8rDtO.js";
import { r as findAgentEntryIndex, t as applyAgentConfig } from "./agents.config-Cmpjpkhp.js";
import { t as promptAuthChoiceGrouped } from "./auth-choice-prompt-D9pR4CA8.js";
import { n as applyAuthChoice, t as warnIfModelConfigLooksOff } from "./auth-choice-B1SFsKtV.js";
import { i as setupChannels } from "./onboard-channels-Cgs4Sfyh.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/agents.command-shared.ts
function createQuietRuntime(runtime) {
	return {
		...runtime,
		log: () => {}
	};
}
async function requireValidConfigFileSnapshot(runtime) {
	return await requireValidConfigFileSnapshot$1(runtime);
}
async function requireValidConfig(runtime) {
	return await requireValidConfigSnapshot(runtime);
}
//#endregion
//#region src/commands/agents.commands.add.ts
function formatSkippedOAuthProfilesMessage(params) {
	return params.sourceIsInheritedMain ? `OAuth profiles stay shared from "${params.sourceAgentId}" unless this agent signs in separately.` : `OAuth profiles were not copied from "${params.sourceAgentId}"; sign in separately for this agent.`;
}
async function agentsAddCommand(opts, runtime = defaultRuntime, params) {
	const configSnapshot = await requireValidConfigFileSnapshot(runtime);
	if (!configSnapshot) return;
	const cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
	const baseHash = configSnapshot.hash;
	const workspaceFlag = opts.workspace?.trim();
	const nameInput = opts.name?.trim();
	const hasFlags = params?.hasFlags === true;
	const nonInteractive = opts.nonInteractive === true || hasFlags;
	if (nonInteractive && !workspaceFlag) {
		runtime.error(`Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`);
		runtime.exit(1);
		return;
	}
	if (nonInteractive) {
		if (!nameInput) {
			runtime.error(`Agent name is required in non-interactive mode. Run ${formatCliCommand("openclaw agents add <id> --workspace <path>")}.`);
			runtime.exit(1);
			return;
		}
		if (!workspaceFlag) {
			runtime.error(`Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`);
			runtime.exit(1);
			return;
		}
		const agentId = normalizeAgentId(nameInput);
		if (agentId === "main") {
			runtime.error(`"${DEFAULT_AGENT_ID}" is reserved. Choose another name, or run ${formatCliCommand("openclaw agents list")} to inspect the default agent.`);
			runtime.exit(1);
			return;
		}
		if (agentId !== nameInput) runtime.log(`Normalized agent id to "${agentId}".`);
		if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
			runtime.error(`Agent "${agentId}" already exists. Run ${formatCliCommand("openclaw agents list")} to inspect configured agents.`);
			runtime.exit(1);
			return;
		}
		const workspaceDir = resolveUserPath(workspaceFlag);
		const agentDir = opts.agentDir?.trim() ? resolveUserPath(opts.agentDir.trim()) : resolveAgentDir(cfg, agentId);
		const model = opts.model?.trim();
		const nextConfig = applyAgentConfig(cfg, {
			agentId,
			name: nameInput,
			workspace: workspaceDir,
			agentDir,
			...model ? { model } : {}
		});
		const bindingParse = parseBindingSpecs({
			agentId,
			specs: opts.bind,
			config: nextConfig
		});
		if (bindingParse.errors.length > 0) {
			runtime.error(bindingParse.errors.join("\n"));
			runtime.exit(1);
			return;
		}
		const bindingResult = bindingParse.bindings.length > 0 ? applyAgentBindings(nextConfig, bindingParse.bindings) : {
			config: nextConfig,
			added: [],
			updated: [],
			skipped: [],
			conflicts: []
		};
		await commitConfigWithPendingPluginInstalls({
			nextConfig: bindingResult.config,
			...baseHash !== void 0 ? { baseHash } : {}
		});
		if (!opts.json) logConfigUpdated(runtime);
		await ensureWorkspaceAndSessions(workspaceDir, opts.json ? createQuietRuntime(runtime) : runtime, {
			skipBootstrap: Boolean(bindingResult.config.agents?.defaults?.skipBootstrap),
			skipOptionalBootstrapFiles: bindingResult.config.agents?.defaults?.skipOptionalBootstrapFiles,
			agentId
		});
		const payload = {
			agentId,
			name: nameInput,
			workspace: workspaceDir,
			agentDir,
			model,
			bindings: {
				added: bindingResult.added.map(describeBinding),
				updated: bindingResult.updated.map(describeBinding),
				skipped: bindingResult.skipped.map(describeBinding),
				conflicts: bindingResult.conflicts.map((conflict) => `${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`)
			}
		};
		if (opts.json) writeRuntimeJson(runtime, payload);
		else {
			runtime.log(`Agent: ${agentId}`);
			runtime.log(`Workspace: ${shortenHomePath(workspaceDir)}`);
			runtime.log(`Agent dir: ${shortenHomePath(agentDir)}`);
			if (model) runtime.log(`Model: ${model}`);
			if (bindingResult.conflicts.length > 0) runtime.error(["Skipped bindings already claimed by another agent:", ...bindingResult.conflicts.map((conflict) => `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`)].join("\n"));
		}
		return;
	}
	const prompter = createClackPrompter();
	try {
		await prompter.intro("Add OpenClaw agent");
		const agentName = normalizeOptionalString(nameInput ?? await prompter.text({
			message: "Agent name",
			validate: (value) => {
				if (!value?.trim()) return "Required";
				if (normalizeAgentId(value) === "main") return `"main" is reserved. Choose another name.`;
			}
		})) ?? "";
		const agentId = normalizeAgentId(agentName);
		if (agentName !== agentId) await prompter.note(`Normalized id to "${agentId}".`, "Agent id");
		if (listAgentEntries(cfg).find((agent) => normalizeAgentId(agent.id) === agentId)) {
			if (!await prompter.confirm({
				message: `Agent "${agentId}" already exists. Update it?`,
				initialValue: false
			})) {
				await prompter.outro("No changes made.");
				return;
			}
		}
		const workspaceDefault = resolveAgentWorkspaceDir(cfg, agentId);
		const workspaceDir = resolveUserPath(normalizeOptionalString(await prompter.text({
			message: "Workspace directory",
			initialValue: workspaceDefault,
			validate: (value) => value?.trim() ? void 0 : "Required"
		})) || workspaceDefault);
		const agentDir = resolveAgentDir(cfg, agentId);
		let nextConfig = applyAgentConfig(cfg, {
			agentId,
			name: agentName,
			workspace: workspaceDir,
			agentDir
		});
		const defaultAgentId = resolveDefaultAgentId(cfg);
		if (defaultAgentId !== agentId) {
			const sourceAgentDir = resolveAgentDir(cfg, defaultAgentId);
			const sourceAuthPath = resolveAuthStorePath(sourceAgentDir);
			const destAuthPath = resolveAuthStorePath(agentDir);
			const mainAuthPath = resolveAuthStorePath(void 0);
			const sameAuthPath = normalizeLowercaseStringOrEmpty(path.resolve(sourceAuthPath)) === normalizeLowercaseStringOrEmpty(path.resolve(destAuthPath));
			const sourceIsInheritedMain = normalizeLowercaseStringOrEmpty(path.resolve(sourceAuthPath)) === normalizeLowercaseStringOrEmpty(path.resolve(mainAuthPath));
			if (!sameAuthPath && await pathExists(sourceAuthPath) && !await pathExists(destAuthPath)) {
				const sourceStore = loadPersistedAuthProfileStore(sourceAgentDir);
				const portable = sourceStore ? buildPortableAuthProfileSecretsStoreForAgentCopy(sourceStore) : void 0;
				if (portable && portable.copiedProfileIds.length > 0) {
					if (await prompter.confirm({
						message: `Copy portable auth profiles from "${defaultAgentId}"?`,
						initialValue: false
					})) {
						await fs.mkdir(path.dirname(destAuthPath), { recursive: true });
						saveJsonFile(destAuthPath, buildPersistedAuthProfileSecretsStore(portable.store, void 0, { agentDir }));
						const skippedText = portable.skippedProfileIds.length > 0 ? ` ${formatSkippedOAuthProfilesMessage({
							sourceAgentId: defaultAgentId,
							sourceIsInheritedMain
						})}` : "";
						await prompter.note(`Copied ${portable.copiedProfileIds.length} portable auth profile${portable.copiedProfileIds.length === 1 ? "" : "s"} from "${defaultAgentId}".${skippedText}`, "Auth profiles");
					}
				} else if ((portable?.skippedProfileIds.length ?? 0) > 0) await prompter.note(formatSkippedOAuthProfilesMessage({
					sourceAgentId: defaultAgentId,
					sourceIsInheritedMain
				}), "Auth profiles");
			}
		}
		if (await prompter.confirm({
			message: "Configure model/auth for this agent now?",
			initialValue: false
		})) {
			const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
			while (true) {
				const authResult = await applyAuthChoice({
					authChoice: await promptAuthChoiceGrouped({
						prompter,
						store: authStore,
						includeSkip: true,
						config: nextConfig
					}),
					config: nextConfig,
					prompter,
					runtime,
					agentDir,
					setDefaultModel: false,
					agentId
				});
				nextConfig = authResult.config;
				if (authResult.retrySelection) continue;
				if (authResult.agentModelOverride) nextConfig = applyAgentConfig(nextConfig, {
					agentId,
					model: authResult.agentModelOverride
				});
				break;
			}
		}
		await warnIfModelConfigLooksOff(nextConfig, prompter, {
			agentId,
			agentDir
		});
		let selection = [];
		const channelAccountIds = {};
		nextConfig = await setupChannels(nextConfig, runtime, prompter, {
			allowSignalInstall: true,
			onSelection: (value) => {
				selection = value;
			},
			promptAccountIds: true,
			onAccountId: (channel, accountId) => {
				channelAccountIds[channel] = accountId;
			}
		});
		if (selection.length > 0) if (await prompter.confirm({
			message: "Route selected channels to this agent now? (bindings)",
			initialValue: false
		})) {
			const desiredBindings = buildChannelBindings({
				agentId,
				selection,
				config: nextConfig,
				accountIds: channelAccountIds
			});
			const result = applyAgentBindings(nextConfig, desiredBindings);
			nextConfig = result.config;
			if (result.conflicts.length > 0) await prompter.note(["Skipped bindings already claimed by another agent:", ...result.conflicts.map((conflict) => `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`)].join("\n"), "Routing bindings");
		} else await prompter.note(["Routing unchanged. Add bindings when you're ready.", "Docs: https://docs.openclaw.ai/concepts/multi-agent"].join("\n"), "Routing");
		nextConfig = (await commitConfigWithPendingPluginInstalls({
			nextConfig,
			...baseHash !== void 0 ? { baseHash } : {}
		})).config;
		logConfigUpdated(runtime);
		await ensureWorkspaceAndSessions(workspaceDir, runtime, {
			skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
			skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
			agentId
		});
		const payload = {
			agentId,
			name: agentName,
			workspace: workspaceDir,
			agentDir
		};
		if (opts.json) writeRuntimeJson(runtime, payload);
		await prompter.outro(`Agent "${agentId}" ready.`);
	} catch (err) {
		if (err instanceof WizardCancelledError) {
			runtime.exit(1);
			return;
		}
		throw err;
	}
}
//#endregion
export { requireValidConfigFileSnapshot as i, createQuietRuntime as n, requireValidConfig as r, agentsAddCommand as t };
