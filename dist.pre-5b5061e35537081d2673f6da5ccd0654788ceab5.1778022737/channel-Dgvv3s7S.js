import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { c as isRecord } from "./utils-CCskKJVV.js";
import { t as DEFAULT_ACCOUNT_ID } from "./account-id-DUpVOe8L.js";
import { r as createLazyRuntimeModule } from "./lazy-runtime-CVqwHtSq.js";
import { a as createActionGate } from "./common-CBt8chmE.js";
import { a as chunkText } from "./chunk-D2H_19Xb.js";
import { i as createChatChannelPlugin, t as buildChannelOutboundSessionRoute } from "./core-C8nU4cB6.js";
import "./channel-core-B_vg0lpe.js";
import { d as createDefaultChannelRuntimeState, h as collectIssuesForEnabledAccounts, l as createAsyncComputedAccountStatusAdapter, m as asString } from "./status-helpers-BvzPNo7p.js";
import { t as resolveApprovalApprovers } from "./approval-approvers-B-R3XwDD.js";
import { t as createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers-Cp7CF3NF.js";
import "./reply-chunking-CRxdpUGk.js";
import "./cli-runtime-DRalbtx_.js";
import { n as buildDmGroupAccountAllowlistAdapter } from "./allowlist-config-edit-BlD8CzkK.js";
import "./channel-actions-Lt3Lc2lg.js";
import { t as listAccountIds } from "./account-ids-lYmFPmeM.js";
import { a as resolveWhatsAppAccount } from "./accounts-CFRsd5jA.js";
import { i as looksLikeWhatsAppTargetId, n as isWhatsAppNewsletterJid, o as normalizeWhatsAppMessagingTarget, s as normalizeWhatsAppTarget, t as isWhatsAppGroupJid } from "./normalize-target-DDMQfCdK.js";
import { t as resolveWhatsAppOutboundTarget } from "./resolve-outbound-target-b5cWrJGj.js";
import { t as resolveWhatsAppReactionLevel } from "./reaction-level-CbiMmNoi.js";
import "./normalize-BMgOoTsf.js";
import { r as normalizeWhatsAppPayloadTextPreservingIndentation } from "./outbound-media-contract-C6myiRkB.js";
import { i as sendTypingWhatsApp, n as sendPollWhatsApp, t as sendMessageWhatsApp } from "./send-BzvU3jSz.js";
import { t as createWhatsAppLoginTool } from "./agent-tools-login-B_8N8Agz.js";
import { t as createWhatsAppOutboundBase } from "./outbound-base-D0CVwPT0.js";
import { t as getWhatsAppRuntime } from "./runtime-CEXRkMC3.js";
import { t as whatsappCommandPolicy } from "./command-policy-B6O-2iDT.js";
import { a as resolveWhatsAppGroupToolPolicy, c as formatWhatsAppConfigAllowFromEntries, i as resolveWhatsAppGroupRequireMention, n as loadWhatsAppChannelRuntime, o as resolveWhatsAppGroupIntroHint, r as whatsappSetupWizardProxy, s as resolveWhatsAppMentionStripRegexes, t as createWhatsAppPluginBase } from "./shared-DTVjWdOg.js";
import { d as readWebAuthExistsForDecision, n as WHATSAPP_AUTH_UNSTABLE_CODE } from "./auth-store-DE36fFpn.js";
import { t as whatsappSetupAdapter } from "./setup-core-tMeFu0Ti.js";
import { t as detectWhatsAppLegacyStateMigrations } from "./state-migrations-xgKMB-Ed.js";
//#region extensions/whatsapp/src/approval-auth.ts
function normalizeWhatsAppApproverId(value) {
	const normalized = normalizeWhatsAppTarget(String(value));
	if (!normalized || normalized.endsWith("@g.us")) return;
	return normalized;
}
const whatsappApprovalAuth = createResolvedApproverActionAuthAdapter({
	channelLabel: "WhatsApp",
	resolveApprovers: ({ cfg, accountId }) => {
		const account = resolveWhatsAppAccount({
			cfg,
			accountId
		});
		return resolveApprovalApprovers({
			allowFrom: account.allowFrom,
			defaultTo: account.defaultTo,
			normalizeApprover: normalizeWhatsAppApproverId
		});
	},
	normalizeSenderId: (value) => normalizeWhatsAppApproverId(value)
});
//#endregion
//#region extensions/whatsapp/src/channel-actions.ts
function areWhatsAppAgentReactionsEnabled(params) {
	if (!params.cfg.channels?.whatsapp) return false;
	if (!createActionGate(params.cfg.channels.whatsapp.actions)("reactions")) return false;
	return resolveWhatsAppReactionLevel({
		cfg: params.cfg,
		accountId: params.accountId
	}).agentReactionsEnabled;
}
function hasAnyWhatsAppAccountWithAgentReactionsEnabled(cfg) {
	if (!cfg.channels?.whatsapp) return false;
	return listAccountIds(cfg).some((accountId) => {
		if (!resolveWhatsAppAccount({
			cfg,
			accountId
		}).enabled) return false;
		return areWhatsAppAgentReactionsEnabled({
			cfg,
			accountId
		});
	});
}
function resolveWhatsAppAgentReactionGuidance(params) {
	if (!params.cfg.channels?.whatsapp) return;
	if (!createActionGate(params.cfg.channels.whatsapp.actions)("reactions")) return;
	const resolved = resolveWhatsAppReactionLevel({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!resolved.agentReactionsEnabled) return;
	return resolved.agentReactionGuidance;
}
function describeWhatsAppMessageActions(params) {
	if (!params.cfg.channels?.whatsapp) return null;
	const gate = createActionGate(params.cfg.channels.whatsapp.actions);
	const actions = /* @__PURE__ */ new Set();
	if (params.accountId != null ? areWhatsAppAgentReactionsEnabled({
		cfg: params.cfg,
		accountId: params.accountId ?? void 0
	}) : hasAnyWhatsAppAccountWithAgentReactionsEnabled(params.cfg)) actions.add("react");
	if (gate("polls")) actions.add("poll");
	return { actions: Array.from(actions) };
}
//#endregion
//#region extensions/whatsapp/src/channel-outbound.ts
function normalizeWhatsAppChannelPayloadText(text) {
	return normalizeWhatsAppPayloadTextPreservingIndentation(text);
}
function normalizeWhatsAppChannelSendText(text) {
	const normalized = normalizeWhatsAppChannelPayloadText(text);
	return normalized.trim() ? normalized : "";
}
const whatsappChannelOutbound = {
	...createWhatsAppOutboundBase({
		chunker: chunkText,
		sendMessageWhatsApp: async (to, text, options) => await sendMessageWhatsApp(to, text, {
			...options,
			preserveLeadingWhitespace: true
		}),
		sendPollWhatsApp,
		shouldLogVerbose: () => getWhatsAppRuntime().logging.shouldLogVerbose(),
		resolveTarget: ({ to, allowFrom, mode }) => resolveWhatsAppOutboundTarget({
			to,
			allowFrom,
			mode
		}),
		normalizeText: normalizeWhatsAppChannelSendText
	}),
	sendTextOnlyErrorPayloads: true,
	normalizePayload: ({ payload }) => ({
		...payload,
		text: normalizeWhatsAppChannelPayloadText(payload.text)
	})
};
//#endregion
//#region extensions/whatsapp/src/heartbeat.ts
async function checkWhatsAppHeartbeatReady(params) {
	if (params.cfg.web?.enabled === false) return {
		ok: false,
		reason: "whatsapp-disabled"
	};
	const account = resolveWhatsAppAccount({
		cfg: params.cfg,
		accountId: params.accountId
	});
	const authState = await (params.deps?.readWebAuthExistsForDecision ?? readWebAuthExistsForDecision)(account.authDir);
	if (authState.outcome === "unstable") return {
		ok: false,
		reason: WHATSAPP_AUTH_UNSTABLE_CODE
	};
	if (!authState.exists) return {
		ok: false,
		reason: "whatsapp-not-linked"
	};
	if (!(params.deps?.hasActiveWebListener ? params.deps.hasActiveWebListener(account.accountId) : Boolean((await loadWhatsAppChannelRuntime()).getActiveWebListener(account.accountId)))) return {
		ok: false,
		reason: "whatsapp-not-running"
	};
	return {
		ok: true,
		reason: "ok"
	};
}
//#endregion
//#region extensions/whatsapp/src/session-route.ts
function resolveWhatsAppOutboundSessionRoute(params) {
	const normalized = normalizeWhatsAppTarget(params.target);
	if (!normalized) return null;
	const isGroup = isWhatsAppGroupJid(normalized);
	const isNewsletter = isWhatsAppNewsletterJid(normalized);
	const chatType = isGroup ? "group" : isNewsletter ? "channel" : "direct";
	return buildChannelOutboundSessionRoute({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "whatsapp",
		accountId: params.accountId,
		peer: {
			kind: chatType,
			id: normalized
		},
		chatType,
		from: normalized,
		to: normalized
	});
}
//#endregion
//#region extensions/whatsapp/src/status-issues.ts
const RECENT_DISCONNECT_WARNING_WINDOW_MS = 900 * 1e3;
function readWhatsAppAccountStatus(value) {
	if (!isRecord(value)) return null;
	return {
		accountId: value.accountId,
		statusState: value.statusState,
		enabled: value.enabled,
		linked: value.linked,
		connected: value.connected,
		running: value.running,
		reconnectAttempts: value.reconnectAttempts,
		lastDisconnect: value.lastDisconnect,
		lastInboundAt: value.lastInboundAt,
		lastError: value.lastError,
		healthState: value.healthState
	};
}
function readLastDisconnect(value) {
	if (typeof value === "string") {
		const error = asString(value);
		return error ? {
			at: null,
			error
		} : null;
	}
	if (!isRecord(value)) return null;
	return {
		at: typeof value.at === "number" ? value.at : null,
		error: asString(value.error)
	};
}
function isRecentDisconnect(disconnect, now = Date.now()) {
	if (disconnect?.at == null) return false;
	return now - disconnect.at <= RECENT_DISCONNECT_WARNING_WINDOW_MS;
}
function collectWhatsAppStatusIssues(accounts) {
	return collectIssuesForEnabledAccounts({
		accounts,
		readAccount: readWhatsAppAccountStatus,
		collectIssues: ({ account, accountId, issues }) => {
			const linked = account.linked === true;
			const statusState = asString(account.statusState);
			const running = account.running === true;
			const connected = account.connected === true;
			const reconnectAttempts = typeof account.reconnectAttempts === "number" ? account.reconnectAttempts : null;
			const lastInboundAt = typeof account.lastInboundAt === "number" ? account.lastInboundAt : null;
			const lastDisconnect = readLastDisconnect(account.lastDisconnect);
			const lastError = asString(account.lastError) ?? lastDisconnect?.error;
			const healthState = asString(account.healthState);
			if (statusState === "unstable") {
				issues.push({
					channel: "whatsapp",
					accountId,
					kind: "auth",
					message: "Auth state is still stabilizing.",
					fix: "Wait a moment for queued credential writes to finish, then retry the command or rerun health."
				});
				return;
			}
			if (!linked) {
				issues.push({
					channel: "whatsapp",
					accountId,
					kind: "auth",
					message: "Not linked (no WhatsApp Web session).",
					fix: `Run: ${formatCliCommand("openclaw channels login")} (scan QR on the gateway host).`
				});
				return;
			}
			if (healthState === "stale") {
				const staleSuffix = lastInboundAt != null ? ` (last inbound ${Math.max(0, Math.floor((Date.now() - lastInboundAt) / 6e4))}m ago)` : "";
				issues.push({
					channel: "whatsapp",
					accountId,
					kind: "runtime",
					message: `Linked but stale${staleSuffix}${lastError ? `: ${lastError}` : "."}`,
					fix: `Run: ${formatCliCommand("openclaw doctor")} (or restart the gateway). If it persists, relink via channels login and check logs.`
				});
				return;
			}
			if (healthState === "reconnecting" || healthState === "conflict" || healthState === "stopped") {
				const stateLabel = healthState === "conflict" ? "session conflict" : healthState === "reconnecting" ? "reconnecting" : "stopped";
				issues.push({
					channel: "whatsapp",
					accountId,
					kind: "runtime",
					message: `Linked but ${stateLabel}${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
					fix: `Run: ${formatCliCommand("openclaw doctor")} (or restart the gateway). If it persists, relink via channels login and check logs.`
				});
				return;
			}
			if (healthState === "logged-out") {
				issues.push({
					channel: "whatsapp",
					accountId,
					kind: "auth",
					message: `Linked session logged out${lastError ? `: ${lastError}` : "."}`,
					fix: `Run: ${formatCliCommand("openclaw channels login")} (scan QR on the gateway host).`
				});
				return;
			}
			if (linked && running && connected && reconnectAttempts != null && reconnectAttempts > 0 && isRecentDisconnect(lastDisconnect)) {
				issues.push({
					channel: "whatsapp",
					accountId,
					kind: "runtime",
					message: `Linked but recently reconnected (reconnectAttempts=${reconnectAttempts})${lastError ? `: ${lastError}` : "."}`,
					fix: `Watch: ${formatCliCommand("openclaw logs --follow")} and run ${formatCliCommand("openclaw channels status --probe")} if disconnects continue. If it keeps flapping, restart the gateway or relink via channels login.`
				});
				return;
			}
			if (running && !connected) issues.push({
				channel: "whatsapp",
				accountId,
				kind: "runtime",
				message: `Linked but disconnected${reconnectAttempts != null ? ` (reconnectAttempts=${reconnectAttempts})` : ""}${lastError ? `: ${lastError}` : "."}`,
				fix: `Run: ${formatCliCommand("openclaw doctor")} (or restart the gateway). If it persists, relink via channels login and check logs.`
			});
		}
	});
}
//#endregion
//#region extensions/whatsapp/src/channel.ts
const loadWhatsAppDirectoryConfig = createLazyRuntimeModule(() => import("./directory-config-B5qMkyMz.js"));
const loadWhatsAppChannelReactAction = createLazyRuntimeModule(() => import("./channel-react-action-CwCNv8b7.js"));
function parseWhatsAppExplicitTarget(raw) {
	const normalized = normalizeWhatsAppTarget(raw);
	if (!normalized) return null;
	return {
		to: normalized,
		chatType: isWhatsAppGroupJid(normalized) ? "group" : isWhatsAppNewsletterJid(normalized) ? "channel" : "direct"
	};
}
const whatsappPlugin = createChatChannelPlugin({
	pairing: { idLabel: "whatsappSenderId" },
	outbound: whatsappChannelOutbound,
	threading: { scopedAccountReplyToMode: {
		resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({
			cfg,
			accountId
		}),
		resolveReplyToMode: (account) => account.replyToMode
	} },
	base: {
		...createWhatsAppPluginBase({
			groups: {
				resolveRequireMention: resolveWhatsAppGroupRequireMention,
				resolveToolPolicy: resolveWhatsAppGroupToolPolicy,
				resolveGroupIntroHint: resolveWhatsAppGroupIntroHint
			},
			setupWizard: whatsappSetupWizardProxy,
			setup: whatsappSetupAdapter,
			isConfigured: async (account) => {
				return await (await loadWhatsAppChannelRuntime()).readWebAuthState(account.authDir) === "linked";
			}
		}),
		agentTools: () => [createWhatsAppLoginTool()],
		allowlist: buildDmGroupAccountAllowlistAdapter({
			channelId: "whatsapp",
			resolveAccount: resolveWhatsAppAccount,
			normalize: ({ values }) => formatWhatsAppConfigAllowFromEntries(values),
			resolveDmAllowFrom: (account) => account.allowFrom,
			resolveGroupAllowFrom: (account) => account.groupAllowFrom,
			resolveDmPolicy: (account) => account.dmPolicy,
			resolveGroupPolicy: (account) => account.groupPolicy
		}),
		mentions: { stripRegexes: ({ ctx }) => resolveWhatsAppMentionStripRegexes(ctx) },
		commands: whatsappCommandPolicy,
		agentPrompt: { reactionGuidance: ({ cfg, accountId }) => {
			const level = resolveWhatsAppAgentReactionGuidance({
				cfg,
				accountId: accountId ?? void 0
			});
			return level ? {
				level,
				channelLabel: "WhatsApp"
			} : void 0;
		} },
		messaging: {
			targetPrefixes: ["whatsapp"],
			normalizeTarget: normalizeWhatsAppMessagingTarget,
			resolveOutboundSessionRoute: (params) => resolveWhatsAppOutboundSessionRoute(params),
			parseExplicitTarget: ({ raw }) => parseWhatsAppExplicitTarget(raw),
			inferTargetChatType: ({ to }) => parseWhatsAppExplicitTarget(to)?.chatType,
			targetResolver: {
				looksLikeId: looksLikeWhatsAppTargetId,
				hint: "<E.164|group JID|newsletter JID>"
			}
		},
		directory: {
			self: async ({ cfg, accountId }) => {
				const account = resolveWhatsAppAccount({
					cfg,
					accountId
				});
				const { e164, jid } = (await loadWhatsAppChannelRuntime()).readWebSelfId(account.authDir);
				const id = e164 ?? jid;
				if (!id) return null;
				return {
					kind: "user",
					id,
					name: account.name,
					raw: {
						e164,
						jid
					}
				};
			},
			listPeers: async (params) => (await loadWhatsAppDirectoryConfig()).listWhatsAppDirectoryPeersFromConfig(params),
			listGroups: async (params) => (await loadWhatsAppDirectoryConfig()).listWhatsAppDirectoryGroupsFromConfig(params)
		},
		actions: {
			describeMessageTool: ({ cfg, accountId }) => describeWhatsAppMessageActions({
				cfg,
				accountId
			}),
			supportsAction: ({ action }) => action === "react",
			resolveExecutionMode: ({ action }) => action === "react" ? "gateway" : "local",
			handleAction: async ({ action, params, cfg, accountId, requesterSenderId, toolContext }) => await (await loadWhatsAppChannelReactAction()).handleWhatsAppReactAction({
				action,
				params,
				cfg,
				accountId,
				requesterSenderId,
				toolContext
			})
		},
		approvalCapability: whatsappApprovalAuth,
		auth: { login: async ({ cfg, accountId, runtime, verbose }) => {
			const resolvedAccountId = accountId?.trim() || whatsappPlugin.config.defaultAccountId?.(cfg) || "default";
			await (await loadWhatsAppChannelRuntime()).loginWeb(Boolean(verbose), void 0, runtime, resolvedAccountId);
		} },
		lifecycle: { detectLegacyStateMigrations: ({ oauthDir }) => detectWhatsAppLegacyStateMigrations({ oauthDir }) },
		heartbeat: {
			checkReady: async ({ cfg, accountId, deps }) => await checkWhatsAppHeartbeatReady({
				cfg,
				accountId: accountId ?? void 0,
				deps
			}),
			sendTyping: async ({ cfg, to, accountId }) => {
				await sendTypingWhatsApp(to, {
					cfg,
					...accountId ? { accountId } : {}
				});
			}
		},
		status: createAsyncComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
				connected: false,
				reconnectAttempts: 0,
				lastConnectedAt: null,
				lastDisconnect: null,
				lastInboundAt: null,
				lastMessageAt: null,
				lastEventAt: null,
				healthState: "stopped"
			}),
			collectStatusIssues: collectWhatsAppStatusIssues,
			buildChannelSummary: async ({ account, snapshot }) => {
				const channelRuntime = await loadWhatsAppChannelRuntime();
				const authDir = account.authDir;
				const auth = authDir ? await channelRuntime.readWebAuthSnapshot(authDir) : {
					state: "not-linked",
					authAgeMs: null,
					selfId: {
						e164: null,
						jid: null,
						lid: null
					}
				};
				const linked = typeof snapshot.linked === "boolean" ? snapshot.linked : auth.state === "unstable" ? void 0 : auth.state === "linked";
				const summaryAuthState = auth.state === "unstable" ? auth.state : linked === true ? "linked" : linked === false ? "not-linked" : void 0;
				const statusState = summaryAuthState === void 0 ? void 0 : summaryAuthState;
				const configured = auth.state === "unstable" ? typeof snapshot.configured === "boolean" ? snapshot.configured : true : typeof linked === "boolean" ? linked : auth.state === "linked";
				const authAgeMs = typeof linked === "boolean" && linked ? auth.authAgeMs : null;
				const self = typeof linked === "boolean" && linked ? auth.selfId : {
					e164: null,
					jid: null,
					lid: null
				};
				return {
					configured,
					...statusState ? { statusState } : {},
					...typeof linked === "boolean" ? { linked } : {},
					authAgeMs,
					self,
					running: snapshot.running ?? false,
					connected: snapshot.connected ?? false,
					lastConnectedAt: snapshot.lastConnectedAt ?? null,
					lastDisconnect: snapshot.lastDisconnect ?? null,
					reconnectAttempts: snapshot.reconnectAttempts,
					lastInboundAt: snapshot.lastInboundAt ?? snapshot.lastMessageAt ?? null,
					lastMessageAt: snapshot.lastMessageAt ?? null,
					lastEventAt: snapshot.lastEventAt ?? null,
					lastError: snapshot.lastError ?? null,
					healthState: snapshot.healthState ?? void 0
				};
			},
			resolveAccountSnapshot: async ({ account, runtime }) => {
				const authState = await (await loadWhatsAppChannelRuntime()).readWebAuthState(account.authDir);
				return {
					accountId: account.accountId,
					name: account.name,
					enabled: account.enabled,
					configured: true,
					extra: {
						statusState: authState,
						...authState === "linked" ? { linked: true } : authState === "not-linked" ? { linked: false } : {},
						connected: runtime?.connected ?? false,
						reconnectAttempts: runtime?.reconnectAttempts,
						lastConnectedAt: runtime?.lastConnectedAt ?? null,
						lastDisconnect: runtime?.lastDisconnect ?? null,
						lastInboundAt: runtime?.lastInboundAt ?? runtime?.lastMessageAt ?? null,
						lastMessageAt: runtime?.lastMessageAt ?? null,
						lastEventAt: runtime?.lastEventAt ?? null,
						healthState: runtime?.healthState ?? void 0,
						dmPolicy: account.dmPolicy,
						allowFrom: account.allowFrom
					}
				};
			},
			resolveAccountState: ({ configured }) => configured ? "linked" : "not linked",
			logSelfId: ({ account, runtime, includeChannelPrefix }) => {
				loadWhatsAppChannelRuntime().then((runtimeExports) => runtimeExports.logWebSelfId(account.authDir, runtime, includeChannelPrefix));
			}
		}),
		gateway: {
			startAccount: async (ctx) => {
				const account = ctx.account;
				const { e164, jid } = (await loadWhatsAppChannelRuntime()).readWebSelfId(account.authDir);
				const identity = e164 ? e164 : jid ? `jid ${jid}` : "unknown";
				ctx.log?.info(`[${account.accountId}] starting provider (${identity})`);
				return (await loadWhatsAppChannelRuntime()).monitorWebChannel(getWhatsAppRuntime().logging.shouldLogVerbose(), void 0, true, void 0, ctx.runtime, ctx.abortSignal, {
					statusSink: (next) => ctx.setStatus({
						accountId: ctx.accountId,
						...next
					}),
					accountId: account.accountId
				});
			},
			loginWithQrStart: async ({ accountId, force, timeoutMs, verbose }) => await (await loadWhatsAppChannelRuntime()).startWebLoginWithQr({
				accountId,
				force,
				timeoutMs,
				verbose
			}),
			loginWithQrWait: async ({ accountId, timeoutMs, currentQrDataUrl }) => await (await loadWhatsAppChannelRuntime()).waitForWebLogin({
				accountId,
				timeoutMs,
				currentQrDataUrl
			}),
			logoutAccount: async ({ account, runtime }) => {
				const cleared = await (await loadWhatsAppChannelRuntime()).logoutWeb({
					authDir: account.authDir,
					isLegacyAuthDir: account.isLegacyAuthDir,
					runtime
				});
				return {
					cleared,
					loggedOut: cleared
				};
			}
		}
	}
});
//#endregion
export { whatsappPlugin as t };
