import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { o as isPrivateOrLoopbackHost } from "./net-DCUMtgJy.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { O as promptAccountId, Q as splitSetupEntries, v as mergeAllowFromEntries } from "./setup-wizard-helpers-Dbpzm32P.js";
import { t as promptChannelAccessConfig } from "./setup-group-access-BK_JJlXA.js";
import "./setup-DPvocg6M.js";
import { o as isPrivateNetworkOptInEnabled } from "./ssrf-policy-CIwd6x-p.js";
import { n as requiresExplicitMatrixDefaultAccount } from "./account-selection-CfoMW0gI.js";
import { a as resolveMatrixAccountConfig } from "./account-config-C6EZ3oG4.js";
import { r as resolveMatrixEnvAuthReadiness } from "./env-auth-RoZX59IM.js";
import { i as resolveMatrixAccount, r as resolveDefaultMatrixAccountId, t as listMatrixAccountIds } from "./accounts-CAjG_HwT.js";
import { r as moveSingleMatrixAccountConfigToNamedAccount, t as resolveMatrixSetupDmAllowFrom } from "./setup-dm-policy-WanD6L9B.js";
import { t as resolveMatrixConfigFieldPath } from "./config-paths-DExRbAi8.js";
import { n as updateMatrixAccountConfig } from "./config-update-yy_QFIrd.js";
import { n as validateMatrixHomeserverUrl, t as resolveValidatedMatrixHomeserverUrl } from "./url-validation-CnTuySPp.js";
import { n as ensureMatrixSdkInstalled, r as isMatrixSdkAvailable } from "./deps-C2Br7iRw.js";
//#region extensions/matrix/src/onboarding.ts
const channel = "matrix";
const matrixInviteAutoJoinOptions = [
	{
		value: "allowlist",
		label: "Allowlist (recommended)"
	},
	{
		value: "always",
		label: "Always (join every invite)"
	},
	{
		value: "off",
		label: "Off (do not auto-join invites)"
	}
];
function isMatrixInviteAutoJoinPolicy(value) {
	return value === "allowlist" || value === "always" || value === "off";
}
function isMatrixInviteAutoJoinTarget(entry) {
	return entry === "*" || entry.startsWith("!") && entry.includes(":") || entry.startsWith("#") && entry.includes(":");
}
function normalizeMatrixInviteAutoJoinTargets(entries) {
	return [...new Set(entries.map((entry) => normalizeOptionalString(entry)).filter((entry) => Boolean(entry)))];
}
function resolveMatrixOnboardingAccountId(cfg, accountId) {
	return normalizeAccountId(normalizeOptionalString(accountId) || resolveDefaultMatrixAccountId(cfg) || "default");
}
function setMatrixDmPolicy(cfg, policy, accountId) {
	const resolvedAccountId = resolveMatrixOnboardingAccountId(cfg, accountId);
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
async function noteMatrixAuthHelp(prompter) {
	await prompter.note([
		"Matrix requires a homeserver URL.",
		"Use an access token (recommended) or password login to an existing account.",
		"With access token: user ID is fetched automatically.",
		"Env vars supported: MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN, MATRIX_PASSWORD, MATRIX_DEVICE_ID, MATRIX_DEVICE_NAME.",
		"Per-account env vars: MATRIX_<ACCOUNT_ID>_HOMESERVER, MATRIX_<ACCOUNT_ID>_USER_ID, MATRIX_<ACCOUNT_ID>_ACCESS_TOKEN, MATRIX_<ACCOUNT_ID>_PASSWORD, MATRIX_<ACCOUNT_ID>_DEVICE_ID, MATRIX_<ACCOUNT_ID>_DEVICE_NAME.",
		`Docs: ${formatDocsLink("/channels/matrix", "channels/matrix")}`
	].join("\n"), "Matrix setup");
}
function requiresMatrixPrivateNetworkOptIn(homeserver) {
	try {
		const parsed = new URL(homeserver);
		return parsed.protocol === "http:" && !isPrivateOrLoopbackHost(parsed.hostname);
	} catch {
		return false;
	}
}
async function promptMatrixAllowFrom(params) {
	const { cfg, prompter } = params;
	const accountId = resolveMatrixOnboardingAccountId(cfg, params.accountId);
	const existingConfig = resolveMatrixAccountConfig({
		cfg,
		accountId
	});
	const existingAllowFrom = existingConfig.dm?.allowFrom ?? [];
	const canResolve = resolveMatrixAccount({
		cfg,
		accountId
	}).configured;
	const isFullUserId = (value) => value.startsWith("@") && value.includes(":");
	while (true) {
		const parts = splitSetupEntries(await prompter.text({
			message: "Matrix allowFrom (full @user:server; display name only if unique)",
			placeholder: "@user:server",
			initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0,
			validate: (value) => normalizeOptionalString(value) ? void 0 : "Required"
		}));
		const resolvedIds = [];
		const pending = [];
		const unresolved = [];
		const unresolvedNotes = [];
		for (const part of parts) {
			if (isFullUserId(part)) {
				resolvedIds.push(part);
				continue;
			}
			if (!canResolve) {
				unresolved.push(part);
				continue;
			}
			pending.push(part);
		}
		if (pending.length > 0) {
			const { resolveMatrixTargets } = await import("./resolve-targets-CokdADjj.js");
			const results = await resolveMatrixTargets({
				cfg,
				accountId,
				inputs: pending,
				kind: "user"
			}).catch(() => []);
			for (const result of results) {
				if (result?.resolved && result.id) {
					resolvedIds.push(result.id);
					continue;
				}
				if (result?.input) {
					unresolved.push(result.input);
					if (result.note) unresolvedNotes.push(`${result.input}: ${result.note}`);
				}
			}
		}
		if (unresolved.length > 0) {
			const details = unresolvedNotes.length > 0 ? unresolvedNotes : unresolved;
			await prompter.note(`Could not resolve:\n${details.join("\n")}\nUse full @user:server IDs.`, "Matrix allowlist");
			continue;
		}
		const unique = mergeAllowFromEntries(existingAllowFrom, resolvedIds);
		return updateMatrixAccountConfig(cfg, accountId, { dm: {
			...existingConfig.dm,
			policy: "allowlist",
			allowFrom: unique
		} });
	}
}
function setMatrixGroupPolicy(cfg, groupPolicy, accountId) {
	return updateMatrixAccountConfig(cfg, resolveMatrixOnboardingAccountId(cfg, accountId), { groupPolicy });
}
function setMatrixGroupRooms(cfg, roomKeys, accountId) {
	const groups = Object.fromEntries(roomKeys.map((key) => [key, { enabled: true }]));
	return updateMatrixAccountConfig(cfg, resolveMatrixOnboardingAccountId(cfg, accountId), {
		groups,
		rooms: null
	});
}
function setMatrixAutoJoin(cfg, autoJoin, autoJoinAllowlist, accountId) {
	return updateMatrixAccountConfig(cfg, resolveMatrixOnboardingAccountId(cfg, accountId), {
		autoJoin,
		autoJoinAllowlist: autoJoin === "allowlist" ? autoJoinAllowlist : null
	});
}
async function configureMatrixInviteAutoJoin(params) {
	const accountId = resolveMatrixOnboardingAccountId(params.cfg, params.accountId);
	const existingConfig = resolveMatrixAccountConfig({
		cfg: params.cfg,
		accountId
	});
	const currentPolicy = existingConfig.autoJoin ?? "off";
	const currentAllowlist = (existingConfig.autoJoinAllowlist ?? []).map((entry) => String(entry));
	const hasExistingConfig = existingConfig.autoJoin !== void 0 || currentAllowlist.length > 0;
	await params.prompter.note([
		"WARNING: Matrix invite auto-join defaults to off.",
		"OpenClaw agents will not join invited rooms or fresh DM-style invites unless you set autoJoin.",
		"Choose \"allowlist\" to restrict joins or \"always\" to join every invite."
	].join("\n"), "Matrix invite auto-join");
	if (!await params.prompter.confirm({
		message: hasExistingConfig ? "Update Matrix invite auto-join?" : "Configure Matrix invite auto-join?",
		initialValue: hasExistingConfig ? currentPolicy !== "off" : true
	})) return params.cfg;
	const selectedPolicy = await params.prompter.select({
		message: "Matrix invite auto-join",
		options: matrixInviteAutoJoinOptions,
		initialValue: currentPolicy
	});
	if (!isMatrixInviteAutoJoinPolicy(selectedPolicy)) throw new Error(`Unsupported Matrix invite auto-join policy: ${String(selectedPolicy)}`);
	const policy = selectedPolicy;
	if (policy === "off") {
		await params.prompter.note(["Matrix invite auto-join remains off.", "Agents will not join invited rooms or fresh DM-style invites until you change autoJoin."].join("\n"), "Matrix invite auto-join");
		return setMatrixAutoJoin(params.cfg, policy, [], accountId);
	}
	if (policy === "always") return setMatrixAutoJoin(params.cfg, policy, [], accountId);
	while (true) {
		const allowlist = normalizeMatrixInviteAutoJoinTargets(splitSetupEntries(await params.prompter.text({
			message: "Matrix invite auto-join allowlist (comma-separated)",
			placeholder: "!roomId:server, #alias:server, *",
			initialValue: currentAllowlist[0] ? currentAllowlist.join(", ") : void 0,
			validate: (value) => {
				return splitSetupEntries(value).length > 0 ? void 0 : "Required";
			}
		})));
		const invalidEntries = allowlist.filter((entry) => !isMatrixInviteAutoJoinTarget(entry));
		if (allowlist.length === 0 || invalidEntries.length > 0) {
			await params.prompter.note(["Use only stable Matrix invite targets for auto-join: !roomId:server, #alias:server, or *.", invalidEntries.length > 0 ? `Invalid: ${invalidEntries.join(", ")}` : void 0].filter(Boolean).join("\n"), "Matrix invite auto-join");
			continue;
		}
		return setMatrixAutoJoin(params.cfg, "allowlist", allowlist, accountId);
	}
}
async function configureMatrixAccessPrompts(params) {
	let next = params.cfg;
	if (params.forceAllowFrom) next = await promptMatrixAllowFrom({
		cfg: next,
		prompter: params.prompter,
		accountId: params.accountId
	});
	const existingAccountConfig = resolveMatrixAccountConfig({
		cfg: next,
		accountId: params.accountId
	});
	const existingGroups = existingAccountConfig.groups ?? existingAccountConfig.rooms;
	const accessConfig = await promptChannelAccessConfig({
		prompter: params.prompter,
		label: "Matrix rooms",
		currentPolicy: existingAccountConfig.groupPolicy ?? "allowlist",
		currentEntries: Object.keys(existingGroups ?? {}),
		placeholder: "!roomId:server, #alias:server, Project Room",
		updatePrompt: Boolean(existingGroups)
	});
	if (accessConfig) if (accessConfig.policy !== "allowlist") next = setMatrixGroupPolicy(next, accessConfig.policy, params.accountId);
	else {
		let roomKeys = accessConfig.entries;
		if (accessConfig.entries.length > 0) try {
			const resolvedIds = [];
			const unresolved = [];
			for (const entry of accessConfig.entries) {
				const trimmed = normalizeOptionalString(entry) ?? "";
				if (!trimmed) continue;
				const cleaned = trimmed.replace(/^(room|channel):/i, "").trim();
				if (cleaned.startsWith("!") && cleaned.includes(":")) {
					resolvedIds.push(cleaned);
					continue;
				}
				const { listMatrixDirectoryGroupsLive } = await import("./directory-live-Dps6YUDc.js");
				const matches = await listMatrixDirectoryGroupsLive({
					cfg: next,
					accountId: params.accountId,
					query: trimmed,
					limit: 10
				});
				const best = matches.find((match) => normalizeLowercaseStringOrEmpty(match.name) === normalizeLowercaseStringOrEmpty(trimmed)) ?? matches[0];
				if (best?.id) resolvedIds.push(best.id);
				else unresolved.push(entry);
			}
			roomKeys = [...resolvedIds, ...unresolved.map((entry) => normalizeOptionalString(entry)).filter((entry) => Boolean(entry))];
			if (resolvedIds.length > 0 || unresolved.length > 0) await params.prompter.note([resolvedIds.length > 0 ? `Resolved: ${resolvedIds.join(", ")}` : void 0, unresolved.length > 0 ? `Unresolved (kept as typed): ${unresolved.join(", ")}` : void 0].filter(Boolean).join("\n"), "Matrix rooms");
		} catch (err) {
			await params.prompter.note(`Room lookup failed; keeping entries as typed. ${String(err)}`, "Matrix rooms");
		}
		next = setMatrixGroupPolicy(next, "allowlist", params.accountId);
		next = setMatrixGroupRooms(next, roomKeys, params.accountId);
	}
	return await configureMatrixInviteAutoJoin({
		cfg: next,
		prompter: params.prompter,
		accountId: params.accountId
	});
}
const dmPolicy = {
	label: "Matrix",
	channel,
	policyKey: "channels.matrix.dm.policy",
	allowFromKey: "channels.matrix.dm.allowFrom",
	resolveConfigKeys: (cfg, accountId) => {
		const effectiveAccountId = resolveMatrixOnboardingAccountId(cfg, accountId);
		return {
			policyKey: resolveMatrixConfigFieldPath(cfg, effectiveAccountId, "dm.policy"),
			allowFromKey: resolveMatrixConfigFieldPath(cfg, effectiveAccountId, "dm.allowFrom")
		};
	},
	getCurrent: (cfg, accountId) => resolveMatrixAccountConfig({
		cfg,
		accountId: resolveMatrixOnboardingAccountId(cfg, accountId)
	}).dm?.policy ?? "pairing",
	setPolicy: (cfg, policy, accountId) => setMatrixDmPolicy(cfg, policy, accountId),
	promptAllowFrom: promptMatrixAllowFrom
};
async function runMatrixConfigure(params) {
	let next = params.cfg;
	await ensureMatrixSdkInstalled({
		runtime: params.runtime,
		confirm: async (message) => await params.prompter.confirm({
			message,
			initialValue: true
		})
	});
	const defaultAccountId = resolveDefaultMatrixAccountId(next);
	let accountId = defaultAccountId || "default";
	if (params.intent === "add-account") {
		const enteredName = normalizeStringifiedOptionalString(await params.prompter.text({
			message: "Matrix account name",
			validate: (value) => normalizeOptionalString(value) ? void 0 : "Required"
		})) ?? "";
		accountId = normalizeAccountId(enteredName);
		if (enteredName !== accountId) await params.prompter.note(`Account id will be "${accountId}".`, "Matrix account");
		if (accountId !== "default") next = moveSingleMatrixAccountConfigToNamedAccount(next);
		next = updateMatrixAccountConfig(next, accountId, {
			name: enteredName,
			enabled: true
		});
	} else {
		const override = normalizeOptionalString(params.accountOverrides?.[channel]);
		if (override) accountId = normalizeAccountId(override);
		else if (params.shouldPromptAccountIds) accountId = await promptAccountId({
			cfg: next,
			prompter: params.prompter,
			label: "Matrix",
			currentId: accountId,
			listAccountIds: (inputCfg) => listMatrixAccountIds(inputCfg),
			defaultAccountId
		});
	}
	const existing = resolveMatrixAccountConfig({
		cfg: next,
		accountId
	});
	if (!resolveMatrixAccount({
		cfg: next,
		accountId
	}).configured) await noteMatrixAuthHelp(params.prompter);
	const envReadiness = resolveMatrixEnvAuthReadiness(accountId, process.env);
	const envReady = envReadiness.ready;
	const envHomeserver = envReadiness.homeserver;
	const envUserId = envReadiness.userId;
	if (envReady && !existing.homeserver && !existing.userId && !existing.accessToken && !existing.password) {
		if (await params.prompter.confirm({
			message: `Matrix env vars detected (${envReadiness.sourceHint}). Use env values?`,
			initialValue: true
		})) {
			next = updateMatrixAccountConfig(next, accountId, { enabled: true });
			next = await configureMatrixAccessPrompts({
				cfg: next,
				prompter: params.prompter,
				forceAllowFrom: params.forceAllowFrom,
				accountId
			});
			return {
				cfg: next,
				accountId
			};
		}
	}
	const homeserver = normalizeStringifiedOptionalString(await params.prompter.text({
		message: "Matrix homeserver URL",
		initialValue: existing.homeserver ?? envHomeserver,
		validate: (value) => {
			try {
				validateMatrixHomeserverUrl(value, { allowPrivateNetwork: true });
				return;
			} catch (error) {
				return error instanceof Error ? error.message : "Invalid Matrix homeserver URL";
			}
		}
	})) ?? "";
	const requiresAllowPrivateNetwork = requiresMatrixPrivateNetworkOptIn(homeserver);
	const shouldPromptAllowPrivateNetwork = requiresAllowPrivateNetwork || isPrivateNetworkOptInEnabled(existing);
	const allowPrivateNetwork = shouldPromptAllowPrivateNetwork ? await params.prompter.confirm({
		message: "Allow private/internal Matrix homeserver traffic for this account?",
		initialValue: isPrivateNetworkOptInEnabled(existing) || requiresAllowPrivateNetwork
	}) : false;
	if (requiresAllowPrivateNetwork && !allowPrivateNetwork) throw new Error("Matrix homeserver requires explicit private-network opt-in");
	await resolveValidatedMatrixHomeserverUrl(homeserver, { dangerouslyAllowPrivateNetwork: allowPrivateNetwork });
	let accessToken = existing.accessToken;
	let password = existing.password;
	let userId = existing.userId ?? "";
	if (hasConfiguredSecretInput(accessToken) || hasConfiguredSecretInput(password)) {
		if (!await params.prompter.confirm({
			message: "Matrix credentials already configured. Keep them?",
			initialValue: true
		})) {
			accessToken = void 0;
			password = void 0;
			userId = "";
		}
	}
	if (!hasConfiguredSecretInput(accessToken) && !hasConfiguredSecretInput(password)) if (await params.prompter.select({
		message: "Matrix auth method",
		options: [{
			value: "token",
			label: "Access token (user ID fetched automatically)"
		}, {
			value: "password",
			label: "Password (requires user ID)"
		}]
	}) === "token") {
		accessToken = normalizeStringifiedOptionalString(await params.prompter.text({
			message: "Matrix access token",
			validate: (value) => normalizeOptionalString(value) ? void 0 : "Required"
		})) ?? "";
		password = void 0;
		userId = "";
	} else {
		userId = normalizeStringifiedOptionalString(await params.prompter.text({
			message: "Matrix user ID",
			initialValue: existing.userId ?? envUserId,
			validate: (value) => {
				const raw = normalizeOptionalString(value) ?? "";
				if (!raw) return "Required";
				if (!raw.startsWith("@")) return "Matrix user IDs should start with @";
				if (!raw.includes(":")) return "Matrix user IDs should include a server (:server)";
			}
		})) ?? "";
		password = normalizeStringifiedOptionalString(await params.prompter.text({
			message: "Matrix password",
			validate: (value) => normalizeOptionalString(value) ? void 0 : "Required"
		})) ?? "";
		accessToken = void 0;
	}
	const deviceName = normalizeStringifiedOptionalString(await params.prompter.text({
		message: "Matrix device name (optional)",
		initialValue: existing.deviceName ?? "OpenClaw Gateway"
	})) ?? "";
	const enableEncryption = await params.prompter.confirm({
		message: "Enable end-to-end encryption (E2EE)?",
		initialValue: existing.encryption ?? false
	});
	next = updateMatrixAccountConfig(next, accountId, {
		enabled: true,
		homeserver,
		...shouldPromptAllowPrivateNetwork ? { allowPrivateNetwork: allowPrivateNetwork ? true : null } : {},
		userId: userId || null,
		accessToken: accessToken ?? null,
		password: password ?? null,
		deviceName: deviceName || null,
		encryption: enableEncryption
	});
	next = await configureMatrixAccessPrompts({
		cfg: next,
		prompter: params.prompter,
		forceAllowFrom: params.forceAllowFrom,
		accountId
	});
	return {
		cfg: next,
		accountId
	};
}
const matrixOnboardingAdapter = {
	channel,
	getStatus: async ({ cfg, accountOverrides }) => {
		const resolvedCfg = cfg;
		const sdkReady = isMatrixSdkAvailable();
		if (!accountOverrides[channel] && requiresExplicitMatrixDefaultAccount(resolvedCfg)) return {
			channel,
			configured: false,
			statusLines: ["Matrix: set \"channels.matrix.defaultAccount\" to select a named account"],
			selectionHint: !sdkReady ? "install Matrix deps" : "set defaultAccount"
		};
		const configured = resolveMatrixAccount({
			cfg: resolvedCfg,
			accountId: resolveMatrixOnboardingAccountId(resolvedCfg, accountOverrides[channel])
		}).configured;
		return {
			channel,
			configured,
			statusLines: [`Matrix: ${configured ? "configured" : "needs homeserver + access token or password"}`],
			selectionHint: !sdkReady ? "install Matrix deps" : configured ? "configured" : "needs auth"
		};
	},
	configure: async ({ cfg, runtime, prompter, forceAllowFrom, accountOverrides, shouldPromptAccountIds }) => await runMatrixConfigure({
		cfg,
		runtime,
		prompter,
		forceAllowFrom,
		accountOverrides,
		shouldPromptAccountIds,
		intent: "update"
	}),
	configureInteractive: async ({ cfg, runtime, prompter, forceAllowFrom, accountOverrides, shouldPromptAccountIds, configured }) => {
		if (!configured) return await runMatrixConfigure({
			cfg,
			runtime,
			prompter,
			forceAllowFrom,
			accountOverrides,
			shouldPromptAccountIds,
			intent: "update"
		});
		const action = await prompter.select({
			message: "Matrix already configured. What do you want to do?",
			options: [
				{
					value: "update",
					label: "Modify settings"
				},
				{
					value: "add-account",
					label: "Add account"
				},
				{
					value: "skip",
					label: "Skip (leave as-is)"
				}
			],
			initialValue: "update"
		});
		if (action === "skip") return "skip";
		return await runMatrixConfigure({
			cfg,
			runtime,
			prompter,
			forceAllowFrom,
			accountOverrides,
			shouldPromptAccountIds,
			intent: action === "add-account" ? "add-account" : "update"
		});
	},
	afterConfigWritten: async ({ previousCfg, cfg, accountId, runtime }) => {
		const { runMatrixSetupBootstrapAfterConfigWrite } = await import("./setup-bootstrap-Mm_izHsm.js");
		await runMatrixSetupBootstrapAfterConfigWrite({
			previousCfg,
			cfg,
			accountId,
			runtime
		});
	},
	dmPolicy,
	disable: (cfg) => ({
		...cfg,
		channels: {
			...cfg.channels,
			matrix: {
				...cfg.channels?.["matrix"],
				enabled: false
			}
		}
	})
};
//#endregion
export { matrixOnboardingAdapter as t };
