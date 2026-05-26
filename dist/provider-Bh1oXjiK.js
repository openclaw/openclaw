import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { u as normalizeResolvedSecretInputString } from "./types.secrets-BxqheYvy.js";
import { n as normalizeAccountId } from "./account-id-CwBWagLE.js";
import { l as normalizeMainKey } from "./session-key-DFEyR49L.js";
import { s as normalizeStringEntries } from "./string-normalization-DEwYgSEp.js";
import { t as createNonExitingRuntime } from "./runtime-DDH_zqCr.js";
import { a as shouldLogVerbose, r as logVerbose, s as warn, t as danger } from "./globals-CouSpJO4.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { r as replaceConfigFile } from "./mutate-FhI2HIyp.js";
import { t as pruneMapToMaxSize } from "./map-size-iKLwUWZ5.js";
import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { t as loadSessionStore } from "./store-load-cmAGD4uk.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-VRXWv5rs.js";
import { o as requestHeartbeat } from "./heartbeat-wake-DMnOjlhb.js";
import { a as enqueueSystemEvent } from "./system-events-D_-_Inav.js";
import { i as generateSecureToken } from "./secure-random-D0M56YeC.js";
import { c as resolveTextChunkLimit } from "./chunk-CGVwhsnj.js";
import { h as resolveChannelConfigWrites } from "./channel-config-helpers-Dzal6cfS.js";
import { n as sleepWithAbort, t as computeBackoff } from "./backoff-CW9s2Y7t.js";
import { f as parsePluginBindingApprovalCustomId, i as buildPluginBindingResolvedText, m as resolvePluginConversationBindingApproval } from "./conversation-binding-mt8hjpt4.js";
import { i as formatCommandArgMenuTitle } from "./commands-registry-CPSWhUW1.js";
import { t as resolveCommandAuthorization } from "./command-auth-BZf85E5V.js";
import "./error-runtime-BnVeBNYa.js";
import "./runtime-env-AKjXcC53.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./routing-BfSZVtOk.js";
import "./secret-input-DlbCRffO.js";
import "./history-DVJTezhz.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-B0RIiqGl.js";
import { c as buildAllowlistResolutionSummary, d as patchAllowlistUsersInConfigEntries, f as summarizeMapping, s as addAllowlistUserEntriesFromConfigEntry, u as mergeAllowlist } from "./allow-from-CFKhmZbv.js";
import { a as warnMissingProviderGroupPolicyFallbackOnce, i as resolveOpenProviderRuntimeGroupPolicy, r as resolveDefaultGroupPolicy } from "./runtime-group-policy-BoxMLuus.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-DIj-YkyE.js";
import "./reply-history-DFZwzL3w.js";
import { d as parseExecApprovalCommandText } from "./exec-approval-reply-EV2HWtya.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-runtime-C33N9zkP.js";
import { t as CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "./approval-handler-adapter-runtime-DG5nC6uH.js";
import { r as registerChannelRuntimeContext } from "./channel-runtime-context-BRtcYaLp.js";
import "./approval-reply-runtime-BT3hlhXm.js";
import { n as resolveNativeCommandsEnabled, r as resolveNativeSkillsEnabled } from "./commands-CPC8gOCg.js";
import "./config-mutation-BJc61hPG.js";
import { n as resolveStoredModelOverride } from "./stored-model-override-IjcwakfK.js";
import "./reply-chunking-DnJ1jlVh.js";
import "./heartbeat-runtime-BwYXlqOu.js";
import "./system-event-runtime-L5JTiCmm.js";
import { i as installRequestBodyLimitGuard } from "./http-body-DGSOY_R5.js";
import "./runtime-config-snapshot-pRc6W_Li.js";
import { t as chunkItems } from "./chunk-items-D9SIVk6m.js";
import "./text-chunking-3_9rfiI8.js";
import "./agent-runtime-C0lBBqMR.js";
import { i as createInteractiveConversationBindingHelpers, r as dispatchPluginInteractiveHandler } from "./plugin-runtime-C1lejF10.js";
import { t as resolveNativeCommandSessionTargets } from "./native-command-session-targets-B9vD-D3x.js";
import "./command-auth-native-BQC8E6ZX.js";
import { n as createChannelInboundDebouncer, r as shouldDebounceTextInbound } from "./channel-inbound-DuNiLVQs.js";
import "./channel-message-CmG6T1ry.js";
import "./session-store-runtime-DIobQazh.js";
import "./native-command-config-runtime-DnoKww_3.js";
import "./webhook-request-guards-CHYlKcg-.js";
import { a as resolveSlackAccount, d as resolveSlackBotToken, o as resolveSlackAccountAllowFrom, s as resolveSlackAccountDmPolicy, u as resolveSlackAppToken } from "./accounts-Ba1LnRZV.js";
import { i as isSlackExecApprovalClientEnabled, n as isSlackExecApprovalApprover, r as isSlackExecApprovalAuthorizedSender } from "./exec-approvals-DNT770yC.js";
import "./blocks-render-KRq-hLT2.js";
import { i as truncateSlackText, r as SLACK_TEXT_LIMIT } from "./thread-ts-DWLXPVhT.js";
import { c as resolveSlackWebClientOptions } from "./client-BY5LT_WB.js";
import { n as normalizeAllowList } from "./allow-list-NJrZzx1V.js";
import "./blocks-input-BkCFIqct.js";
import { n as registerSlackHttpHandler, r as normalizeSlackWebhookPath } from "./registry-BxvZ0aQE.js";
import { t as formatSlackError } from "./errors-C7qatgFo.js";
import { t as resolveSlackChannelAllowlist } from "./resolve-channels-CFu2DI7Q.js";
import { t as resolveSlackUserAllowlist } from "./resolve-users-s6WKqdm9.js";
import { a as resolveSlackCommandIngress, c as isSlackChannelAllowedByPolicy, d as resolveSlackChannelConfig, f as resolveSlackChannelLabel, h as stripSlackMentionsForCommandDetection, i as authorizeSlackSystemEventSender, l as normalizeSlackChannelType, m as resolveSlackSlashCommandConfig, n as authorizeSlackDirectMessage, o as resolveSlackEffectiveAllowFrom, p as buildSlackSlashCommandMatcher, s as createSlackMonitorContext, t as resolveSlackRoomContextHints, u as resolveSlackChatType } from "./room-context-DrGzGSyg.js";
import { t as escapeSlackMrkdwn } from "./mrkdwn-D4v581Ex.js";
//#region extensions/slack/src/channel-migration.ts
function resolveAccountChannels(cfg, accountId) {
	if (!accountId) return {};
	const normalized = normalizeAccountId(accountId);
	const accounts = cfg.channels?.slack?.accounts;
	if (!accounts || typeof accounts !== "object") return {};
	const exact = accounts[normalized];
	if (exact?.channels) return { channels: exact.channels };
	const matchKey = Object.keys(accounts).find((key) => normalizeLowercaseStringOrEmpty(key) === normalizeLowercaseStringOrEmpty(normalized));
	return { channels: matchKey ? accounts[matchKey]?.channels : void 0 };
}
function migrateSlackChannelsInPlace(channels, oldChannelId, newChannelId) {
	if (!channels) return {
		migrated: false,
		skippedExisting: false
	};
	if (oldChannelId === newChannelId) return {
		migrated: false,
		skippedExisting: false
	};
	if (!Object.hasOwn(channels, oldChannelId)) return {
		migrated: false,
		skippedExisting: false
	};
	if (Object.hasOwn(channels, newChannelId)) return {
		migrated: false,
		skippedExisting: true
	};
	channels[newChannelId] = channels[oldChannelId];
	delete channels[oldChannelId];
	return {
		migrated: true,
		skippedExisting: false
	};
}
function migrateSlackChannelConfig(params) {
	const scopes = [];
	let migrated = false;
	let skippedExisting = false;
	const accountChannels = resolveAccountChannels(params.cfg, params.accountId).channels;
	if (accountChannels) {
		const result = migrateSlackChannelsInPlace(accountChannels, params.oldChannelId, params.newChannelId);
		if (result.migrated) {
			migrated = true;
			scopes.push("account");
		}
		if (result.skippedExisting) skippedExisting = true;
	}
	const globalChannels = params.cfg.channels?.slack?.channels;
	if (globalChannels) {
		const result = migrateSlackChannelsInPlace(globalChannels, params.oldChannelId, params.newChannelId);
		if (result.migrated) {
			migrated = true;
			scopes.push("global");
		}
		if (result.skippedExisting) skippedExisting = true;
	}
	return {
		migrated,
		skippedExisting,
		scopes
	};
}
//#endregion
//#region extensions/slack/src/monitor/events/channels.ts
function registerSlackChannelEvents(params) {
	const { ctx, trackEvent } = params;
	const enqueueChannelSystemEvent = (params) => {
		if (!ctx.isChannelAllowed({
			channelId: params.channelId,
			channelName: params.channelName,
			channelType: "channel"
		})) return;
		const label = resolveSlackChannelLabel({
			channelId: params.channelId,
			channelName: params.channelName
		});
		const sessionKey = ctx.resolveSlackSystemEventSessionKey({
			channelId: params.channelId,
			channelType: "channel"
		});
		enqueueSystemEvent(`Slack channel ${params.kind}: ${label}.`, {
			sessionKey,
			contextKey: `slack:channel:${params.kind}:${params.channelId ?? params.channelName ?? "unknown"}`
		});
	};
	ctx.app.event("channel_created", async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			trackEvent?.();
			const payload = event;
			const channelId = payload.channel?.id;
			const channelName = payload.channel?.name;
			enqueueChannelSystemEvent({
				kind: "created",
				channelId,
				channelName
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack channel created handler failed: ${formatErrorMessage(err)}`));
		}
	});
	ctx.app.event("channel_rename", async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			trackEvent?.();
			const payload = event;
			const channelId = payload.channel?.id;
			enqueueChannelSystemEvent({
				kind: "renamed",
				channelId,
				channelName: payload.channel?.name_normalized ?? payload.channel?.name
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack channel rename handler failed: ${formatErrorMessage(err)}`));
		}
	});
	ctx.app.event("channel_id_changed", async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			trackEvent?.();
			const payload = event;
			const oldChannelId = payload.old_channel_id;
			const newChannelId = payload.new_channel_id;
			if (!oldChannelId || !newChannelId) return;
			const label = resolveSlackChannelLabel({
				channelId: newChannelId,
				channelName: (await ctx.resolveChannelName(newChannelId))?.name
			});
			ctx.runtime.log?.(warn(`[slack] Channel ID changed: ${oldChannelId} → ${newChannelId} (${label})`));
			if (!resolveChannelConfigWrites({
				cfg: ctx.cfg,
				channelId: "slack",
				accountId: ctx.accountId
			})) {
				ctx.runtime.log?.(warn("[slack] Config writes disabled; skipping channel config migration."));
				return;
			}
			const currentConfig = getRuntimeConfig();
			const migration = migrateSlackChannelConfig({
				cfg: currentConfig,
				accountId: ctx.accountId,
				oldChannelId,
				newChannelId
			});
			if (migration.migrated) {
				migrateSlackChannelConfig({
					cfg: ctx.cfg,
					accountId: ctx.accountId,
					oldChannelId,
					newChannelId
				});
				await replaceConfigFile({
					nextConfig: currentConfig,
					afterWrite: { mode: "auto" }
				});
				ctx.runtime.log?.(warn("[slack] Channel config migrated and saved successfully."));
			} else if (migration.skippedExisting) ctx.runtime.log?.(warn(`[slack] Channel config already exists for ${newChannelId}; leaving ${oldChannelId} unchanged`));
			else ctx.runtime.log?.(warn(`[slack] No config found for old channel ID ${oldChannelId}; migration logged only`));
		} catch (err) {
			ctx.runtime.error?.(danger(`slack channel_id_changed handler failed: ${formatErrorMessage(err)}`));
		}
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/home.ts
function buildSlackHomeView() {
	return {
		type: "home",
		callback_id: "openclaw:home",
		blocks: [
			{
				type: "header",
				text: {
					type: "plain_text",
					text: "OpenClaw"
				}
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "Send a DM, mention OpenClaw in a channel, or use `/openclaw` to start a session."
				}
			},
			{
				type: "context",
				elements: [{
					type: "mrkdwn",
					text: "This Home tab is safe to show to any workspace member who opens the app."
				}]
			}
		]
	};
}
function registerSlackHomeEvents(params) {
	const { ctx, trackEvent } = params;
	ctx.app.event("app_home_opened", async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			trackEvent?.();
			const payload = event;
			if (!payload.user || payload.tab === "messages") return;
			await ctx.app.client.views.publish({
				token: ctx.botToken,
				user_id: payload.user,
				view: buildSlackHomeView()
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack app home handler failed: ${formatErrorMessage(err)}`));
		}
	});
}
//#endregion
//#region extensions/slack/src/interactive-dispatch.ts
async function dispatchSlackPluginInteractiveHandler(params) {
	return await dispatchPluginInteractiveHandler({
		channel: "slack",
		data: params.data,
		dedupeId: params.interactionId,
		onMatched: params.onMatched,
		invoke: ({ registration, namespace, payload }) => registration.handler({
			...params.ctx,
			channel: "slack",
			interaction: {
				...params.ctx.interaction,
				data: params.data,
				namespace,
				payload
			},
			respond: params.respond,
			...createInteractiveConversationBindingHelpers({
				registration,
				senderId: params.ctx.senderId,
				conversation: {
					channel: "slack",
					accountId: params.ctx.accountId,
					conversationId: params.ctx.conversationId,
					parentConversationId: params.ctx.parentConversationId,
					threadId: params.ctx.threadId
				}
			})
		})
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/interactions.block-actions.ts
function readOptionValues(options) {
	if (!Array.isArray(options)) return;
	const values = options.map((option) => option && typeof option === "object" ? option.value : null).filter((value) => typeof value === "string" && value.trim().length > 0);
	return values.length > 0 ? values : void 0;
}
function readOptionLabels(options) {
	if (!Array.isArray(options)) return;
	const labels = options.map((option) => option && typeof option === "object" ? option.text?.text ?? null : null).filter((label) => typeof label === "string" && label.trim().length > 0);
	return labels.length > 0 ? labels : void 0;
}
function uniqueNonEmptyStrings(values) {
	const unique = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of values) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		unique.push(trimmed);
	}
	return unique;
}
function collectRichTextFragments(value, out) {
	if (!value || typeof value !== "object") return;
	const typed = value;
	if (typeof typed.text === "string" && typed.text.trim().length > 0) out.push(typed.text.trim());
	if (Array.isArray(typed.elements)) for (const child of typed.elements) collectRichTextFragments(child, out);
}
function summarizeRichTextPreview(value) {
	const fragments = [];
	collectRichTextFragments(value, fragments);
	if (fragments.length === 0) return;
	const joined = fragments.join(" ").replace(/\s+/g, " ").trim();
	if (!joined) return;
	const max = 120;
	return joined.length <= max ? joined : `${joined.slice(0, max - 1)}…`;
}
function readInteractionAction(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	return raw;
}
function summarizeAction(action) {
	const typed = action;
	const actionType = typed.type;
	const selectedUsers = uniqueNonEmptyStrings([...typed.selected_user ? [typed.selected_user] : [], ...Array.isArray(typed.selected_users) ? typed.selected_users : []]);
	const selectedChannels = uniqueNonEmptyStrings([...typed.selected_channel ? [typed.selected_channel] : [], ...Array.isArray(typed.selected_channels) ? typed.selected_channels : []]);
	const selectedConversations = uniqueNonEmptyStrings([...typed.selected_conversation ? [typed.selected_conversation] : [], ...Array.isArray(typed.selected_conversations) ? typed.selected_conversations : []]);
	const selectedValues = uniqueNonEmptyStrings([
		...typed.selected_option?.value ? [typed.selected_option.value] : [],
		...readOptionValues(typed.selected_options) ?? [],
		...selectedUsers,
		...selectedChannels,
		...selectedConversations
	]);
	const selectedLabels = uniqueNonEmptyStrings([...typed.selected_option?.text?.text ? [typed.selected_option.text.text] : [], ...readOptionLabels(typed.selected_options) ?? []]);
	const inputValue = typeof typed.value === "string" ? typed.value : void 0;
	const inputNumber = actionType === "number_input" && inputValue != null ? Number.parseFloat(inputValue) : void 0;
	const parsedNumber = Number.isFinite(inputNumber) ? inputNumber : void 0;
	const inputEmail = actionType === "email_text_input" && inputValue?.includes("@") ? inputValue : void 0;
	let inputUrl;
	if (actionType === "url_text_input" && inputValue) try {
		inputUrl = new URL(inputValue).toString();
	} catch {
		inputUrl = void 0;
	}
	const richTextValue = actionType === "rich_text_input" ? typed.rich_text_value : void 0;
	const richTextPreview = summarizeRichTextPreview(richTextValue);
	return {
		actionType,
		inputKind: actionType === "number_input" ? "number" : actionType === "email_text_input" ? "email" : actionType === "url_text_input" ? "url" : actionType === "rich_text_input" ? "rich_text" : inputValue != null ? "text" : void 0,
		value: typed.value,
		selectedValues: selectedValues.length > 0 ? selectedValues : void 0,
		selectedUsers: selectedUsers.length > 0 ? selectedUsers : void 0,
		selectedChannels: selectedChannels.length > 0 ? selectedChannels : void 0,
		selectedConversations: selectedConversations.length > 0 ? selectedConversations : void 0,
		selectedLabels: selectedLabels.length > 0 ? selectedLabels : void 0,
		selectedDate: typed.selected_date,
		selectedTime: typed.selected_time,
		selectedDateTime: typeof typed.selected_date_time === "number" ? typed.selected_date_time : void 0,
		inputValue,
		inputNumber: parsedNumber,
		inputEmail,
		inputUrl,
		richTextValue,
		richTextPreview,
		workflowTriggerUrl: typed.workflow?.trigger_url,
		workflowId: typed.workflow?.workflow_id
	};
}
function isBulkActionsBlock(block) {
	return block.type === "actions" && Array.isArray(block.elements) && block.elements.length > 0 && block.elements.every((el) => typeof el.action_id === "string" && el.action_id.includes("_all_"));
}
function formatInteractionSelectionLabel(params) {
	if (params.summary.actionType === "button" && params.buttonText?.trim()) return params.buttonText.trim();
	if (params.summary.selectedLabels?.length) {
		if (params.summary.selectedLabels.length <= 3) return params.summary.selectedLabels.join(", ");
		return `${params.summary.selectedLabels.slice(0, 3).join(", ")} +${params.summary.selectedLabels.length - 3}`;
	}
	if (params.summary.selectedValues?.length) {
		if (params.summary.selectedValues.length <= 3) return params.summary.selectedValues.join(", ");
		return `${params.summary.selectedValues.slice(0, 3).join(", ")} +${params.summary.selectedValues.length - 3}`;
	}
	if (params.summary.selectedDate) return params.summary.selectedDate;
	if (params.summary.selectedTime) return params.summary.selectedTime;
	if (typeof params.summary.selectedDateTime === "number") return (/* @__PURE__ */ new Date(params.summary.selectedDateTime * 1e3)).toISOString();
	if (params.summary.richTextPreview) return params.summary.richTextPreview;
	if (params.summary.value?.trim()) return params.summary.value.trim();
	return params.actionId;
}
function formatInteractionConfirmationText(params) {
	const userId = normalizeOptionalString(params.userId);
	const actor = userId ? ` by <@${userId}>` : "";
	return `:white_check_mark: *${escapeSlackMrkdwn(params.selectedLabel)}* selected${actor}`;
}
function buildSlackPluginInteractionData(params) {
	const actionId = normalizeOptionalString(params.actionId) ?? "";
	if (!actionId) return null;
	const payload = normalizeOptionalString(params.summary.value) || params.summary.selectedValues?.map((value) => normalizeOptionalString(value)).find(Boolean) || "";
	if (actionId === "openclaw:reply_button" || actionId === "openclaw:reply_select" || actionId.startsWith(`openclaw:reply_button:`) || actionId.startsWith(`openclaw:reply_select:`)) return payload || null;
	return payload ? `${actionId}:${payload}` : actionId;
}
function isSlackReplyActionId(actionId) {
	return actionId === "openclaw:reply_button" || actionId === "openclaw:reply_select" || actionId.startsWith(`openclaw:reply_button:`) || actionId.startsWith(`openclaw:reply_select:`);
}
function buildSlackPluginInteractionId(params) {
	const primaryValue = normalizeOptionalString(params.summary.value) || params.summary.selectedValues?.map((value) => normalizeOptionalString(value)).find(Boolean) || "";
	return [
		normalizeOptionalString(params.userId) ?? "",
		normalizeOptionalString(params.channelId) ?? "",
		normalizeOptionalString(params.messageTs) ?? "",
		normalizeOptionalString(params.triggerId) ?? "",
		normalizeOptionalString(params.actionId) ?? "",
		primaryValue
	].join(":");
}
function parseSlackBlockAction(params) {
	const typedBody = params.body;
	const typedAction = readInteractionAction(params.action);
	if (!typedAction) {
		params.log?.(`slack:interaction malformed action payload channel=${typedBody.channel?.id ?? typedBody.container?.channel_id ?? "unknown"} user=${typedBody.user?.id ?? "unknown"}`);
		return null;
	}
	const typedActionWithText = typedAction;
	return {
		typedBody,
		typedAction,
		typedActionWithText,
		actionId: typeof typedActionWithText.action_id === "string" ? typedActionWithText.action_id : "unknown",
		blockId: typedActionWithText.block_id,
		userId: typedBody.user?.id ?? "unknown",
		channelId: typedBody.channel?.id ?? typedBody.container?.channel_id,
		messageTs: typedBody.message?.ts ?? typedBody.container?.message_ts,
		threadTs: typedBody.container?.thread_ts,
		actionSummary: summarizeAction(typedAction)
	};
}
async function respondEphemeral(respond, text) {
	if (!respond) return;
	try {
		await respond({
			text,
			response_type: "ephemeral"
		});
	} catch {}
}
async function updateSlackInteractionMessage(params) {
	if (!params.channelId || !params.messageTs) return;
	await params.ctx.app.client.chat.update({
		channel: params.channelId,
		ts: params.messageTs,
		text: params.text,
		...params.blocks ? { blocks: params.blocks } : {}
	});
}
async function authorizeSlackBlockAction(params) {
	const auth = await authorizeSlackSystemEventSender({
		ctx: params.ctx,
		senderId: params.parsed.userId,
		channelId: params.parsed.channelId,
		expectedSenderId: params.parsed.userId,
		interactiveEvent: true
	});
	if (auth.allowed) return auth;
	params.ctx.runtime.log?.(`slack:interaction drop action=${params.parsed.actionId} user=${params.parsed.userId} channel=${params.parsed.channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`);
	await respondEphemeral(params.respond, "You are not authorized to use this control.");
	return { allowed: false };
}
async function handleSlackPluginBindingApproval(params) {
	const pluginBindingApproval = parsePluginBindingApprovalCustomId(params.pluginInteractionData);
	if (!pluginBindingApproval) return false;
	const resolved = await resolvePluginConversationBindingApproval({
		approvalId: pluginBindingApproval.approvalId,
		decision: pluginBindingApproval.decision,
		senderId: params.parsed.userId
	});
	try {
		await updateSlackInteractionMessage({
			ctx: params.ctx,
			channelId: params.parsed.channelId,
			messageTs: params.parsed.messageTs,
			text: params.parsed.typedBody.message?.text ?? "",
			blocks: []
		});
	} catch {}
	await respondEphemeral(params.respond, buildPluginBindingResolvedText(resolved));
	return true;
}
async function handleSlackExecApprovalInteraction(params) {
	const approval = parseExecApprovalCommandText(params.pluginInteractionData);
	if (!approval) return false;
	const pluginApprovalAuthorizedSender = isSlackExecApprovalApprover({
		cfg: params.ctx.cfg,
		accountId: params.ctx.accountId,
		senderId: params.parsed.userId
	});
	const execApprovalAuthorizedSender = isSlackExecApprovalAuthorizedSender({
		cfg: params.ctx.cfg,
		accountId: params.ctx.accountId,
		senderId: params.parsed.userId
	});
	if (!(approval.approvalId.startsWith("plugin:") ? pluginApprovalAuthorizedSender : execApprovalAuthorizedSender || pluginApprovalAuthorizedSender)) {
		params.ctx.runtime.log?.(`slack:interaction drop exec approval user=${params.parsed.userId} (not authorized)`);
		await respondEphemeral(params.respond, "You are not authorized to approve this request.");
		return true;
	}
	try {
		await resolveApprovalOverGateway({
			cfg: params.ctx.cfg,
			approvalId: approval.approvalId,
			decision: approval.decision,
			senderId: params.parsed.userId,
			allowPluginFallback: pluginApprovalAuthorizedSender,
			clientDisplayName: `Slack approval (${params.parsed.userId.trim() || "unknown"})`
		});
	} catch (error) {
		params.ctx.runtime.log?.(`slack:interaction exec approval resolve failed id=${approval.approvalId}: ${String(error)}`);
		throw error;
	}
	try {
		await updateSlackInteractionMessage({
			ctx: params.ctx,
			channelId: params.parsed.channelId,
			messageTs: params.parsed.messageTs,
			text: params.parsed.typedBody.message?.text ?? "",
			blocks: []
		});
	} catch {}
	return true;
}
async function dispatchSlackPluginInteraction(params) {
	const pluginInteractionId = buildSlackPluginInteractionId({
		userId: params.parsed.userId,
		channelId: params.parsed.channelId,
		messageTs: params.parsed.messageTs,
		triggerId: params.parsed.typedBody.trigger_id,
		actionId: params.parsed.actionId,
		summary: params.parsed.actionSummary
	});
	if (await handleSlackPluginBindingApproval({
		ctx: params.ctx,
		parsed: params.parsed,
		pluginInteractionData: params.pluginInteractionData,
		respond: params.respond
	})) return true;
	const pluginResult = await dispatchSlackPluginInteractiveHandler({
		data: params.pluginInteractionData,
		interactionId: pluginInteractionId,
		ctx: {
			accountId: params.ctx.accountId,
			interactionId: pluginInteractionId,
			conversationId: params.parsed.channelId ?? "",
			parentConversationId: void 0,
			threadId: params.parsed.threadTs,
			senderId: params.parsed.userId,
			senderUsername: void 0,
			auth: params.auth,
			interaction: {
				kind: params.parsed.actionSummary.actionType === "button" ? "button" : "select",
				actionId: params.parsed.actionId,
				blockId: params.parsed.blockId,
				messageTs: params.parsed.messageTs,
				threadTs: params.parsed.threadTs,
				value: params.parsed.actionSummary.value,
				selectedValues: params.parsed.actionSummary.selectedValues,
				selectedLabels: params.parsed.actionSummary.selectedLabels,
				triggerId: params.parsed.typedBody.trigger_id,
				responseUrl: params.parsed.typedBody.response_url
			}
		},
		respond: {
			acknowledge: async () => {},
			reply: async ({ text, responseType }) => {
				if (!text) return;
				await params.respond?.({
					text,
					response_type: responseType ?? "ephemeral"
				});
			},
			followUp: async ({ text, responseType }) => {
				if (!text) return;
				await params.respond?.({
					text,
					response_type: responseType ?? "ephemeral"
				});
			},
			editMessage: async ({ text, blocks }) => {
				await updateSlackInteractionMessage({
					ctx: params.ctx,
					channelId: params.parsed.channelId,
					messageTs: params.parsed.messageTs,
					text: text ?? params.parsed.typedBody.message?.text ?? "",
					blocks: Array.isArray(blocks) ? blocks : void 0
				});
			}
		}
	});
	return pluginResult.matched && pluginResult.handled;
}
async function resolveSlackBlockActionCommandAuthorized(params) {
	const commandsAllowFrom = params.ctx.cfg.commands?.allowFrom;
	if (commandsAllowFrom != null && typeof commandsAllowFrom === "object" && (Array.isArray(commandsAllowFrom.slack) || Array.isArray(commandsAllowFrom["*"]))) return resolveCommandAuthorization({
		ctx: {
			Provider: "slack",
			Surface: "slack",
			OriginatingChannel: "slack",
			AccountId: params.ctx.accountId,
			ChatType: params.auth.channelType === "im" ? "direct" : "group",
			From: params.parsed.channelId ? `slack:${params.parsed.channelId}` : "slack",
			SenderId: params.parsed.userId
		},
		cfg: params.ctx.cfg,
		commandAuthorized: false
	}).isAuthorizedSender;
	const isDirectMessage = params.auth.channelType === "im";
	const isRoom = params.auth.channelType === "channel" || params.auth.channelType === "group";
	const allowFromLower = await resolveSlackEffectiveAllowFrom(params.ctx, { includePairingStore: isDirectMessage });
	const senderName = (await params.ctx.resolveUserName(params.parsed.userId).catch(() => void 0))?.name;
	let channelUsers = [];
	if (isRoom && params.parsed.channelId) {
		const channelConfig = resolveSlackChannelConfig({
			channelId: params.parsed.channelId,
			channelName: params.auth.channelName,
			channels: params.ctx.channelsConfig,
			channelKeys: params.ctx.channelsConfigKeys,
			defaultRequireMention: params.ctx.defaultRequireMention,
			allowNameMatching: params.ctx.allowNameMatching
		});
		channelUsers = Array.isArray(channelConfig?.users) ? channelConfig.users : [];
	}
	return (await resolveSlackCommandIngress({
		ctx: params.ctx,
		senderId: params.parsed.userId,
		senderName,
		channelType: params.auth.channelType ?? "channel",
		channelId: params.parsed.channelId ?? "slack-interaction",
		ownerAllowFromLower: allowFromLower,
		channelUsers,
		allowTextCommands: false,
		hasControlCommand: true,
		eventKind: "button",
		modeWhenAccessGroupsOff: "configured"
	})).commandAccess.authorized;
}
function enqueueSlackBlockActionEvent(params) {
	const eventPayload = {
		interactionType: "block_action",
		actionId: params.parsed.actionId,
		blockId: params.parsed.blockId,
		...params.parsed.actionSummary,
		userId: params.parsed.userId,
		teamId: params.parsed.typedBody.team?.id,
		triggerId: params.parsed.typedBody.trigger_id,
		responseUrl: params.parsed.typedBody.response_url,
		channelId: params.parsed.channelId,
		messageTs: params.parsed.messageTs,
		threadTs: params.parsed.threadTs
	};
	params.ctx.runtime.log?.(`slack:interaction action=${params.parsed.actionId} type=${params.parsed.actionSummary.actionType ?? "unknown"} user=${params.parsed.userId} channel=${params.parsed.channelId}`);
	const sessionKey = params.ctx.resolveSlackSystemEventSessionKey({
		channelId: params.parsed.channelId,
		channelType: params.auth.channelType,
		senderId: params.parsed.userId,
		threadTs: params.parsed.threadTs
	});
	const contextParts = [
		"slack:interaction",
		params.parsed.channelId,
		params.parsed.messageTs,
		params.parsed.actionId
	].filter(Boolean);
	if (enqueueSystemEvent(params.formatSystemEvent(eventPayload), {
		sessionKey,
		contextKey: contextParts.join(":"),
		deliveryContext: {
			channel: "slack",
			to: params.auth.channelType === "im" ? `user:${params.parsed.userId}` : params.parsed.channelId ? `channel:${params.parsed.channelId}` : void 0,
			accountId: params.ctx.accountId,
			threadId: params.parsed.threadTs
		},
		trusted: false
	})) requestHeartbeat({
		source: "hook",
		intent: "immediate",
		reason: "hook:slack-interaction",
		sessionKey,
		heartbeat: { target: "last" }
	});
}
function buildSlackConfirmationBlocks(params) {
	const selectedLabel = formatInteractionSelectionLabel({
		actionId: params.parsed.actionId,
		summary: params.parsed.actionSummary,
		buttonText: params.parsed.typedActionWithText.text?.text
	});
	let updatedBlocks = params.originalBlocks.map((block) => {
		const typedBlock = block;
		if (typedBlock.type === "actions" && typedBlock.block_id === params.parsed.blockId) return {
			type: "context",
			elements: [{
				type: "mrkdwn",
				text: formatInteractionConfirmationText({
					selectedLabel,
					userId: params.parsed.userId
				})
			}]
		};
		return block;
	});
	if (!updatedBlocks.some((block) => {
		const typedBlock = block;
		return typedBlock.type === "actions" && !isBulkActionsBlock(typedBlock);
	})) updatedBlocks = updatedBlocks.filter((block, index) => {
		const typedBlock = block;
		if (isBulkActionsBlock(typedBlock)) return false;
		if (typedBlock.type !== "divider") return true;
		const next = updatedBlocks[index + 1];
		return !next || !isBulkActionsBlock(next);
	});
	return updatedBlocks;
}
async function updateSlackLegacyBlockAction(params) {
	const originalBlocks = params.parsed.typedBody.message?.blocks;
	if (!Array.isArray(originalBlocks) || !params.parsed.channelId || !params.parsed.messageTs || !params.parsed.blockId) return;
	try {
		await updateSlackInteractionMessage({
			ctx: params.ctx,
			channelId: params.parsed.channelId,
			messageTs: params.parsed.messageTs,
			text: params.parsed.typedBody.message?.text ?? "",
			blocks: buildSlackConfirmationBlocks({
				parsed: params.parsed,
				originalBlocks
			})
		});
	} catch {
		await respondEphemeral(params.respond, `Button "${params.parsed.actionId}" clicked!`);
	}
}
async function handleSlackBlockAction(params) {
	const { ack, body, action, respond } = params.args;
	await ack();
	if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
		params.ctx.runtime.log?.("slack:interaction drop block action payload (mismatched app/team)");
		return;
	}
	const parsed = parseSlackBlockAction({
		body,
		action,
		log: params.ctx.runtime.log
	});
	if (!parsed) return;
	params.trackEvent?.();
	const pluginInteractionData = buildSlackPluginInteractionData({
		actionId: parsed.actionId,
		summary: parsed.actionSummary
	});
	if (pluginInteractionData && isSlackReplyActionId(parsed.actionId)) {
		if (await handleSlackExecApprovalInteraction({
			ctx: params.ctx,
			parsed,
			pluginInteractionData,
			respond
		})) return;
	}
	const auth = await authorizeSlackBlockAction({
		ctx: params.ctx,
		parsed,
		respond
	});
	if (!auth.allowed) return;
	if (pluginInteractionData && isSlackReplyActionId(parsed.actionId)) {
		if (await handleSlackPluginBindingApproval({
			ctx: params.ctx,
			parsed,
			pluginInteractionData,
			respond
		})) return;
	} else if (pluginInteractionData) {
		const isAuthorizedSender = await resolveSlackBlockActionCommandAuthorized({
			ctx: params.ctx,
			parsed,
			auth
		});
		if (await dispatchSlackPluginInteraction({
			ctx: params.ctx,
			parsed,
			pluginInteractionData,
			auth: { isAuthorizedSender },
			respond
		})) return;
	}
	enqueueSlackBlockActionEvent({
		ctx: params.ctx,
		parsed,
		auth,
		formatSystemEvent: params.formatSystemEvent
	});
	await updateSlackLegacyBlockAction({
		ctx: params.ctx,
		parsed,
		respond
	});
}
function registerSlackBlockActionHandler(params) {
	if (typeof params.ctx.app.action !== "function") return;
	params.ctx.app.action(/.+/, async (args) => {
		await handleSlackBlockAction({
			ctx: params.ctx,
			trackEvent: params.trackEvent,
			args,
			formatSystemEvent: params.formatSystemEvent
		});
	});
}
//#endregion
//#region extensions/slack/src/modal-metadata.ts
function parseSlackModalPrivateMetadata(raw) {
	if (typeof raw !== "string" || raw.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(raw);
		return {
			sessionKey: normalizeOptionalString(parsed.sessionKey),
			channelId: normalizeOptionalString(parsed.channelId),
			channelType: normalizeOptionalString(parsed.channelType),
			userId: normalizeOptionalString(parsed.userId)
		};
	} catch {
		return {};
	}
}
//#endregion
//#region extensions/slack/src/monitor/events/interactions.modal.ts
function resolveModalSessionRouting(params) {
	const metadata = params.metadata;
	if (metadata.sessionKey) return {
		sessionKey: metadata.sessionKey,
		channelId: metadata.channelId,
		channelType: metadata.channelType
	};
	if (metadata.channelId) return {
		sessionKey: params.ctx.resolveSlackSystemEventSessionKey({
			channelId: metadata.channelId,
			channelType: metadata.channelType,
			senderId: params.userId
		}),
		channelId: metadata.channelId,
		channelType: metadata.channelType
	};
	return { sessionKey: params.ctx.resolveSlackSystemEventSessionKey({}) };
}
function summarizeSlackViewLifecycleContext(view) {
	const rootViewId = view.root_view_id;
	const previousViewId = view.previous_view_id;
	return {
		rootViewId,
		previousViewId,
		externalId: view.external_id,
		viewHash: view.hash,
		isStackedView: Boolean(previousViewId)
	};
}
function resolveSlackModalEventBase(params) {
	const metadata = parseSlackModalPrivateMetadata(params.body.view?.private_metadata);
	const callbackId = params.body.view?.callback_id ?? "unknown";
	const userId = params.body.user?.id ?? "unknown";
	const viewId = params.body.view?.id;
	const inputs = params.summarizeViewState(params.body.view?.state?.values);
	const sessionRouting = resolveModalSessionRouting({
		ctx: params.ctx,
		metadata,
		userId
	});
	return {
		callbackId,
		userId,
		expectedUserId: metadata.userId,
		viewId,
		sessionRouting,
		payload: {
			actionId: `view:${callbackId}`,
			callbackId,
			viewId,
			userId,
			teamId: params.body.team?.id,
			...summarizeSlackViewLifecycleContext({
				root_view_id: params.body.view?.root_view_id,
				previous_view_id: params.body.view?.previous_view_id,
				external_id: params.body.view?.external_id,
				hash: params.body.view?.hash
			}),
			privateMetadata: params.body.view?.private_metadata,
			routedChannelId: sessionRouting.channelId,
			routedChannelType: sessionRouting.channelType,
			inputs
		}
	};
}
async function emitSlackModalLifecycleEvent(params) {
	const { callbackId, userId, expectedUserId, viewId, sessionRouting, payload } = resolveSlackModalEventBase({
		ctx: params.ctx,
		body: params.body,
		summarizeViewState: params.summarizeViewState
	});
	const isViewClosed = params.interactionType === "view_closed";
	const isCleared = params.body.is_cleared === true;
	const eventPayload = isViewClosed ? {
		interactionType: params.interactionType,
		...payload,
		isCleared
	} : {
		interactionType: params.interactionType,
		...payload
	};
	if (isViewClosed) params.ctx.runtime.log?.(`slack:interaction view_closed callback=${callbackId} user=${userId} cleared=${isCleared}`);
	else params.ctx.runtime.log?.(`slack:interaction view_submission callback=${callbackId} user=${userId} inputs=${payload.inputs.length}`);
	if (!expectedUserId) {
		params.ctx.runtime.log?.(`slack:interaction drop modal callback=${callbackId} user=${userId} reason=missing-expected-user`);
		return;
	}
	const auth = await authorizeSlackSystemEventSender({
		ctx: params.ctx,
		senderId: userId,
		channelId: sessionRouting.channelId,
		channelType: sessionRouting.channelType,
		expectedSenderId: expectedUserId,
		interactiveEvent: true
	});
	if (!auth.allowed) {
		params.ctx.runtime.log?.(`slack:interaction drop modal callback=${callbackId} user=${userId} reason=${auth.reason ?? "unauthorized"}`);
		return;
	}
	enqueueSystemEvent(params.formatSystemEvent(eventPayload), {
		sessionKey: sessionRouting.sessionKey,
		contextKey: [
			params.contextPrefix,
			callbackId,
			viewId,
			userId
		].filter(Boolean).join(":")
	});
}
function registerModalLifecycleHandler(params) {
	params.register(params.matcher, async ({ ack, body }) => {
		await ack();
		if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
			params.ctx.runtime.log?.(`slack:interaction drop ${params.interactionType} payload (mismatched app/team)`);
			return;
		}
		params.trackEvent?.();
		await emitSlackModalLifecycleEvent({
			ctx: params.ctx,
			body,
			interactionType: params.interactionType,
			contextPrefix: params.contextPrefix,
			summarizeViewState: params.summarizeViewState,
			formatSystemEvent: params.formatSystemEvent
		});
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/interactions.ts
const OPENCLAW_ACTION_PREFIX = "openclaw:";
const SLACK_INTERACTION_EVENT_PREFIX = "Slack interaction: ";
const REDACTED_INTERACTION_VALUE = "[redacted]";
const SLACK_INTERACTION_EVENT_MAX_CHARS = 2400;
const SLACK_INTERACTION_STRING_MAX_CHARS = 160;
const SLACK_INTERACTION_ARRAY_MAX_ITEMS = 64;
const SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS = 3;
const SLACK_INTERACTION_REDACTED_KEYS = new Set([
	"triggerId",
	"responseUrl",
	"workflowTriggerUrl",
	"privateMetadata",
	"viewHash"
]);
function sanitizeSlackInteractionPayloadValue(value, key) {
	if (value === void 0) return;
	if (key && SLACK_INTERACTION_REDACTED_KEYS.has(key)) {
		if (typeof value !== "string" || value.trim().length === 0) return;
		return REDACTED_INTERACTION_VALUE;
	}
	if (typeof value === "string") return truncateSlackText(value, SLACK_INTERACTION_STRING_MAX_CHARS);
	if (Array.isArray(value)) {
		const sanitized = value.slice(0, SLACK_INTERACTION_ARRAY_MAX_ITEMS).map((entry) => sanitizeSlackInteractionPayloadValue(entry)).filter((entry) => entry !== void 0);
		if (value.length > SLACK_INTERACTION_ARRAY_MAX_ITEMS) sanitized.push(`…+${value.length - SLACK_INTERACTION_ARRAY_MAX_ITEMS} more`);
		return sanitized;
	}
	if (!value || typeof value !== "object") return value;
	const output = {};
	for (const [entryKey, entryValue] of Object.entries(value)) {
		const sanitized = sanitizeSlackInteractionPayloadValue(entryValue, entryKey);
		if (sanitized === void 0) continue;
		if (typeof sanitized === "string" && sanitized.length === 0) continue;
		if (Array.isArray(sanitized) && sanitized.length === 0) continue;
		output[entryKey] = sanitized;
	}
	return output;
}
function buildCompactSlackInteractionPayload(payload) {
	const rawInputs = Array.isArray(payload.inputs) ? payload.inputs : [];
	const compactInputs = rawInputs.slice(0, SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS).flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const typed = entry;
		return [{
			actionId: typed.actionId,
			blockId: typed.blockId,
			actionType: typed.actionType,
			inputKind: typed.inputKind,
			selectedValues: typed.selectedValues,
			selectedLabels: typed.selectedLabels,
			inputValue: typed.inputValue,
			inputNumber: typed.inputNumber,
			selectedDate: typed.selectedDate,
			selectedTime: typed.selectedTime,
			selectedDateTime: typed.selectedDateTime,
			richTextPreview: typed.richTextPreview
		}];
	});
	return {
		interactionType: payload.interactionType,
		actionId: payload.actionId,
		callbackId: payload.callbackId,
		actionType: payload.actionType,
		userId: payload.userId,
		teamId: payload.teamId,
		channelId: payload.channelId ?? payload.routedChannelId,
		messageTs: payload.messageTs,
		threadTs: payload.threadTs,
		viewId: payload.viewId,
		isCleared: payload.isCleared,
		selectedValues: payload.selectedValues,
		selectedLabels: payload.selectedLabels,
		selectedDate: payload.selectedDate,
		selectedTime: payload.selectedTime,
		selectedDateTime: payload.selectedDateTime,
		workflowId: payload.workflowId,
		routedChannelType: payload.routedChannelType,
		inputs: compactInputs.length > 0 ? compactInputs : void 0,
		inputsOmitted: rawInputs.length > SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS ? rawInputs.length - SLACK_INTERACTION_COMPACT_INPUTS_MAX_ITEMS : void 0,
		payloadTruncated: true
	};
}
function formatSlackInteractionSystemEvent(payload) {
	const toEventText = (value) => `${SLACK_INTERACTION_EVENT_PREFIX}${JSON.stringify(value)}`;
	const sanitizedPayload = sanitizeSlackInteractionPayloadValue(payload) ?? {};
	let eventText = toEventText(sanitizedPayload);
	if (eventText.length <= SLACK_INTERACTION_EVENT_MAX_CHARS) return eventText;
	eventText = toEventText(sanitizeSlackInteractionPayloadValue(buildCompactSlackInteractionPayload(sanitizedPayload)));
	if (eventText.length <= SLACK_INTERACTION_EVENT_MAX_CHARS) return eventText;
	return toEventText({
		interactionType: sanitizedPayload.interactionType,
		actionId: sanitizedPayload.actionId ?? "unknown",
		userId: sanitizedPayload.userId,
		channelId: sanitizedPayload.channelId ?? sanitizedPayload.routedChannelId,
		payloadTruncated: true
	});
}
function summarizeViewState(values) {
	if (!values || typeof values !== "object") return [];
	const entries = [];
	for (const [blockId, blockValue] of Object.entries(values)) {
		if (!blockValue || typeof blockValue !== "object") continue;
		for (const [actionId, rawAction] of Object.entries(blockValue)) {
			if (!rawAction || typeof rawAction !== "object") continue;
			const actionSummary = summarizeAction(rawAction);
			entries.push({
				blockId,
				actionId,
				...actionSummary
			});
		}
	}
	return entries;
}
function registerSlackInteractionEvents(params) {
	const { ctx, trackEvent } = params;
	registerSlackBlockActionHandler({
		ctx,
		trackEvent,
		formatSystemEvent: formatSlackInteractionSystemEvent
	});
	if (typeof ctx.app.view !== "function") return;
	const modalMatcher = new RegExp(`^${OPENCLAW_ACTION_PREFIX}`);
	registerModalLifecycleHandler({
		register: (matcher, handler) => ctx.app.view(matcher, handler),
		matcher: modalMatcher,
		ctx,
		trackEvent,
		interactionType: "view_submission",
		contextPrefix: "slack:interaction:view",
		summarizeViewState,
		formatSystemEvent: formatSlackInteractionSystemEvent
	});
	const viewClosed = ctx.app.viewClosed;
	if (typeof viewClosed !== "function") return;
	registerModalLifecycleHandler({
		register: viewClosed,
		matcher: modalMatcher,
		ctx,
		trackEvent,
		interactionType: "view_closed",
		contextPrefix: "slack:interaction:view-closed",
		summarizeViewState,
		formatSystemEvent: formatSlackInteractionSystemEvent
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/system-event-context.ts
async function authorizeAndResolveSlackSystemEventContext(params) {
	const { ctx, senderId, channelId, channelType, eventKind } = params;
	const auth = await authorizeSlackSystemEventSender({
		ctx,
		senderId,
		channelId,
		channelType
	});
	if (!auth.allowed) {
		logVerbose(`slack: drop ${eventKind} sender ${senderId ?? "unknown"} channel=${channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`);
		return;
	}
	return {
		channelLabel: resolveSlackChannelLabel({
			channelId,
			channelName: auth.channelName
		}),
		sessionKey: ctx.resolveSlackSystemEventSessionKey({
			channelId,
			channelType: auth.channelType,
			senderId
		})
	};
}
//#endregion
//#region extensions/slack/src/monitor/events/members.ts
function registerSlackMemberEvents(params) {
	const { ctx, trackEvent } = params;
	const handleMemberChannelEvent = async (params) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(params.body)) return;
			trackEvent?.();
			const payload = params.event;
			const channelId = payload.channel;
			const channelInfo = channelId ? await ctx.resolveChannelName(channelId) : {};
			const channelType = payload.channel_type ?? channelInfo?.type;
			const ingressContext = await authorizeAndResolveSlackSystemEventContext({
				ctx,
				senderId: payload.user,
				channelId,
				channelType,
				eventKind: `member-${params.verb}`
			});
			if (!ingressContext) return;
			enqueueSystemEvent(`Slack: ${(payload.user ? await ctx.resolveUserName(payload.user) : {})?.name ?? payload.user ?? "someone"} ${params.verb} ${ingressContext.channelLabel}.`, {
				sessionKey: ingressContext.sessionKey,
				contextKey: `slack:member:${params.verb}:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack ${params.verb} handler failed: ${formatErrorMessage(err)}`));
		}
	};
	ctx.app.event("member_joined_channel", async ({ event, body }) => {
		await handleMemberChannelEvent({
			verb: "joined",
			event,
			body
		});
	});
	ctx.app.event("member_left_channel", async ({ event, body }) => {
		await handleMemberChannelEvent({
			verb: "left",
			event,
			body
		});
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/message-subtype-handlers.ts
const SUBTYPE_HANDLER_REGISTRY = {
	message_changed: {
		subtype: "message_changed",
		eventKind: "message_changed",
		describe: (channelLabel) => `Slack message edited in ${channelLabel}.`,
		contextKey: (event) => {
			const changed = event;
			return `slack:message:changed:${changed.channel ?? "unknown"}:${changed.message?.ts ?? changed.previous_message?.ts ?? changed.event_ts ?? "unknown"}`;
		},
		resolveSenderId: (event) => {
			const changed = event;
			return changed.message?.user ?? changed.previous_message?.user ?? changed.message?.bot_id ?? changed.previous_message?.bot_id;
		},
		resolveChannelId: (event) => event.channel,
		resolveChannelType: () => void 0
	},
	message_deleted: {
		subtype: "message_deleted",
		eventKind: "message_deleted",
		describe: (channelLabel) => `Slack message deleted in ${channelLabel}.`,
		contextKey: (event) => {
			const deleted = event;
			return `slack:message:deleted:${deleted.channel ?? "unknown"}:${deleted.deleted_ts ?? deleted.event_ts ?? "unknown"}`;
		},
		resolveSenderId: (event) => {
			const deleted = event;
			return deleted.previous_message?.user ?? deleted.previous_message?.bot_id;
		},
		resolveChannelId: (event) => event.channel,
		resolveChannelType: () => void 0
	}
};
function resolveSlackMessageSubtypeHandler(event) {
	const subtype = event.subtype;
	if (subtype !== "message_changed" && subtype !== "message_deleted") return;
	return SUBTYPE_HANDLER_REGISTRY[subtype];
}
//#endregion
//#region extensions/slack/src/monitor/events/messages.ts
function asRecord$1(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function asString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function isSlackUserId(value) {
	return /^[UW][A-Z0-9]+$/.test(value);
}
function addUserCandidate(candidates, value, botUserId) {
	const id = asString(value);
	if (!id || id === botUserId || !isSlackUserId(id)) return;
	candidates.add(id);
}
function collectMetadataUserCandidates(candidates, value, botUserId) {
	const payload = asRecord$1(asRecord$1(value)?.event_payload);
	if (!payload) return;
	for (const key of [
		"user",
		"user_id",
		"actor_user_id",
		"author_user_id",
		"slack_user_id"
	]) addUserCandidate(candidates, payload[key], botUserId);
}
function resolveAssistantMessageChangedSender(params) {
	const candidates = /* @__PURE__ */ new Set();
	collectMetadataUserCandidates(candidates, params.message?.metadata, params.botUserId);
	return candidates.size === 1 ? [...candidates][0] : void 0;
}
function isSelfAttributedMessageChange(params) {
	const topUser = asString(params.event.user);
	const messageUser = asString(params.message?.user);
	const messageBotId = asString(params.message?.bot_id);
	return Boolean(params.ctx.botUserId) && (topUser === params.ctx.botUserId || messageUser === params.ctx.botUserId) || Boolean(params.ctx.botId) && messageBotId === params.ctx.botId;
}
function resolveAssistantMessageChangedInbound(params) {
	if (params.event.subtype !== "message_changed") return;
	const changed = params.event;
	const message = asRecord$1(changed.message);
	if (!message || !isSelfAttributedMessageChange({
		event: changed,
		message,
		ctx: params.ctx
	})) return;
	if (normalizeSlackChannelType(asString(changed.channel_type), changed.channel) !== "im") return;
	const senderId = resolveAssistantMessageChangedSender({
		message,
		botUserId: params.ctx.botUserId
	});
	if (!senderId) return;
	return {
		type: "message",
		channel: changed.channel ?? params.event.channel,
		channel_type: "im",
		user: senderId,
		text: asString(message.text),
		ts: asString(message.ts) ?? asString(changed.event_ts),
		thread_ts: asString(message.thread_ts),
		event_ts: changed.event_ts,
		files: Array.isArray(message.files) ? message.files : void 0,
		attachments: Array.isArray(message.attachments) ? message.attachments : void 0
	};
}
function registerSlackMessageEvents(params) {
	const { ctx, handleSlackMessage } = params;
	const handleIncomingMessageEvent = async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			const message = event;
			const assistantChangedInbound = resolveAssistantMessageChangedInbound({
				event: message,
				ctx
			});
			if (assistantChangedInbound) {
				await handleSlackMessage(assistantChangedInbound, { source: "message" });
				return;
			}
			if (message.subtype === "message_changed" && isSelfAttributedMessageChange({
				event: message,
				message: asRecord$1(message.message),
				ctx
			})) return;
			const subtypeHandler = resolveSlackMessageSubtypeHandler(message);
			if (subtypeHandler) {
				const channelId = subtypeHandler.resolveChannelId(message);
				const ingressContext = await authorizeAndResolveSlackSystemEventContext({
					ctx,
					senderId: subtypeHandler.resolveSenderId(message),
					channelId,
					channelType: subtypeHandler.resolveChannelType(message),
					eventKind: subtypeHandler.eventKind
				});
				if (!ingressContext) return;
				enqueueSystemEvent(subtypeHandler.describe(ingressContext.channelLabel), {
					sessionKey: ingressContext.sessionKey,
					contextKey: subtypeHandler.contextKey(message)
				});
				return;
			}
			await handleSlackMessage(message, { source: "message" });
		} catch (err) {
			ctx.runtime.error?.(danger(`slack handler failed: ${formatErrorMessage(err)}`));
		}
	};
	ctx.app.event("message", async ({ event, body }) => {
		await handleIncomingMessageEvent({
			event,
			body
		});
	});
	ctx.app.event("app_mention", async ({ event, body }) => {
		try {
			if (ctx.shouldDropMismatchedSlackEvent(body)) return;
			const mention = event;
			const channelType = normalizeSlackChannelType(mention.channel_type, mention.channel);
			if (channelType === "im" || channelType === "mpim") return;
			await handleSlackMessage(mention, {
				source: "app_mention",
				wasMentioned: true
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack mention handler failed: ${formatErrorMessage(err)}`));
		}
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/pins.ts
async function handleSlackPinEvent(params) {
	const { ctx, trackEvent, body, event, action, contextKeySuffix, errorLabel } = params;
	try {
		if (ctx.shouldDropMismatchedSlackEvent(body)) return;
		trackEvent?.();
		const payload = event;
		const channelId = payload.channel_id;
		const ingressContext = await authorizeAndResolveSlackSystemEventContext({
			ctx,
			senderId: payload.user,
			channelId,
			eventKind: "pin"
		});
		if (!ingressContext) return;
		const userLabel = (payload.user ? await ctx.resolveUserName(payload.user) : {})?.name ?? payload.user ?? "someone";
		const itemType = payload.item?.type ?? "item";
		const messageId = payload.item?.message?.ts ?? payload.event_ts;
		enqueueSystemEvent(`Slack: ${userLabel} ${action} a ${itemType} in ${ingressContext.channelLabel}.`, {
			sessionKey: ingressContext.sessionKey,
			contextKey: `slack:pin:${contextKeySuffix}:${channelId ?? "unknown"}:${messageId ?? "unknown"}`
		});
	} catch (err) {
		ctx.runtime.error?.(danger(`slack ${errorLabel} handler failed: ${formatErrorMessage(err)}`));
	}
}
function registerSlackPinEvents(params) {
	const { ctx, trackEvent } = params;
	ctx.app.event("pin_added", async ({ event, body }) => {
		await handleSlackPinEvent({
			ctx,
			trackEvent,
			body,
			event,
			action: "pinned",
			contextKeySuffix: "added",
			errorLabel: "pin added"
		});
	});
	ctx.app.event("pin_removed", async ({ event, body }) => {
		await handleSlackPinEvent({
			ctx,
			trackEvent,
			body,
			event,
			action: "unpinned",
			contextKeySuffix: "removed",
			errorLabel: "pin removed"
		});
	});
}
//#endregion
//#region extensions/slack/src/monitor/events/reactions.ts
function registerSlackReactionEvents(params) {
	const { ctx, trackEvent } = params;
	const handleReactionEvent = async (event, action) => {
		try {
			const item = event.item;
			if (!item || item.type !== "message") return;
			trackEvent?.();
			const ingressContext = await authorizeAndResolveSlackSystemEventContext({
				ctx,
				senderId: event.user,
				channelId: item.channel,
				eventKind: "reaction"
			});
			if (!ingressContext) return;
			const actorInfoPromise = event.user ? ctx.resolveUserName(event.user) : Promise.resolve(void 0);
			const authorInfoPromise = event.item_user ? ctx.resolveUserName(event.item_user) : Promise.resolve(void 0);
			const [actorInfo, authorInfo] = await Promise.all([actorInfoPromise, authorInfoPromise]);
			const actorLabel = actorInfo?.name ?? event.user;
			const emojiLabel = event.reaction ?? "emoji";
			const authorLabel = authorInfo?.name ?? event.item_user;
			const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${ingressContext.channelLabel} msg ${item.ts}`;
			enqueueSystemEvent(authorLabel ? `${baseText} from ${authorLabel}` : baseText, {
				sessionKey: ingressContext.sessionKey,
				contextKey: `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}`
			});
		} catch (err) {
			ctx.runtime.error?.(danger(`slack reaction handler failed: ${formatErrorMessage(err)}`));
		}
	};
	ctx.app.event("reaction_added", async ({ event, body }) => {
		if (ctx.shouldDropMismatchedSlackEvent(body)) return;
		await handleReactionEvent(event, "added");
	});
	ctx.app.event("reaction_removed", async ({ event, body }) => {
		if (ctx.shouldDropMismatchedSlackEvent(body)) return;
		await handleReactionEvent(event, "removed");
	});
}
//#endregion
//#region extensions/slack/src/monitor/events.ts
function registerSlackMonitorEvents(params) {
	registerSlackMessageEvents({
		ctx: params.ctx,
		handleSlackMessage: params.handleSlackMessage
	});
	registerSlackReactionEvents({
		ctx: params.ctx,
		trackEvent: params.trackEvent
	});
	registerSlackMemberEvents({
		ctx: params.ctx,
		trackEvent: params.trackEvent
	});
	registerSlackChannelEvents({
		ctx: params.ctx,
		trackEvent: params.trackEvent
	});
	registerSlackPinEvents({
		ctx: params.ctx,
		trackEvent: params.trackEvent
	});
	registerSlackHomeEvents({
		ctx: params.ctx,
		trackEvent: params.trackEvent
	});
	registerSlackInteractionEvents({
		ctx: params.ctx,
		trackEvent: params.trackEvent
	});
}
//#endregion
//#region extensions/slack/src/monitor/message-handler/debounce-key.ts
function resolveSlackSenderId(message) {
	return message.user ?? message.bot_id ?? null;
}
function isSlackDirectMessageChannel(channelId) {
	return channelId.startsWith("D");
}
function isTopLevelSlackMessage(message) {
	return !message.thread_ts && !message.parent_user_id;
}
function buildTopLevelSlackConversationKey(message, accountId) {
	if (!isTopLevelSlackMessage(message)) return null;
	const senderId = resolveSlackSenderId(message);
	if (!senderId) return null;
	return `slack:${accountId}:${message.channel}:${senderId}`;
}
function buildSlackDebounceKey(message, accountId) {
	const senderId = resolveSlackSenderId(message);
	if (!senderId) return null;
	const messageTs = message.ts ?? message.event_ts;
	return `slack:${accountId}:${message.thread_ts ? `${message.channel}:${message.thread_ts}` : message.parent_user_id && messageTs ? `${message.channel}:maybe-thread:${messageTs}` : messageTs && !isSlackDirectMessageChannel(message.channel) ? `${message.channel}:${messageTs}` : message.channel}:${senderId}`;
}
//#endregion
//#region extensions/slack/src/monitor/thread-resolution.ts
const DEFAULT_THREAD_TS_CACHE_TTL_MS = 6e4;
const DEFAULT_THREAD_TS_CACHE_MAX = 500;
const normalizeThreadTs = (threadTs) => {
	const trimmed = threadTs?.trim();
	return trimmed ? trimmed : void 0;
};
const markAmbiguousThreadReply = (message) => ({
	...message,
	_ambiguousThreadReply: true
});
async function resolveThreadTsFromHistory(params) {
	try {
		const response = await params.client.conversations.history({
			channel: params.channelId,
			latest: params.messageTs,
			oldest: params.messageTs,
			inclusive: true,
			limit: 1
		});
		return normalizeThreadTs((response.messages?.find((entry) => entry.ts === params.messageTs) ?? response.messages?.[0])?.thread_ts);
	} catch (err) {
		if (shouldLogVerbose()) logVerbose(`slack inbound: failed to resolve thread_ts via conversations.history for channel=${params.channelId} ts=${params.messageTs}: ${formatSlackError(err)}`);
		return;
	}
}
function createSlackThreadTsResolver(params) {
	const ttlMs = Math.max(0, params.cacheTtlMs ?? DEFAULT_THREAD_TS_CACHE_TTL_MS);
	const maxSize = Math.max(0, params.maxSize ?? DEFAULT_THREAD_TS_CACHE_MAX);
	const cache = /* @__PURE__ */ new Map();
	const inflight = /* @__PURE__ */ new Map();
	const getCached = (key, now) => {
		const entry = cache.get(key);
		if (!entry) return;
		if (ttlMs > 0 && now - entry.updatedAt > ttlMs) {
			cache.delete(key);
			return;
		}
		cache.delete(key);
		cache.set(key, {
			...entry,
			updatedAt: now
		});
		return entry.threadTs;
	};
	const setCached = (key, threadTs, now) => {
		cache.delete(key);
		cache.set(key, {
			threadTs,
			updatedAt: now
		});
		pruneMapToMaxSize(cache, maxSize);
	};
	return { resolve: async (request) => {
		const { message } = request;
		if (!message.parent_user_id || message.thread_ts || !message.ts) return message;
		const cacheKey = `${message.channel}:${message.ts}`;
		const cached = getCached(cacheKey, Date.now());
		if (cached !== void 0) return cached ? {
			...message,
			thread_ts: cached
		} : markAmbiguousThreadReply(message);
		if (shouldLogVerbose()) logVerbose(`slack inbound: missing thread_ts for thread reply channel=${message.channel} ts=${message.ts} source=${request.source}`);
		let pending = inflight.get(cacheKey);
		if (!pending) {
			pending = resolveThreadTsFromHistory({
				client: params.client,
				channelId: message.channel,
				messageTs: message.ts
			});
			inflight.set(cacheKey, pending);
		}
		let resolved;
		try {
			resolved = await pending;
		} finally {
			inflight.delete(cacheKey);
		}
		setCached(cacheKey, resolved ?? null, Date.now());
		if (resolved) {
			if (shouldLogVerbose()) logVerbose(`slack inbound: resolved missing thread_ts channel=${message.channel} ts=${message.ts} -> thread_ts=${resolved}`);
			return {
				...message,
				thread_ts: resolved
			};
		}
		if (shouldLogVerbose()) logVerbose(`slack inbound: could not resolve missing thread_ts channel=${message.channel} ts=${message.ts}; marking reply ambiguous`);
		return markAmbiguousThreadReply(message);
	} };
}
//#endregion
//#region extensions/slack/src/monitor/message-handler.ts
let slackMessagePipelinePromise;
function loadSlackMessagePipeline() {
	slackMessagePipelinePromise ??= import("./pipeline.runtime.js");
	return slackMessagePipelinePromise;
}
const APP_MENTION_RETRY_TTL_MS = 6e4;
var SlackRetryableInboundError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "SlackRetryableInboundError";
	}
};
function shouldDebounceSlackMessage(message, cfg) {
	return shouldDebounceTextInbound({
		text: stripSlackMentionsForCommandDetection(message.text ?? ""),
		cfg,
		hasMedia: Boolean(message.files && message.files.length > 0)
	});
}
function buildSeenMessageKey(channelId, ts) {
	if (!channelId || !ts) return null;
	return `${channelId}:${ts}`;
}
function createSlackMessageHandler(params) {
	const { ctx, account, trackEvent } = params;
	const { debounceMs, debouncer } = createChannelInboundDebouncer({
		cfg: ctx.cfg,
		channel: "slack",
		buildKey: (entry) => buildSlackDebounceKey(entry.message, ctx.accountId),
		shouldDebounce: (entry) => shouldDebounceSlackMessage(entry.message, ctx.cfg),
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			const flushedKey = buildSlackDebounceKey(last.message, ctx.accountId);
			const topLevelConversationKey = buildTopLevelSlackConversationKey(last.message, ctx.accountId);
			if (flushedKey && topLevelConversationKey) {
				const pendingKeys = pendingTopLevelDebounceKeys.get(topLevelConversationKey);
				if (pendingKeys) {
					pendingKeys.delete(flushedKey);
					if (pendingKeys.size === 0) pendingTopLevelDebounceKeys.delete(topLevelConversationKey);
				}
			}
			const combinedText = entries.length === 1 ? last.message.text ?? "" : entries.map((entry) => entry.message.text ?? "").filter(Boolean).join("\n");
			const combinedMentioned = entries.some((entry) => Boolean(entry.opts.wasMentioned));
			const syntheticMessage = {
				...last.message,
				text: combinedText
			};
			const seenMessageKey = buildSeenMessageKey(last.message.channel, last.message.ts);
			try {
				const { prepareSlackMessage, dispatchPreparedSlackMessage } = await loadSlackMessagePipeline();
				const prepared = await prepareSlackMessage({
					ctx,
					account,
					message: syntheticMessage,
					opts: {
						...last.opts,
						wasMentioned: combinedMentioned || last.opts.wasMentioned
					}
				});
				if (!prepared) return;
				if (seenMessageKey) {
					pruneAppMentionRetryKeys(Date.now());
					if (last.opts.source === "app_mention") appMentionDispatchedKeys.set(seenMessageKey, Date.now() + APP_MENTION_RETRY_TTL_MS);
					else if (last.opts.source === "message" && appMentionDispatchedKeys.has(seenMessageKey)) {
						appMentionDispatchedKeys.delete(seenMessageKey);
						appMentionRetryKeys.delete(seenMessageKey);
						return;
					}
					appMentionRetryKeys.delete(seenMessageKey);
				}
				if (entries.length > 1) {
					const ids = entries.map((entry) => entry.message.ts).filter(Boolean);
					if (ids.length > 0) {
						prepared.ctxPayload.MessageSids = ids;
						prepared.ctxPayload.MessageSidFirst = ids[0];
						prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
					}
				}
				await dispatchPreparedSlackMessage(prepared);
			} catch (error) {
				if (error instanceof SlackRetryableInboundError) {
					if (seenMessageKey) appMentionDispatchedKeys.delete(seenMessageKey);
					ctx.releaseSeenMessage(last.message.channel, last.message.ts);
				}
				throw error;
			}
		},
		onError: (err) => {
			ctx.runtime.error?.(`slack inbound debounce flush failed: ${formatErrorMessage(err)}`);
		}
	});
	const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
	const pendingTopLevelDebounceKeys = /* @__PURE__ */ new Map();
	const appMentionRetryKeys = /* @__PURE__ */ new Map();
	const appMentionDispatchedKeys = /* @__PURE__ */ new Map();
	const pruneAppMentionRetryKeys = (now) => {
		for (const [key, expiresAt] of appMentionRetryKeys) if (expiresAt <= now) appMentionRetryKeys.delete(key);
		for (const [key, expiresAt] of appMentionDispatchedKeys) if (expiresAt <= now) appMentionDispatchedKeys.delete(key);
	};
	const rememberAppMentionRetryKey = (key) => {
		const now = Date.now();
		pruneAppMentionRetryKeys(now);
		appMentionRetryKeys.set(key, now + APP_MENTION_RETRY_TTL_MS);
	};
	const consumeAppMentionRetryKey = (key) => {
		pruneAppMentionRetryKeys(Date.now());
		if (!appMentionRetryKeys.has(key)) return false;
		appMentionRetryKeys.delete(key);
		return true;
	};
	return async (message, opts) => {
		if (opts.source === "message" && message.type !== "message") return;
		if (opts.source === "message" && message.subtype && message.subtype !== "file_share" && message.subtype !== "bot_message" && message.subtype !== "thread_broadcast") return;
		const seenMessageKey = buildSeenMessageKey(message.channel, message.ts);
		const wasSeen = seenMessageKey ? ctx.markMessageSeen(message.channel, message.ts) : false;
		if (seenMessageKey && opts.source === "message" && !wasSeen) rememberAppMentionRetryKey(seenMessageKey);
		if (seenMessageKey && wasSeen) {
			if (opts.source !== "app_mention" || !consumeAppMentionRetryKey(seenMessageKey)) return;
		}
		trackEvent?.();
		const resolvedMessage = await threadTsResolver.resolve({
			message,
			source: opts.source
		});
		const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId);
		const conversationKey = buildTopLevelSlackConversationKey(resolvedMessage, ctx.accountId);
		const canDebounce = debounceMs > 0 && shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
		if (!canDebounce && conversationKey) {
			const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
			if (pendingKeys && pendingKeys.size > 0) {
				const keysToFlush = Array.from(pendingKeys);
				for (const pendingKey of keysToFlush) await debouncer.flushKey(pendingKey);
			}
		}
		if (canDebounce && debounceKey && conversationKey) {
			const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? /* @__PURE__ */ new Set();
			pendingKeys.add(debounceKey);
			pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
		}
		await debouncer.enqueue({
			message: resolvedMessage,
			opts
		});
	};
}
//#endregion
//#region extensions/slack/src/monitor/reconnect-policy.ts
const SLACK_AUTH_ERROR_RE = /account_inactive|invalid_auth|token_revoked|token_expired|not_authed|org_login_required|team_access_not_granted|missing_scope|cannot_find_service|invalid_token/i;
const NO_ERROR_DETAIL = "no error detail";
const SLACK_SOCKET_RECONNECT_POLICY = {
	initialMs: 2e3,
	maxMs: 3e4,
	factor: 1.8,
	jitter: .25,
	maxAttempts: 12
};
function getSocketEmitter(app) {
	const receiver = app.receiver;
	const client = receiver && typeof receiver === "object" ? receiver.client : void 0;
	if (!client || typeof client !== "object") return null;
	const on = client.on;
	const off = client.off;
	if (typeof on !== "function" || typeof off !== "function") return null;
	return {
		on: (event, listener) => on.call(client, event, listener),
		off: (event, listener) => off.call(client, event, listener)
	};
}
function waitForSlackSocketDisconnect(app, abortSignal) {
	return new Promise((resolve) => {
		const emitter = getSocketEmitter(app);
		if (!emitter) {
			abortSignal?.addEventListener("abort", () => resolve({ event: "disconnect" }), { once: true });
			return;
		}
		const disconnectListener = () => resolveOnce({ event: "disconnect" });
		const startFailListener = (error) => resolveOnce({
			event: "unable_to_socket_mode_start",
			error
		});
		const errorListener = (error) => resolveOnce({
			event: "error",
			error
		});
		const abortListener = () => resolveOnce({ event: "disconnect" });
		const cleanup = () => {
			emitter.off("disconnected", disconnectListener);
			emitter.off("unable_to_socket_mode_start", startFailListener);
			emitter.off("error", errorListener);
			abortSignal?.removeEventListener("abort", abortListener);
		};
		const resolveOnce = (value) => {
			cleanup();
			resolve(value);
		};
		emitter.on("disconnected", disconnectListener);
		emitter.on("unable_to_socket_mode_start", startFailListener);
		emitter.on("error", errorListener);
		abortSignal?.addEventListener("abort", abortListener, { once: true });
	});
}
/**
* Detect non-recoverable Slack API / auth errors that should NOT be retried.
* These indicate permanent credential problems (revoked bot, deactivated account, etc.)
* and retrying will never succeed — continuing to retry blocks the entire gateway.
*/
function isNonRecoverableSlackAuthError(error) {
	return SLACK_AUTH_ERROR_RE.test(formatUnknownError(error, ""));
}
function formatUnknownError(error, fallback = NO_ERROR_DETAIL) {
	return formatSlackError(error, fallback);
}
//#endregion
//#region extensions/slack/src/monitor/provider-support.ts
const OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS = 15e3;
const OPENCLAW_SLACK_SOCKET_START_FAILED_EVENT = "unable_to_socket_mode_start";
const OPENCLAW_SLACK_NATIVE_RECONNECT_OBSERVER_KEY = "__openclawNativeReconnectFailureObserver";
const SLACK_SOCKET_PONG_TIMEOUT_WARNING_PREFIX = "A pong wasn't received from the server";
const SLACK_SOCKET_PING_TIMEOUT_WARNING_PREFIX = "A ping wasn't received from the server";
const SLACK_SOCKET_LOG_LEVEL_IGNORED_WARNING_RE = /^The logLevel given to .+ was ignored as you also gave logger$/;
function isConstructorFunction(value) {
	return typeof value === "function";
}
function installSlackNativeReconnectFailureObserver(receiver) {
	if (!receiver || typeof receiver !== "object") return;
	const client = Reflect.get(receiver, "client");
	if (!client || typeof client !== "object") return;
	if (Reflect.get(client, OPENCLAW_SLACK_NATIVE_RECONNECT_OBSERVER_KEY)) return;
	const delayReconnectAttempt = Reflect.get(client, "delayReconnectAttempt");
	const emit = Reflect.get(client, "emit");
	if (typeof delayReconnectAttempt !== "function" || typeof emit !== "function") return;
	Reflect.set(client, OPENCLAW_SLACK_NATIVE_RECONNECT_OBSERVER_KEY, true);
	Reflect.set(client, "delayReconnectAttempt", function patchedDelayReconnectAttempt(callback) {
		if (typeof callback !== "function") return delayReconnectAttempt.call(this, callback);
		const nextFailureCount = Number(Reflect.get(this, "numOfConsecutiveReconnectionFailures") ?? 0) + 1;
		Reflect.set(this, "numOfConsecutiveReconnectionFailures", nextFailureCount);
		const pingTimeoutMs = Number(Reflect.get(this, "clientPingTimeoutMS"));
		const delayMs = (Number.isFinite(pingTimeoutMs) && pingTimeoutMs >= 0 ? pingTimeoutMs : OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS) * nextFailureCount;
		const logger = Reflect.get(this, "logger");
		logger?.debug?.(`Before trying to reconnect, this client will wait for ${delayMs} milliseconds`);
		return new Promise((resolve, reject) => {
			setTimeout(() => {
				if (Reflect.get(this, "shuttingDown")) {
					logger?.debug?.("Client shutting down, will not attempt reconnect.");
					resolve(void 0);
					return;
				}
				logger?.debug?.("Continuing with reconnect...");
				emit.call(this, "reconnecting");
				Promise.resolve(callback.call(this)).then(resolve, (error) => {
					if (callback === Reflect.get(this, "start")) {
						emit.call(this, OPENCLAW_SLACK_SOCKET_START_FAILED_EVENT, error);
						resolve(void 0);
						return;
					}
					reject(error);
				});
			}, delayMs);
		});
	});
}
function resolveSlackBoltModule(value) {
	if (!value || typeof value !== "object") return null;
	const app = Reflect.get(value, "App");
	const httpReceiver = Reflect.get(value, "HTTPReceiver");
	const socketModeReceiver = Reflect.get(value, "SocketModeReceiver");
	if (!isConstructorFunction(app) || !isConstructorFunction(httpReceiver) || !isConstructorFunction(socketModeReceiver)) return null;
	return {
		App: app,
		HTTPReceiver: httpReceiver,
		SocketModeReceiver: socketModeReceiver
	};
}
function resolveSlackBoltInterop(params) {
	const { defaultImport, namespaceImport } = params;
	const nestedDefault = defaultImport && typeof defaultImport === "object" ? Reflect.get(defaultImport, "default") : void 0;
	const namespaceDefault = namespaceImport && typeof namespaceImport === "object" ? Reflect.get(namespaceImport, "default") : void 0;
	const namespaceReceiver = namespaceImport && typeof namespaceImport === "object" ? Reflect.get(namespaceImport, "HTTPReceiver") : void 0;
	const namespaceSocketModeReceiver = namespaceImport && typeof namespaceImport === "object" ? Reflect.get(namespaceImport, "SocketModeReceiver") : void 0;
	const directModule = resolveSlackBoltModule(defaultImport) ?? resolveSlackBoltModule(nestedDefault) ?? resolveSlackBoltModule(namespaceDefault) ?? resolveSlackBoltModule(namespaceImport);
	if (directModule) return directModule;
	if (isConstructorFunction(defaultImport) && isConstructorFunction(namespaceReceiver) && isConstructorFunction(namespaceSocketModeReceiver)) return {
		App: defaultImport,
		HTTPReceiver: namespaceReceiver,
		SocketModeReceiver: namespaceSocketModeReceiver
	};
	throw new TypeError("Unable to resolve @slack/bolt App/HTTPReceiver exports");
}
function publishSlackConnectedStatus(setStatus) {
	if (!setStatus) return;
	setStatus({
		connected: true,
		lastConnectedAt: Date.now(),
		healthState: "healthy",
		lastError: null
	});
}
function publishSlackDisconnectedStatus(setStatus, error) {
	if (!setStatus) return;
	const at = Date.now();
	const message = error ? formatUnknownError(error) : void 0;
	setStatus({
		connected: false,
		healthState: "disconnected",
		lastDisconnect: message ? {
			at,
			error: message
		} : { at },
		lastError: message ?? null
	});
}
function isSlackSocketHeartbeatTimeoutWarning(args) {
	return typeof args[0] === "string" && (args[0].startsWith(SLACK_SOCKET_PONG_TIMEOUT_WARNING_PREFIX) || args[0].startsWith(SLACK_SOCKET_PING_TIMEOUT_WARNING_PREFIX));
}
function isSlackSocketSelfInflictedLoggerWarning(args) {
	return typeof args[0] === "string" && SLACK_SOCKET_LOG_LEVEL_IGNORED_WARNING_RE.test(args[0]);
}
function formatSlackSdkLogArgs(args) {
	return args.map((arg) => formatUnknownError(arg, "")).filter(Boolean).join(" ");
}
function createSlackSocketModeLogger(sink = console) {
	let level = "info";
	let name = "socket-mode";
	const prefix = () => `socket-mode:${name}`;
	let lastMessage;
	const remember = (args) => {
		const message = formatSlackSdkLogArgs([prefix(), ...args]);
		if (message) lastMessage = message;
	};
	return {
		debug: () => {},
		info: () => {},
		warn: (...args) => {
			if (isSlackSocketHeartbeatTimeoutWarning(args) || isSlackSocketSelfInflictedLoggerWarning(args)) return;
			remember(args);
			sink.warn(prefix(), ...args);
		},
		error: (...args) => {
			remember(args);
			sink.error(prefix(), ...args);
		},
		setLevel: (nextLevel) => {
			level = nextLevel;
		},
		getLevel: () => level,
		setName: (nextName) => {
			name = nextName;
		},
		getLastMessage: () => lastMessage
	};
}
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function shouldSkipOpenClawSlackSelfEvent(args) {
	const botId = args.context?.botId;
	const botUserId = args.context?.botUserId;
	const message = asRecord(args.message);
	if (message?.subtype === "bot_message" && botId && message.bot_id === botId) return true;
	const event = asRecord(args.event);
	if (event?.type === "message" && event.subtype === "message_changed" && event.user === botUserId) return false;
	const eventsWhichShouldBeKept = new Set(["member_joined_channel", "member_left_channel"]);
	return Boolean(botUserId && event && event.user === botUserId && typeof event.type === "string" && !eventsWhichShouldBeKept.has(event.type));
}
function createSlackBoltApp(params) {
	const socketModeLogger = createSlackSocketModeLogger();
	const socketModeReceiverOptions = {
		appToken: params.appToken ?? "",
		autoReconnectEnabled: true,
		clientPingTimeout: params.socketMode?.clientPingTimeout ?? OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS,
		logger: socketModeLogger,
		installerOptions: { clientOptions: params.clientOptions }
	};
	if (params.socketMode?.serverPingTimeout !== void 0) socketModeReceiverOptions.serverPingTimeout = params.socketMode.serverPingTimeout;
	if (params.socketMode?.pingPongLoggingEnabled !== void 0) socketModeReceiverOptions.pingPongLoggingEnabled = params.socketMode.pingPongLoggingEnabled;
	const receiver = params.slackMode === "socket" ? new params.interop.SocketModeReceiver(socketModeReceiverOptions) : new params.interop.HTTPReceiver({
		signingSecret: params.signingSecret ?? "",
		endpoints: params.slackWebhookPath
	});
	if (params.slackMode === "socket") installSlackNativeReconnectFailureObserver(receiver);
	const app = new params.interop.App({
		token: params.botToken,
		receiver,
		clientOptions: params.clientOptions,
		ignoreSelf: false,
		tokenVerificationEnabled: false
	});
	app.use(async (args) => {
		if (shouldSkipOpenClawSlackSelfEvent(args)) return;
		await args.next();
	});
	return {
		app,
		receiver,
		socketModeLogger
	};
}
function createSlackSocketDisconnectWaiter(app, abortSignal) {
	const waiterAbortController = new AbortController();
	const relayAbort = () => waiterAbortController.abort();
	let latest;
	abortSignal?.addEventListener("abort", relayAbort, { once: true });
	return {
		promise: waitForSlackSocketDisconnect(app, waiterAbortController.signal).then((value) => {
			latest = value;
			return value;
		}),
		getLatest: () => latest,
		cancel: () => {
			waiterAbortController.abort();
			abortSignal?.removeEventListener("abort", relayAbort);
		},
		complete: () => {
			abortSignal?.removeEventListener("abort", relayAbort);
		}
	};
}
async function startSlackSocketAndWaitForDisconnect(params) {
	const disconnectWaiter = createSlackSocketDisconnectWaiter(params.app, params.abortSignal);
	try {
		await Promise.resolve(params.app.start());
		if (params.abortSignal?.aborted) {
			disconnectWaiter.cancel();
			return null;
		}
		params.onStarted?.();
		const disconnect = await disconnectWaiter.promise;
		disconnectWaiter.complete();
		return disconnect;
	} catch (err) {
		await Promise.resolve();
		const disconnect = disconnectWaiter.getLatest();
		disconnectWaiter.cancel();
		if ((err === void 0 || err === null || err === "") && disconnect?.error !== void 0) throw disconnect.error;
		if (err === void 0 || err === null || err === "") {
			const suffix = disconnect ? ` after ${disconnect.event}` : "";
			throw new Error(`Slack Socket Mode start failed${suffix} without error detail`, { cause: err });
		}
		throw err;
	}
}
function resolveSlackSocketShutdownClient(app) {
	if (!app || typeof app !== "object") return;
	const receiver = Reflect.get(app, "receiver");
	if (!receiver || typeof receiver !== "object") return;
	const client = Reflect.get(receiver, "client");
	if (!client || typeof client !== "object") return;
	return client;
}
async function gracefulStopSlackApp(app) {
	const socketClient = resolveSlackSocketShutdownClient(app);
	if (socketClient) socketClient.shuttingDown = true;
	await Promise.resolve(app.stop()).catch(() => void 0);
}
function formatSlackResolvedLabel(params) {
	const extras = params.extra?.filter(Boolean) ?? [];
	const suffix = extras.length > 0 ? ` (id:${params.id}, ${extras.join(", ")})` : ` (id:${params.id})`;
	return `${params.input}→${params.name ?? params.id}${suffix}`;
}
function formatSlackChannelResolved(entry) {
	const id = entry.id ?? entry.input;
	return formatSlackResolvedLabel({
		input: entry.input,
		id,
		name: entry.name,
		extra: entry.archived ? ["archived"] : []
	});
}
function formatSlackUserResolved(entry) {
	const id = entry.id ?? entry.input;
	return formatSlackResolvedLabel({
		input: entry.input,
		id,
		name: entry.name,
		extra: entry.note ? [entry.note] : []
	});
}
//#endregion
//#region extensions/slack/src/monitor/external-arg-menu-store.ts
const SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES = 18;
const SLACK_EXTERNAL_ARG_MENU_TOKEN_LENGTH = Math.ceil(SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES * 8 / 6);
const SLACK_EXTERNAL_ARG_MENU_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${SLACK_EXTERNAL_ARG_MENU_TOKEN_LENGTH}}$`);
const SLACK_EXTERNAL_ARG_MENU_TTL_MS = 600 * 1e3;
const SLACK_EXTERNAL_ARG_MENU_PREFIX = "openclaw_cmdarg_ext:";
function pruneSlackExternalArgMenuStore(store, now) {
	for (const [token, entry] of store.entries()) if (entry.expiresAt <= now) store.delete(token);
}
function createSlackExternalArgMenuToken(store) {
	let token = "";
	do
		token = generateSecureToken(SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES);
	while (store.has(token));
	return token;
}
function createSlackExternalArgMenuStore() {
	const store = /* @__PURE__ */ new Map();
	return {
		create(params, now = Date.now()) {
			pruneSlackExternalArgMenuStore(store, now);
			const token = createSlackExternalArgMenuToken(store);
			store.set(token, {
				choices: params.choices,
				userId: params.userId,
				expiresAt: now + SLACK_EXTERNAL_ARG_MENU_TTL_MS
			});
			return token;
		},
		readToken(raw) {
			if (typeof raw !== "string" || !raw.startsWith("openclaw_cmdarg_ext:")) return;
			const token = raw.slice(20).trim();
			return SLACK_EXTERNAL_ARG_MENU_TOKEN_PATTERN.test(token) ? token : void 0;
		},
		get(token, now = Date.now()) {
			pruneSlackExternalArgMenuStore(store, now);
			return store.get(token);
		}
	};
}
//#endregion
//#region extensions/slack/src/monitor/slash.ts
const SLACK_COMMAND_ARG_ACTION_ID = "openclaw_cmdarg";
const SLACK_COMMAND_ARG_ACTION_LISTENER = /^openclaw_cmdarg/;
const SLACK_COMMAND_ARG_VALUE_PREFIX = "cmdarg";
const SLACK_COMMAND_ARG_BUTTON_ROW_SIZE = 5;
const SLACK_COMMAND_ARG_OVERFLOW_MIN = 3;
const SLACK_COMMAND_ARG_OVERFLOW_MAX = 5;
const SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX = 100;
const SLACK_COMMAND_ARG_SELECT_OPTION_TEXT_MAX = 75;
const SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX = 150;
const SLACK_COMMAND_ARG_BUTTON_TEXT_MAX = 75;
const SLACK_COMMAND_ARG_BUTTON_VALUE_MAX = 2e3;
const SLACK_COMMAND_ARG_CONFIRM_TEXT_MAX = 300;
const SLACK_HEADER_TEXT_MAX = 150;
const SLACK_COMMAND_ARG_ACTION_BLOCKS_MAX = 47;
let slashCommandsRuntimePromise = null;
let slashDispatchRuntimePromise = null;
let slackPluginCommandsRuntimePromise = null;
let slashSkillCommandsRuntimePromise = null;
function loadSlashCommandsRuntime() {
	slashCommandsRuntimePromise ??= import("./slash-commands.runtime.js");
	return slashCommandsRuntimePromise;
}
function loadSlashDispatchRuntime() {
	slashDispatchRuntimePromise ??= import("./slash-dispatch.runtime.js");
	return slashDispatchRuntimePromise;
}
function loadSlackPluginCommandsRuntime() {
	slackPluginCommandsRuntimePromise ??= import("./slash-plugin-commands.runtime.js");
	return slackPluginCommandsRuntimePromise;
}
function loadSlashSkillCommandsRuntime() {
	slashSkillCommandsRuntimePromise ??= import("./slash-skill-commands.runtime.js");
	return slashSkillCommandsRuntimePromise;
}
function resolveSlackCommandMenuModelContext(params) {
	if (!params.sessionKey.trim()) return {};
	try {
		const defaultModel = resolveDefaultModelForAgent({
			cfg: params.cfg,
			agentId: params.agentId
		});
		const store = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }));
		const entry = store[params.sessionKey];
		if (entry?.modelOverrideSource === "auto" && normalizeOptionalString(entry.modelOverride)) return {
			provider: defaultModel.provider,
			model: defaultModel.model
		};
		const override = resolveStoredModelOverride({
			sessionEntry: entry,
			sessionStore: store,
			sessionKey: params.sessionKey,
			defaultProvider: defaultModel.provider
		});
		if (override?.model) return {
			provider: override.provider || defaultModel.provider,
			model: override.model
		};
		const provider = normalizeOptionalString(entry?.providerOverride) ?? normalizeOptionalString(entry?.modelProvider);
		const model = normalizeOptionalString(entry?.modelOverride) ?? normalizeOptionalString(entry?.model);
		return {
			...provider ? { provider } : {},
			...model ? { model } : {}
		};
	} catch {
		return {};
	}
}
const slackExternalArgMenuStore = createSlackExternalArgMenuStore();
function buildSlackArgMenuConfirm(params) {
	return {
		title: {
			type: "plain_text",
			text: "Confirm selection"
		},
		text: {
			type: "mrkdwn",
			text: truncateSlackText(`Run */${escapeSlackMrkdwn(params.command)}* with *${escapeSlackMrkdwn(params.arg)}* set to this value?`, SLACK_COMMAND_ARG_CONFIRM_TEXT_MAX)
		},
		confirm: {
			type: "plain_text",
			text: "Run command"
		},
		deny: {
			type: "plain_text",
			text: "Cancel"
		}
	};
}
function storeSlackExternalArgMenu(params) {
	return slackExternalArgMenuStore.create({
		choices: params.choices,
		userId: params.userId
	});
}
function readSlackExternalArgMenuToken(raw) {
	return slackExternalArgMenuStore.readToken(raw);
}
function encodeSlackCommandArgValue(parts) {
	return [
		SLACK_COMMAND_ARG_VALUE_PREFIX,
		encodeURIComponent(parts.command),
		encodeURIComponent(parts.arg),
		encodeURIComponent(parts.value),
		encodeURIComponent(parts.userId)
	].join("|");
}
function parseSlackCommandArgValue(raw) {
	if (!raw) return null;
	const parts = raw.split("|");
	if (parts.length !== 5 || parts[0] !== SLACK_COMMAND_ARG_VALUE_PREFIX) return null;
	const [, command, arg, value, userId] = parts;
	if (!command || !arg || !value || !userId) return null;
	const decode = (text) => {
		try {
			return decodeURIComponent(text);
		} catch {
			return null;
		}
	};
	const decodedCommand = decode(command);
	const decodedArg = decode(arg);
	const decodedValue = decode(value);
	const decodedUserId = decode(userId);
	if (!decodedCommand || !decodedArg || !decodedValue || !decodedUserId) return null;
	return {
		command: decodedCommand,
		arg: decodedArg,
		value: decodedValue,
		userId: decodedUserId
	};
}
function buildSlackArgMenuOptions(choices) {
	return choices.map((choice) => ({
		text: {
			type: "plain_text",
			text: truncateSlackText(choice.label, SLACK_COMMAND_ARG_SELECT_OPTION_TEXT_MAX)
		},
		value: choice.value
	}));
}
function buildSlackCommandArgMenuBlocks(params) {
	const encodedChoices = params.choices.map((choice) => ({
		label: choice.label,
		value: encodeSlackCommandArgValue({
			command: params.command,
			arg: params.arg,
			value: choice.value,
			userId: params.userId
		})
	}));
	const canUseStaticSelect = encodedChoices.every((choice) => choice.value.length <= SLACK_COMMAND_ARG_SELECT_OPTION_VALUE_MAX);
	const canUseOverflow = canUseStaticSelect && encodedChoices.length >= SLACK_COMMAND_ARG_OVERFLOW_MIN && encodedChoices.length <= SLACK_COMMAND_ARG_OVERFLOW_MAX;
	const canUseExternalSelect = params.supportsExternalSelect && canUseStaticSelect && encodedChoices.length > SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX;
	const rows = canUseOverflow ? [{
		type: "actions",
		elements: [{
			type: "overflow",
			action_id: SLACK_COMMAND_ARG_ACTION_ID,
			confirm: buildSlackArgMenuConfirm({
				command: params.command,
				arg: params.arg
			}),
			options: buildSlackArgMenuOptions(encodedChoices)
		}]
	}] : canUseExternalSelect ? [{
		type: "actions",
		block_id: `${SLACK_EXTERNAL_ARG_MENU_PREFIX}${params.createExternalMenuToken(encodedChoices)}`,
		elements: [{
			type: "external_select",
			action_id: SLACK_COMMAND_ARG_ACTION_ID,
			confirm: buildSlackArgMenuConfirm({
				command: params.command,
				arg: params.arg
			}),
			min_query_length: 0,
			placeholder: {
				type: "plain_text",
				text: `Search ${params.arg}`
			}
		}]
	}] : encodedChoices.length <= SLACK_COMMAND_ARG_BUTTON_ROW_SIZE || !canUseStaticSelect ? chunkItems(encodedChoices.filter((choice) => choice.value.length <= SLACK_COMMAND_ARG_BUTTON_VALUE_MAX), SLACK_COMMAND_ARG_BUTTON_ROW_SIZE).map((choices, rowIndex) => ({
		type: "actions",
		elements: choices.map((choice, colIndex) => ({
			type: "button",
			action_id: `${SLACK_COMMAND_ARG_ACTION_ID}_${rowIndex}_${colIndex}`,
			text: {
				type: "plain_text",
				text: truncateSlackText(choice.label, SLACK_COMMAND_ARG_BUTTON_TEXT_MAX)
			},
			value: choice.value,
			confirm: buildSlackArgMenuConfirm({
				command: params.command,
				arg: params.arg
			})
		}))
	})) : chunkItems(encodedChoices, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map((choices, index) => ({
		type: "actions",
		elements: [{
			type: "static_select",
			action_id: SLACK_COMMAND_ARG_ACTION_ID,
			confirm: buildSlackArgMenuConfirm({
				command: params.command,
				arg: params.arg
			}),
			placeholder: {
				type: "plain_text",
				text: index === 0 ? `Choose ${params.arg}` : `Choose ${params.arg} (${index + 1})`
			},
			options: buildSlackArgMenuOptions(choices)
		}]
	}));
	const headerText = truncateSlackText(`/${params.command}: choose ${params.arg}`, SLACK_HEADER_TEXT_MAX);
	const sectionText = truncateSlackText(params.title, 3e3);
	const contextText = truncateSlackText(`Select one option to continue /${params.command} (${params.arg})`, 3e3);
	const visibleRows = rows.slice(0, SLACK_COMMAND_ARG_ACTION_BLOCKS_MAX);
	return [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: headerText
			}
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: sectionText
			}
		},
		{
			type: "context",
			elements: [{
				type: "mrkdwn",
				text: contextText
			}]
		},
		...visibleRows
	];
}
async function registerSlackMonitorSlashCommands(params) {
	const { ctx, account, trackEvent } = params;
	const cfg = ctx.cfg;
	const runtime = ctx.runtime;
	const supportsInteractiveArgMenus = typeof ctx.app.action === "function";
	let supportsExternalArgMenus = typeof ctx.app.options === "function";
	const slashCommand = resolveSlackSlashCommandConfig(ctx.slashCommand ?? account.config.slashCommand);
	const handleSlashCommand = async (p) => {
		const { command, ack, respond, body, prompt, commandArgs, commandDefinition } = p;
		try {
			if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
				await ack();
				runtime.log?.(`slack: drop slash command from user=${command.user_id ?? "unknown"} channel=${command.channel_id ?? "unknown"} (mismatched app/team)`);
				return;
			}
			trackEvent?.();
			if (!prompt.trim()) {
				await ack({
					text: "Message required.",
					response_type: "ephemeral"
				});
				return;
			}
			await ack();
			if (ctx.botUserId && command.user_id === ctx.botUserId) return;
			const channelInfo = await ctx.resolveChannelName(command.channel_id);
			const channelType = normalizeSlackChannelType(channelInfo?.type ?? (command.channel_name === "directmessage" ? "im" : void 0), command.channel_id);
			const chatType = resolveSlackChatType(channelType);
			const isDirectMessage = channelType === "im";
			const isGroupDm = channelType === "mpim";
			const isRoom = channelType === "channel" || channelType === "group";
			const isRoomish = isRoom || isGroupDm;
			if (!ctx.isChannelAllowed({
				channelId: command.channel_id,
				channelName: channelInfo?.name,
				channelType
			})) {
				await respond({
					text: "This channel is not allowed.",
					response_type: "ephemeral"
				});
				return;
			}
			const effectiveAllowFromLower = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: isDirectMessage });
			let commandAuthorized = false;
			let channelConfig = null;
			if (isDirectMessage) {
				if (!await authorizeSlackDirectMessage({
					ctx,
					accountId: ctx.accountId,
					senderId: command.user_id,
					allowFromLower: effectiveAllowFromLower,
					resolveSenderName: ctx.resolveUserName,
					sendPairingReply: async (text) => {
						await respond({
							text,
							response_type: "ephemeral"
						});
					},
					onDisabled: async () => {
						await respond({
							text: "Slack DMs are disabled.",
							response_type: "ephemeral"
						});
					},
					onUnauthorized: async ({ allowMatchMeta }) => {
						logVerbose(`slack: blocked slash sender ${command.user_id} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`);
						await respond({
							text: "You are not authorized to use this command.",
							response_type: "ephemeral"
						});
					},
					log: logVerbose
				})) return;
			}
			if (isRoom) {
				channelConfig = resolveSlackChannelConfig({
					channelId: command.channel_id,
					channelName: channelInfo?.name,
					channels: ctx.channelsConfig,
					channelKeys: ctx.channelsConfigKeys,
					defaultRequireMention: ctx.defaultRequireMention,
					allowNameMatching: ctx.allowNameMatching
				});
				if (ctx.useAccessGroups) {
					const channelAllowlistConfigured = (ctx.channelsConfigKeys?.length ?? 0) > 0;
					const channelAllowed = channelConfig?.allowed !== false;
					if (!isSlackChannelAllowedByPolicy({
						groupPolicy: ctx.groupPolicy,
						channelAllowlistConfigured,
						channelAllowed
					})) {
						await respond({
							text: "This channel is not allowed.",
							response_type: "ephemeral"
						});
						return;
					}
					const hasExplicitConfig = Boolean(channelConfig?.matchSource);
					if (!channelAllowed && (ctx.groupPolicy !== "open" || hasExplicitConfig)) {
						await respond({
							text: "This channel is not allowed.",
							response_type: "ephemeral"
						});
						return;
					}
				}
			}
			const senderName = (await ctx.resolveUserName(command.user_id))?.name ?? command.user_name ?? command.user_id;
			const slashIngress = await resolveSlackCommandIngress({
				ctx,
				senderId: command.user_id,
				senderName,
				channelType: channelType ?? "channel",
				channelId: command.channel_id,
				ownerAllowFromLower: effectiveAllowFromLower,
				channelUsers: isRoom ? channelConfig?.users : void 0,
				allowTextCommands: false,
				hasControlCommand: false,
				eventKind: "slash-command",
				modeWhenAccessGroupsOff: "configured"
			});
			const senderGate = slashIngress.senderAccess.gate;
			if (isRoom && senderGate?.allowed === false) {
				await respond({
					text: "You are not authorized to use this command here.",
					response_type: "ephemeral"
				});
				return;
			}
			commandAuthorized = slashIngress.commandAccess.authorized;
			if (isRoomish) {
				if (ctx.useAccessGroups && !commandAuthorized) {
					await respond({
						text: "You are not authorized to use this command.",
						response_type: "ephemeral"
					});
					return;
				}
			}
			let resolvedSlashRoute;
			const resolveSlashRoute = async () => {
				if (resolvedSlashRoute) return resolvedSlashRoute;
				const { resolveAgentRoute } = await loadSlashDispatchRuntime();
				resolvedSlashRoute = resolveAgentRoute({
					cfg,
					channel: "slack",
					accountId: account.accountId,
					teamId: ctx.teamId || void 0,
					peer: {
						kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
						id: isDirectMessage ? command.user_id : command.channel_id
					}
				});
				return resolvedSlashRoute;
			};
			if (commandDefinition && supportsInteractiveArgMenus) {
				const { resolveCommandArgMenu } = await loadSlashCommandsRuntime();
				const menuRoute = !(commandArgs?.raw && !commandArgs.values) && commandDefinition.args?.some((arg) => typeof arg.choices === "function" && commandArgs?.values?.[arg.name] == null) ? await resolveSlashRoute() : void 0;
				const menu = resolveCommandArgMenu({
					command: commandDefinition,
					args: commandArgs,
					cfg,
					...menuRoute ? resolveSlackCommandMenuModelContext({
						cfg,
						agentId: menuRoute.agentId,
						sessionKey: menuRoute.sessionKey
					}) : {}
				});
				if (menu) {
					const commandLabel = commandDefinition.nativeName ?? commandDefinition.key;
					const title = formatCommandArgMenuTitle({
						command: commandDefinition,
						menu
					});
					await respond({
						text: title,
						blocks: buildSlackCommandArgMenuBlocks({
							title,
							command: commandLabel,
							arg: menu.arg.name,
							choices: menu.choices,
							userId: command.user_id,
							supportsExternalSelect: supportsExternalArgMenus,
							createExternalMenuToken: (choices) => storeSlackExternalArgMenu({
								choices,
								userId: command.user_id
							})
						}),
						response_type: "ephemeral"
					});
					return;
				}
			}
			const channelName = channelInfo?.name;
			const roomLabel = channelName ? `#${channelName}` : `#${command.channel_id}`;
			const { deliverSlackSlashReplies, dispatchReplyWithDispatcher, finalizeInboundContext, recordInboundSessionMetaSafe, resolveAgentRoute, resolveChunkMode, resolveConversationLabel, resolveMarkdownTableMode } = await loadSlashDispatchRuntime();
			const route = resolvedSlashRoute ?? resolveAgentRoute({
				cfg,
				channel: "slack",
				accountId: account.accountId,
				teamId: ctx.teamId || void 0,
				peer: {
					kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
					id: isDirectMessage ? command.user_id : command.channel_id
				}
			});
			const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
				isRoomish,
				channelInfo,
				channelConfig
			});
			const { sessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
				agentId: route.agentId,
				sessionPrefix: slashCommand.sessionPrefix,
				userId: command.user_id,
				targetSessionKey: route.sessionKey,
				lowercaseSessionKey: true
			});
			const ctxPayload = finalizeInboundContext({
				Body: prompt,
				BodyForAgent: prompt,
				RawBody: prompt,
				CommandBody: prompt,
				CommandArgs: commandArgs,
				From: isDirectMessage ? `slack:${command.user_id}` : isRoom ? `slack:channel:${command.channel_id}` : `slack:group:${command.channel_id}`,
				To: `slash:${command.user_id}`,
				ChatType: chatType,
				ConversationLabel: resolveConversationLabel({
					ChatType: chatType,
					SenderName: senderName,
					GroupSubject: isRoomish ? roomLabel : void 0,
					From: isDirectMessage ? `slack:${command.user_id}` : isRoom ? `slack:channel:${command.channel_id}` : `slack:group:${command.channel_id}`
				}) ?? (isDirectMessage ? senderName : roomLabel),
				GroupSubject: isRoomish ? roomLabel : void 0,
				GroupSpace: ctx.teamId || void 0,
				GroupSystemPrompt: groupSystemPrompt,
				UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : void 0,
				SenderName: senderName,
				SenderId: command.user_id,
				Provider: "slack",
				Surface: "slack",
				WasMentioned: true,
				MessageSid: command.trigger_id,
				Timestamp: Date.now(),
				SessionKey: sessionKey,
				CommandTargetSessionKey: commandTargetSessionKey,
				AccountId: route.accountId,
				CommandSource: "native",
				CommandAuthorized: commandAuthorized,
				OriginatingChannel: "slack",
				OriginatingTo: `user:${command.user_id}`
			});
			await recordInboundSessionMetaSafe({
				cfg,
				agentId: route.agentId,
				sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
				ctx: ctxPayload,
				onError: (err) => runtime.error?.(danger(`slack slash: failed updating session meta: ${formatErrorMessage(err)}`))
			});
			const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
				cfg,
				agentId: route.agentId,
				channel: "slack",
				accountId: route.accountId
			});
			const deliverSlashPayloads = async (replies) => {
				await deliverSlackSlashReplies({
					replies,
					respond,
					ephemeral: slashCommand.ephemeral,
					textLimit: ctx.textLimit,
					chunkMode: resolveChunkMode(cfg, "slack", route.accountId),
					tableMode: resolveMarkdownTableMode({
						cfg,
						channel: "slack",
						accountId: route.accountId
					})
				});
			};
			const { counts } = await dispatchReplyWithDispatcher({
				ctx: ctxPayload,
				cfg,
				dispatcherOptions: {
					...replyPipeline,
					deliver: async (payload) => deliverSlashPayloads([payload]),
					onError: (err, info) => {
						runtime.error?.(danger(`slack slash ${info.kind} reply failed: ${formatSlackError(err)}`));
					}
				},
				replyOptions: {
					skillFilter: channelConfig?.skills,
					onModelSelected
				}
			});
			if (counts.final + counts.tool + counts.block === 0) await deliverSlashPayloads([]);
		} catch (err) {
			runtime.error?.(danger(`slack slash handler failed: ${formatErrorMessage(err)}`));
			await respond({
				text: "Sorry, something went wrong handling that command.",
				response_type: "ephemeral"
			});
		}
	};
	const nativeEnabled = resolveNativeCommandsEnabled({
		providerId: "slack",
		providerSetting: account.config.commands?.native,
		globalSetting: cfg.commands?.native
	});
	const nativeSkillsEnabled = resolveNativeSkillsEnabled({
		providerId: "slack",
		providerSetting: account.config.commands?.nativeSkills,
		globalSetting: cfg.commands?.nativeSkills
	});
	let nativeCommands = [];
	let slashCommandsRuntime = null;
	if (nativeEnabled) {
		slashCommandsRuntime = await loadSlashCommandsRuntime();
		const skillCommands = nativeSkillsEnabled ? (await loadSlashSkillCommandsRuntime()).listSkillCommandsForAgents({ cfg }) : [];
		nativeCommands = slashCommandsRuntime.listNativeCommandSpecsForConfig(cfg, {
			skillCommands,
			provider: "slack"
		});
		const existingNativeNames = new Set(nativeCommands.map((c) => normalizeLowercaseStringOrEmpty(c.name)).filter(Boolean));
		const { listProviderPluginCommandSpecs } = await loadSlackPluginCommandsRuntime();
		for (const pluginCommand of listProviderPluginCommandSpecs("slack")) {
			const normalizedName = normalizeLowercaseStringOrEmpty(pluginCommand.name);
			if (!normalizedName || existingNativeNames.has(normalizedName)) continue;
			existingNativeNames.add(normalizedName);
			nativeCommands.push(pluginCommand);
		}
	}
	if (nativeCommands.length > 0) {
		if (!slashCommandsRuntime) throw new Error("Missing commands runtime for native Slack commands.");
		for (const command of nativeCommands) ctx.app.command(`/${command.name}`, async ({ command: cmd, ack, respond, body }) => {
			const commandDefinition = slashCommandsRuntime.findCommandByNativeName(command.name, "slack");
			const rawText = cmd.text?.trim() ?? "";
			const commandArgs = commandDefinition ? slashCommandsRuntime.parseCommandArgs(commandDefinition, rawText) : rawText ? { raw: rawText } : void 0;
			await handleSlashCommand({
				command: cmd,
				ack,
				respond,
				body,
				prompt: commandDefinition ? slashCommandsRuntime.buildCommandTextFromArgs(commandDefinition, commandArgs) : rawText ? `/${command.name} ${rawText}` : `/${command.name}`,
				commandArgs,
				commandDefinition: commandDefinition ?? void 0
			});
		});
	} else if (slashCommand.enabled) ctx.app.command(buildSlackSlashCommandMatcher(slashCommand.name), async ({ command, ack, respond, body }) => {
		await handleSlashCommand({
			command,
			ack,
			respond,
			body,
			prompt: command.text?.trim() ?? ""
		});
	});
	else logVerbose("slack: slash commands disabled");
	if (nativeCommands.length === 0 || !supportsInteractiveArgMenus) return;
	const registerArgOptions = () => {
		const appWithOptions = ctx.app;
		if (typeof appWithOptions.options !== "function") return;
		appWithOptions.options(SLACK_COMMAND_ARG_ACTION_ID, async ({ ack, body }) => {
			if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
				await ack({ options: [] });
				runtime.log?.("slack: drop slash arg options payload (mismatched app/team)");
				return;
			}
			trackEvent?.();
			const typedBody = body;
			const token = readSlackExternalArgMenuToken(typedBody.actions?.[0]?.block_id ?? typedBody.block_id);
			if (!token) {
				await ack({ options: [] });
				return;
			}
			const entry = slackExternalArgMenuStore.get(token);
			if (!entry) {
				await ack({ options: [] });
				return;
			}
			const requesterUserId = typedBody.user?.id?.trim();
			if (!requesterUserId || requesterUserId !== entry.userId) {
				await ack({ options: [] });
				return;
			}
			const query = normalizeLowercaseStringOrEmpty(typedBody.value);
			await ack({ options: entry.choices.filter((choice) => !query || normalizeLowercaseStringOrEmpty(choice.label).includes(query)).slice(0, SLACK_COMMAND_ARG_SELECT_OPTIONS_MAX).map((choice) => ({
				text: {
					type: "plain_text",
					text: choice.label.slice(0, 75)
				},
				value: choice.value
			})) });
		});
	};
	try {
		registerArgOptions();
	} catch (err) {
		supportsExternalArgMenus = false;
		logVerbose(`slack: external arg-menu registration failed, falling back to static menus: ${formatErrorMessage(err)}`);
	}
	const registerArgAction = (actionId) => {
		ctx.app.action(actionId, async (args) => {
			const { ack, body, respond } = args;
			const action = args.action;
			await ack();
			if (ctx.shouldDropMismatchedSlackEvent?.(body)) {
				runtime.log?.("slack: drop slash arg action payload (mismatched app/team)");
				return;
			}
			const respondFn = respond ?? (async (payload) => {
				if (!body.channel?.id || !body.user?.id) return;
				await ctx.app.client.chat.postEphemeral({
					token: ctx.botToken,
					channel: body.channel.id,
					user: body.user.id,
					text: payload.text,
					blocks: payload.blocks
				});
			});
			const parsed = parseSlackCommandArgValue(action?.value ?? action?.selected_option?.value);
			if (!parsed) {
				await respondFn({
					text: "Sorry, that button is no longer valid.",
					response_type: "ephemeral"
				});
				return;
			}
			if (body.user?.id && parsed.userId !== body.user.id) {
				await respondFn({
					text: "That menu is for another user.",
					response_type: "ephemeral"
				});
				return;
			}
			const { buildCommandTextFromArgs, findCommandByNativeName } = await loadSlashCommandsRuntime();
			const commandDefinition = findCommandByNativeName(parsed.command, "slack");
			const commandArgs = { values: { [parsed.arg]: parsed.value } };
			const prompt = commandDefinition ? buildCommandTextFromArgs(commandDefinition, commandArgs) : `/${parsed.command} ${parsed.value}`;
			const user = body.user;
			const userName = user && "name" in user && user.name ? user.name : user && "username" in user && user.username ? user.username : user?.id ?? "";
			const triggerId = "trigger_id" in body ? body.trigger_id : void 0;
			await handleSlashCommand({
				command: {
					user_id: user?.id ?? "",
					user_name: userName,
					channel_id: body.channel?.id ?? "",
					channel_name: body.channel?.name ?? body.channel?.id ?? "",
					trigger_id: triggerId
				},
				ack: async () => {},
				respond: respondFn,
				body,
				prompt,
				commandArgs,
				commandDefinition: commandDefinition ?? void 0
			});
		});
	};
	registerArgAction(SLACK_COMMAND_ARG_ACTION_LISTENER);
}
//#endregion
//#region extensions/slack/src/monitor/provider.ts
let slackBoltInterop;
async function getSlackBoltInterop() {
	if (!slackBoltInterop) {
		const slackBoltModule = await import("@slack/bolt");
		slackBoltInterop = resolveSlackBoltInterop({
			defaultImport: slackBoltModule.default,
			namespaceImport: slackBoltModule
		});
	}
	return slackBoltInterop;
}
const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_WEBHOOK_BODY_TIMEOUT_MS = 3e4;
function resolveStableSlackUserIdEntry(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const mention = /^<@([A-Z][A-Z0-9]+)>$/i.exec(trimmed);
	if (mention) return mention[1]?.toUpperCase();
	const prefixed = /^(?:slack:|user:)([A-Z][A-Z0-9]+)$/i.exec(trimmed);
	if (prefixed) return prefixed[1]?.toUpperCase();
	return /^[UW][A-Z0-9]+$/i.test(trimmed) ? trimmed.toUpperCase() : void 0;
}
function resolveStableSlackUserAllowlistEntries(entries) {
	const resolved = [];
	for (const input of entries) {
		const id = resolveStableSlackUserIdEntry(input);
		if (id) resolved.push({
			input,
			resolved: true,
			id
		});
	}
	return resolved;
}
function formatSlackSocketReconnectMessage(params) {
	const maxAttempts = params.maxAttempts > 0 ? String(params.maxAttempts) : "∞";
	const suffix = params.error ? ` (${formatUnknownError(params.error)})` : "";
	return `slack socket disconnected (${params.event}); reconnecting in ${Math.round(params.delayMs / 1e3)}s (attempt ${params.attempt}/${maxAttempts})${suffix}`;
}
function formatSlackSocketStartRetryMessage(params) {
	const maxAttempts = params.maxAttempts > 0 ? String(params.maxAttempts) : "∞";
	const reason = formatUnknownError(params.error, "Slack Socket Mode start failed without error detail");
	const sdkContext = params.sdkContext?.trim() ? `; last SDK log: ${params.sdkContext.trim()}` : "";
	return `slack socket mode failed to start; retry ${params.attempt}/${maxAttempts} in ${Math.round(params.delayMs / 1e3)}s reason="${reason}${sdkContext}"`;
}
function parseApiAppIdFromAppToken(raw) {
	const token = raw?.trim();
	if (!token) return;
	return /^xapp-\d-([a-z0-9]+)-/i.exec(token)?.[1]?.toUpperCase();
}
async function monitorSlackProvider(opts = {}) {
	const cfg = opts.config ?? getRuntimeConfig();
	const runtime = opts.runtime ?? createNonExitingRuntime();
	let account = resolveSlackAccount({
		cfg,
		accountId: opts.accountId
	});
	if (!account.enabled) {
		runtime.log?.(`[${account.accountId}] slack account disabled; monitor startup skipped`);
		if (opts.abortSignal?.aborted) return;
		await new Promise((resolve) => {
			opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return;
	}
	const historyLimit = Math.max(0, account.config.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 50);
	const dmHistoryLimit = Math.max(0, account.config.dmHistoryLimit ?? 0);
	const sessionCfg = cfg.session;
	const sessionScope = sessionCfg?.scope ?? "per-sender";
	const mainKey = normalizeMainKey(sessionCfg?.mainKey);
	const slackMode = opts.mode ?? account.config.mode ?? "socket";
	const slackWebhookPath = normalizeSlackWebhookPath(account.config.webhookPath);
	const signingSecret = normalizeResolvedSecretInputString({
		value: account.config.signingSecret,
		path: `channels.slack.accounts.${account.accountId}.signingSecret`
	});
	const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
	const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
	if (!botToken || slackMode !== "http" && !appToken) {
		const missing = slackMode === "http" ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).` : `Slack bot + app tokens missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`;
		throw new Error(missing);
	}
	if (slackMode === "http" && !signingSecret) throw new Error(`Slack signing secret missing for account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`);
	const slackCfg = account.config;
	const dmConfig = slackCfg.dm;
	const dmEnabled = dmConfig?.enabled ?? true;
	const dmPolicy = resolveSlackAccountDmPolicy({
		cfg,
		accountId: account.accountId
	}) ?? "pairing";
	let allowFrom = resolveSlackAccountAllowFrom({
		cfg,
		accountId: account.accountId
	});
	const groupDmEnabled = dmConfig?.groupEnabled ?? false;
	const groupDmChannels = dmConfig?.groupChannels;
	let channelsConfig = slackCfg.channels;
	const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
	const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
		providerConfigPresent: cfg.channels?.slack !== void 0,
		groupPolicy: slackCfg.groupPolicy,
		defaultGroupPolicy
	});
	warnMissingProviderGroupPolicyFallbackOnce({
		providerMissingFallbackApplied,
		providerKey: "slack",
		accountId: account.accountId,
		log: (message) => runtime.log?.(warn(message))
	});
	const resolveToken = account.userToken || botToken;
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const reactionMode = slackCfg.reactionNotifications ?? "own";
	const reactionAllowlist = slackCfg.reactionAllowlist ?? [];
	const replyToMode = slackCfg.replyToMode ?? "off";
	const threadHistoryScope = slackCfg.thread?.historyScope ?? "thread";
	const threadInheritParent = slackCfg.thread?.inheritParent ?? false;
	const threadRequireExplicitMention = slackCfg.thread?.requireExplicitMention ?? false;
	const slashCommand = resolveSlackSlashCommandConfig(opts.slashCommand ?? slackCfg.slashCommand);
	const allowNameMatching = isDangerousNameMatchingEnabled(slackCfg);
	const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId, { fallbackLimit: SLACK_TEXT_LIMIT });
	const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
	const typingReaction = slackCfg.typingReaction?.trim() ?? "";
	const mediaMaxBytes = (opts.mediaMaxMb ?? slackCfg.mediaMaxMb ?? 20) * 1024 * 1024;
	const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
	const clientOptions = resolveSlackWebClientOptions();
	const { app, receiver, socketModeLogger } = createSlackBoltApp({
		interop: await getSlackBoltInterop(),
		slackMode,
		botToken,
		appToken: appToken ?? void 0,
		signingSecret: signingSecret ?? void 0,
		slackWebhookPath,
		clientOptions,
		...slackCfg.socketMode ? { socketMode: slackCfg.socketMode } : {}
	});
	const gracefulStop = async () => {
		await gracefulStopSlackApp(app);
	};
	const slackHttpHandler = slackMode === "http" && receiver ? async (req, res) => {
		const httpReceiver = receiver;
		const guard = installRequestBodyLimitGuard(req, res, {
			maxBytes: SLACK_WEBHOOK_MAX_BODY_BYTES,
			timeoutMs: SLACK_WEBHOOK_BODY_TIMEOUT_MS,
			responseFormat: "text"
		});
		if (guard.isTripped()) return;
		try {
			await Promise.resolve(httpReceiver.requestListener(req, res));
		} catch (err) {
			if (!guard.isTripped()) throw err;
		} finally {
			guard.dispose();
		}
	} : null;
	let unregisterHttpHandler = null;
	let botUserId = "";
	let botId = "";
	let teamId = "";
	let apiAppId = "";
	const expectedApiAppIdFromAppToken = parseApiAppIdFromAppToken(appToken);
	try {
		const auth = await app.client.auth.test({ token: botToken });
		botUserId = auth.user_id ?? "";
		botId = auth.bot_id ?? "";
		teamId = auth.team_id ?? "";
		apiAppId = auth.api_app_id ?? "";
	} catch {}
	if (apiAppId && expectedApiAppIdFromAppToken && apiAppId !== expectedApiAppIdFromAppToken) runtime.error?.(`slack token mismatch: bot token api_app_id=${apiAppId} but app token looks like api_app_id=${expectedApiAppIdFromAppToken}`);
	const ctx = createSlackMonitorContext({
		cfg,
		accountId: account.accountId,
		botToken,
		app,
		runtime,
		botUserId,
		botId,
		teamId,
		apiAppId,
		historyLimit,
		dmHistoryLimit,
		sessionScope,
		mainKey,
		dmEnabled,
		dmPolicy,
		allowFrom,
		allowNameMatching,
		groupDmEnabled,
		groupDmChannels,
		defaultRequireMention: slackCfg.requireMention,
		channelsConfig,
		groupPolicy,
		useAccessGroups,
		reactionMode,
		reactionAllowlist,
		replyToMode,
		threadHistoryScope,
		threadInheritParent,
		threadRequireExplicitMention,
		slashCommand,
		textLimit,
		ackReactionScope,
		typingReaction,
		mediaMaxBytes,
		removeAckAfterReply
	});
	const trackEvent = opts.setStatus ? () => {
		opts.setStatus({
			lastEventAt: Date.now(),
			lastInboundAt: Date.now()
		});
	} : void 0;
	const handleSlackMessage = createSlackMessageHandler({
		ctx,
		account,
		trackEvent
	});
	if (isSlackExecApprovalClientEnabled({
		cfg,
		accountId: account.accountId
	})) registerChannelRuntimeContext({
		channelRuntime: opts.channelRuntime,
		channelId: "slack",
		accountId: account.accountId,
		capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
		context: {
			app,
			config: slackCfg.execApprovals ?? {}
		},
		abortSignal: opts.abortSignal
	});
	registerSlackMonitorEvents({
		ctx,
		account,
		handleSlackMessage,
		trackEvent
	});
	await registerSlackMonitorSlashCommands({
		ctx,
		account,
		trackEvent
	});
	if (slackMode === "http" && slackHttpHandler) unregisterHttpHandler = registerSlackHttpHandler({
		path: slackWebhookPath,
		handler: slackHttpHandler,
		log: runtime.log,
		accountId: account.accountId
	});
	if (resolveToken) (async () => {
		if (opts.abortSignal?.aborted) return;
		if (channelsConfig && Object.keys(channelsConfig).length > 0) try {
			const entries = Object.keys(channelsConfig).filter((key) => key !== "*");
			if (entries.length > 0) {
				const resolved = await resolveSlackChannelAllowlist({
					token: resolveToken,
					entries
				});
				const nextChannels = { ...channelsConfig };
				const mapping = [];
				const unresolved = [];
				for (const entry of resolved) {
					const source = channelsConfig?.[entry.input];
					if (!source) continue;
					if (!entry.resolved || !entry.id) {
						unresolved.push(entry.input);
						continue;
					}
					mapping.push(formatSlackChannelResolved(entry));
					const existing = nextChannels[entry.id] ?? {};
					nextChannels[entry.id] = {
						...source,
						...existing
					};
				}
				channelsConfig = nextChannels;
				ctx.channelsConfig = nextChannels;
				summarizeMapping("slack channels", mapping, unresolved, runtime);
			}
		} catch (err) {
			runtime.log?.(`slack channel resolve failed; using config entries. ${formatUnknownError(err)}`);
		}
		const allowEntries = normalizeStringEntries(allowFrom).filter((entry) => entry !== "*");
		if (allowEntries.length > 0) {
			const stableResolvedUsers = resolveStableSlackUserAllowlistEntries(allowEntries);
			if (stableResolvedUsers.length > 0) {
				const { mapping, additions } = buildAllowlistResolutionSummary(stableResolvedUsers, { formatResolved: formatSlackUserResolved });
				allowFrom = mergeAllowlist({
					existing: allowFrom,
					additions
				});
				ctx.allowFrom = normalizeAllowList(allowFrom);
				summarizeMapping("slack users", mapping, [], runtime);
			}
			if (allowNameMatching) try {
				const { mapping, unresolved, additions } = buildAllowlistResolutionSummary(await resolveSlackUserAllowlist({
					token: resolveToken,
					entries: allowEntries
				}), { formatResolved: formatSlackUserResolved });
				allowFrom = mergeAllowlist({
					existing: allowFrom,
					additions
				});
				ctx.allowFrom = normalizeAllowList(allowFrom);
				summarizeMapping("slack users", mapping, unresolved, runtime);
			} catch (err) {
				runtime.log?.(`slack user resolve failed; using config entries. ${formatUnknownError(err)}`);
			}
		}
		if (channelsConfig && Object.keys(channelsConfig).length > 0) {
			const userEntries = /* @__PURE__ */ new Set();
			for (const channel of Object.values(channelsConfig)) addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
			if (userEntries.size > 0) {
				const stableResolvedUsers = resolveStableSlackUserAllowlistEntries(Array.from(userEntries));
				if (stableResolvedUsers.length > 0) {
					const { resolvedMap, mapping } = buildAllowlistResolutionSummary(stableResolvedUsers, { formatResolved: formatSlackUserResolved });
					const nextChannels = patchAllowlistUsersInConfigEntries({
						entries: channelsConfig,
						resolvedMap
					});
					channelsConfig = nextChannels;
					ctx.channelsConfig = nextChannels;
					summarizeMapping("slack channel users", mapping, [], runtime);
				}
				if (allowNameMatching) try {
					const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(await resolveSlackUserAllowlist({
						token: resolveToken,
						entries: Array.from(userEntries)
					}), { formatResolved: formatSlackUserResolved });
					const nextChannels = patchAllowlistUsersInConfigEntries({
						entries: channelsConfig,
						resolvedMap
					});
					channelsConfig = nextChannels;
					ctx.channelsConfig = nextChannels;
					summarizeMapping("slack channel users", mapping, unresolved, runtime);
				} catch (err) {
					runtime.log?.(`slack channel user resolve failed; using config entries. ${formatUnknownError(err)}`);
				}
			}
		}
	})();
	const stopOnAbort = () => {
		if (opts.abortSignal?.aborted && slackMode === "socket") gracefulStop();
	};
	opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
	try {
		if (slackMode === "socket") {
			let reconnectAttempts = 0;
			let hasLoggedSocketConnected = false;
			while (!opts.abortSignal?.aborted) try {
				const disconnect = await startSlackSocketAndWaitForDisconnect({
					app,
					abortSignal: opts.abortSignal,
					onStarted: () => {
						reconnectAttempts = 0;
						publishSlackConnectedStatus(opts.setStatus);
						if (!hasLoggedSocketConnected) {
							hasLoggedSocketConnected = true;
							runtime.log?.("slack socket mode connected");
						}
					}
				});
				if (!disconnect) break;
				if (opts.abortSignal?.aborted) break;
				publishSlackDisconnectedStatus(opts.setStatus, disconnect.error);
				if (disconnect.error && isNonRecoverableSlackAuthError(disconnect.error)) {
					runtime.error?.(`slack socket mode disconnected due to non-recoverable auth error — skipping channel (${formatUnknownError(disconnect.error)})`);
					throw disconnect.error instanceof Error ? disconnect.error : new Error(formatUnknownError(disconnect.error));
				}
				reconnectAttempts += 1;
				if (SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 && reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts) throw new Error(`Slack socket mode reconnect max attempts reached (${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts}) after ${disconnect.event}`);
				const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
				runtime.log?.(warn(formatSlackSocketReconnectMessage({
					event: disconnect.event,
					attempt: reconnectAttempts,
					maxAttempts: SLACK_SOCKET_RECONNECT_POLICY.maxAttempts,
					delayMs,
					error: disconnect.error
				})));
				await gracefulStop();
				try {
					await sleepWithAbort(delayMs, opts.abortSignal);
				} catch {
					break;
				}
			} catch (err) {
				if (isNonRecoverableSlackAuthError(err)) {
					runtime.error?.(`slack socket mode failed to start due to non-recoverable auth error — skipping channel (${formatUnknownError(err)})`);
					throw err;
				}
				reconnectAttempts += 1;
				if (SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 && reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts) throw err;
				const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
				runtime.error?.(formatSlackSocketStartRetryMessage({
					attempt: reconnectAttempts,
					maxAttempts: SLACK_SOCKET_RECONNECT_POLICY.maxAttempts,
					delayMs,
					error: err,
					sdkContext: socketModeLogger.getLastMessage()
				}));
				try {
					await sleepWithAbort(delayMs, opts.abortSignal);
				} catch {
					break;
				}
				continue;
			}
		} else {
			runtime.log?.(`slack http mode listening at ${slackWebhookPath}`);
			if (!opts.abortSignal?.aborted) await new Promise((resolve) => {
				opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
			});
		}
	} finally {
		opts.abortSignal?.removeEventListener("abort", stopOnAbort);
		unregisterHttpHandler?.();
		await gracefulStop();
	}
}
const resolveSlackRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
//#endregion
export { resolveSlackRuntimeGroupPolicy as n, monitorSlackProvider as t };
