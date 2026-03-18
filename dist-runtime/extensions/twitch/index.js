import { o as __toESM, t as __commonJSMin } from "../../chunk-DORXReHP.js";
import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import { Zn as buildChannelConfigSchema, fr as MarkdownConfigSchema } from "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../paths-DAoqckDF.js";
import "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-D6VN4BvH.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import "../../compat-CwB8x8Tr.js";
import "../../inbound-envelope-DsYY1Vpm.js";
import "../../run-command-B9zmAfEF.js";
import "../../device-pairing-CsJif6Rb.js";
import "../../line-DvbTO_h3.js";
import "../../upsert-with-lock-BkGBN4WL.js";
import "../../self-hosted-provider-setup-Bgv4n1Xv.js";
import "../../ollama-setup-CXkNt6CA.js";
import { n as buildPassiveProbedChannelStatusSummary } from "../../channel-status-summary-DPOZ4DXQ.js";
import { A as DataObject, B as Enumerable, C as transformTwitchApiResponse, D as HellFreezesOverError, E as extractUserName, F as mapOptional, G as missingTargetError, H as twitchSetupWizard, I as arrayToObject, J as DEFAULT_ACCOUNT_ID, K as normalizeToken, L as __decorate, M as accessTokenIsExpired, N as promiseWithResolvers, O as rtfm, P as mapNullable, R as __read, S as handleTwitchApiResponseError, T as extractUserId, U as generateMessageId, V as twitchSetupAdapter, W as isAccountConfigured, X as listAccountIds, Y as getAccountConfig, _ as EventEmitter, a as getClientManager, b as callTwitchApi, c as ChatClient, d as PartitionedTimeBasedRateLimiter, f as RateLimitReachedError, g as StaticAuthProvider, h as require_detect_node, i as stripMarkdownForTwitch, j as rawDataSymbol, k as CustomError, l as CachedGetter, m as createLogger$1, n as setTwitchRuntime, o as removeClientManager, p as CustomError$1, q as normalizeTwitchChannel, r as chunkTextForTwitch, s as resolveTwitchToken, t as monitorTwitchProvider, u as Cacheable, v as TokenInfo, w as HttpStatusCodeError, x as callTwitchApiRaw, y as InvalidTokenError, z as __spreadArray } from "../../monitor-ZF8iRZBl.js";
import { z } from "zod";
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/array/flatten.mjs
function flatten(arr) {
	var _a;
	return (_a = []).concat.apply(_a, __spreadArray([], __read(arr), false));
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+shared-utils@3.6.4/node_modules/@d-fischer/shared-utils/es/functions/object/indexBy.mjs
function indexBy(arr, keyFn) {
	if (typeof keyFn !== "function") {
		var key_1 = keyFn;
		keyFn = (function(value) {
			return value[key_1].toString();
		});
	}
	return arrayToObject(arr, function(val) {
		var _a;
		return _a = {}, _a[keyFn(val)] = val, _a;
	});
}
//#endregion
//#region node_modules/.pnpm/@twurple+common@8.0.3/node_modules/@twurple/common/lib/errors/RelationAssertionError.js
/**
* Thrown when a relation that is expected to never be null does return null.
*/
var RelationAssertionError = class extends CustomError {
	constructor() {
		super("Relation returned null - this may be a library bug or a race condition in your own code");
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+common@8.0.3/node_modules/@twurple/common/lib/relations.js
/** @private */
function checkRelationAssertion(value) {
	if (value == null) throw new RelationAssertionError();
	return value;
}
//#endregion
//#region node_modules/.pnpm/@twurple+common@8.0.3/node_modules/@twurple/common/lib/extensions/HelixExtension.js
/**
* A Twitch Extension.
*/
let HelixExtension = class HelixExtension extends DataObject {
	/**
	* The name of the extension's author.
	*/
	get authorName() {
		return this[rawDataSymbol].author_name;
	}
	/**
	* Whether bits are enabled for the extension.
	*/
	get bitsEnabled() {
		return this[rawDataSymbol].bits_enabled;
	}
	/**
	* Whether the extension can be installed.
	*/
	get installable() {
		return this[rawDataSymbol].can_install;
	}
	/**
	* The location of the extension's configuration.
	*/
	get configurationLocation() {
		return this[rawDataSymbol].configuration_location;
	}
	/**
	* The extension's description.
	*/
	get description() {
		return this[rawDataSymbol].description;
	}
	/**
	* The URL of the extension's terms of service.
	*/
	get tosUrl() {
		return this[rawDataSymbol].eula_tos_url;
	}
	/**
	* Whether the extension has support for sending chat messages.
	*/
	get hasChatSupport() {
		return this[rawDataSymbol].has_chat_support;
	}
	/**
	* The URL of the extension's default sized icon.
	*/
	get iconUrl() {
		return this[rawDataSymbol].icon_url;
	}
	/**
	* Gets the URL of the extension's icon in the given size.
	*
	* @param size The size of the icon.
	*/
	getIconUrl(size) {
		return this[rawDataSymbol].icon_urls[size];
	}
	/**
	* The extension's ID.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The extension's name.
	*/
	get name() {
		return this[rawDataSymbol].name;
	}
	/**
	* The URL of the extension's privacy policy.
	*/
	get privacyPolicyUrl() {
		return this[rawDataSymbol].privacy_policy_url;
	}
	/**
	* Whether the extension requests its users to share their identity with it.
	*/
	get requestsIdentityLink() {
		return this[rawDataSymbol].request_identity_link;
	}
	/**
	* The URLs of the extension's screenshots.
	*/
	get screenshotUrls() {
		return this[rawDataSymbol].screenshot_urls;
	}
	/**
	* The extension's activity state.
	*/
	get state() {
		return this[rawDataSymbol].state;
	}
	/**
	* The extension's level of support for subscriptions.
	*/
	get subscriptionsSupportLevel() {
		return this[rawDataSymbol].subscriptions_support_level;
	}
	/**
	* The extension's feature summary.
	*/
	get summary() {
		return this[rawDataSymbol].summary;
	}
	/**
	* The extension's support email address.
	*/
	get supportEmail() {
		return this[rawDataSymbol].support_email;
	}
	/**
	* The extension's version.
	*/
	get version() {
		return this[rawDataSymbol].version;
	}
	/**
	* The extension's feature summary for viewers.
	*/
	get viewerSummary() {
		return this[rawDataSymbol].viewer_summary;
	}
	/**
	* The extension's feature summary for viewers.
	*
	* @deprecated Use `viewerSummary` instead.
	*/
	get viewerSummery() {
		return this[rawDataSymbol].viewer_summary;
	}
	/**
	* The extension's allowed configuration URLs.
	*/
	get allowedConfigUrls() {
		return this[rawDataSymbol].allowlisted_config_urls;
	}
	/**
	* The extension's allowed panel URLs.
	*/
	get allowedPanelUrls() {
		return this[rawDataSymbol].allowlisted_panel_urls;
	}
	/**
	* The URL shown when a viewer opens the extension on a mobile device.
	*
	* If the extension does not have a mobile view, this is null.
	*/
	get mobileViewerUrl() {
		return this[rawDataSymbol].views.mobile?.viewer_url ?? null;
	}
	/**
	* The URL shown to the viewer when the extension is shown as a panel.
	*
	* If the extension does not have a panel view, this is null.
	*/
	get panelViewerUrl() {
		return this[rawDataSymbol].views.panel?.viewer_url ?? null;
	}
	/**
	* The height of the extension panel.
	*
	* If the extension does not have a panel view, this is null.
	*/
	get panelHeight() {
		return this[rawDataSymbol].views.panel?.height ?? null;
	}
	/**
	* Whether the extension can link to external content from its panel view.
	*
	* If the extension does not have a panel view, this is null.
	*/
	get panelCanLinkExternalContent() {
		return this[rawDataSymbol].views.panel?.can_link_external_content ?? null;
	}
	/**
	* The URL shown to the viewer when the extension is shown as a video overlay.
	*
	* If the extension does not have a overlay view, this is null.
	*/
	get overlayViewerUrl() {
		return this[rawDataSymbol].views.video_overlay?.viewer_url ?? null;
	}
	/**
	* Whether the extension can link to external content from its overlay view.
	*
	* If the extension does not have a overlay view, this is null.
	*/
	get overlayCanLinkExternalContent() {
		return this[rawDataSymbol].views.video_overlay?.can_link_external_content ?? null;
	}
	/**
	* The URL shown to the viewer when the extension is shown as a video component.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentViewerUrl() {
		return this[rawDataSymbol].views.component?.viewer_url ?? null;
	}
	/**
	* The aspect width of the extension's component view.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentAspectWidth() {
		return this[rawDataSymbol].views.component?.aspect_width ?? null;
	}
	/**
	* The aspect height of the extension's component view.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentAspectHeight() {
		return this[rawDataSymbol].views.component?.aspect_height ?? null;
	}
	/**
	* The horizontal aspect ratio of the extension's component view.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentAspectRatioX() {
		return this[rawDataSymbol].views.component?.aspect_ratio_x ?? null;
	}
	/**
	* The vertical aspect ratio of the extension's component view.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentAspectRatioY() {
		return this[rawDataSymbol].views.component?.aspect_ratio_y ?? null;
	}
	/**
	* Whether the extension's component view should automatically scale.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentAutoScales() {
		return this[rawDataSymbol].views.component?.autoscale ?? null;
	}
	/**
	* The base width of the extension's component view to use for scaling.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentScalePixels() {
		return this[rawDataSymbol].views.component?.scale_pixels ?? null;
	}
	/**
	* The target height of the extension's component view.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentTargetHeight() {
		return this[rawDataSymbol].views.component?.target_height ?? null;
	}
	/**
	* The size of the extension's component view.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentSize() {
		return this[rawDataSymbol].views.component?.size ?? null;
	}
	/**
	* Whether zooming is enabled for the extension's component view.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentZoom() {
		return this[rawDataSymbol].views.component?.zoom ?? null;
	}
	/**
	* The zoom pixels of the extension's component view.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentZoomPixels() {
		return this[rawDataSymbol].views.component?.zoom_pixels ?? null;
	}
	/**
	* Whether the extension can link to external content from its component view.
	*
	* If the extension does not have a component view, this is null.
	*/
	get componentCanLinkExternalContent() {
		return this[rawDataSymbol].views.component?.can_link_external_content ?? null;
	}
	/**
	* The URL shown to the viewer when the extension's configuration page is shown.
	*
	* If the extension does not have a config view, this is null.
	*/
	get configViewerUrl() {
		return this[rawDataSymbol].views.config?.viewer_url ?? null;
	}
	/**
	* Whether the extension can link to external content from its config view.
	*
	* If the extension does not have a config view, this is null.
	*/
	get configCanLinkExternalContent() {
		return this[rawDataSymbol].views.config?.can_link_external_content ?? null;
	}
};
HelixExtension = __decorate([rtfm("api", "HelixExtension", "id")], HelixExtension);
//#endregion
//#region node_modules/.pnpm/@twurple+api-call@8.0.3/node_modules/@twurple/api-call/lib/helpers/queries.external.js
function createBroadcasterQuery(user) {
	return { broadcaster_id: extractUserId(user) };
}
//#endregion
//#region node_modules/.pnpm/@d-fischer+rate-limiter@1.1.0/node_modules/@d-fischer/rate-limiter/es/errors/RetryAfterError.mjs
var RetryAfterError = class extends CustomError$1 {
	constructor(after) {
		super(`Need to retry after ${after} ms`);
		this._retryAt = Date.now() + after;
	}
	get retryAt() {
		return this._retryAt;
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+rate-limiter@1.1.0/node_modules/@d-fischer/rate-limiter/es/limiters/ResponseBasedRateLimiter.mjs
var ResponseBasedRateLimiter = class {
	constructor({ logger }) {
		this._queue = [];
		this._batchRunning = false;
		this._paused = false;
		this._logger = createLogger$1({
			name: "rate-limiter",
			emoji: true,
			...logger
		});
	}
	async request(req, options) {
		this._logger.trace("request start");
		return await new Promise((resolve, reject) => {
			var _a;
			const reqSpec = {
				req,
				resolve,
				reject,
				limitReachedBehavior: (_a = options === null || options === void 0 ? void 0 : options.limitReachedBehavior) !== null && _a !== void 0 ? _a : "enqueue"
			};
			if (this._batchRunning || !!this._nextBatchTimer || this._paused) {
				this._logger.trace(`request queued batchRunning:${this._batchRunning.toString()} hasNextBatchTimer:${(!!this._nextBatchTimer).toString()} paused:${this._paused.toString()}`);
				this._queue.push(reqSpec);
			} else this._runRequestBatch([reqSpec]);
		});
	}
	clear() {
		this._queue = [];
	}
	pause() {
		this._paused = true;
	}
	resume() {
		this._paused = false;
		this._runNextBatch();
	}
	get stats() {
		var _a, _b, _c, _d, _e;
		return {
			lastKnownLimit: (_b = (_a = this._parameters) === null || _a === void 0 ? void 0 : _a.limit) !== null && _b !== void 0 ? _b : null,
			lastKnownRemainingRequests: (_d = (_c = this._parameters) === null || _c === void 0 ? void 0 : _c.remaining) !== null && _d !== void 0 ? _d : null,
			lastKnownResetDate: mapNullable((_e = this._parameters) === null || _e === void 0 ? void 0 : _e.resetsAt, (v) => new Date(v))
		};
	}
	async _runRequestBatch(reqSpecs) {
		this._logger.trace(`runRequestBatch start specs:${reqSpecs.length}`);
		this._batchRunning = true;
		if (this._parameters) this._logger.debug(`Remaining requests: ${this._parameters.remaining}`);
		this._logger.debug(`Doing ${reqSpecs.length} requests, new queue length is ${this._queue.length}`);
		const promises = reqSpecs.map(async (reqSpec) => {
			const { req, resolve, reject } = reqSpec;
			try {
				const result = await this.doRequest(req);
				const retry = this.needsToRetryAfter(result);
				if (retry !== null) {
					this._queue.unshift(reqSpec);
					this._logger.info(`Retrying after ${retry} ms`);
					throw new RetryAfterError(retry);
				}
				const params = this.getParametersFromResponse(result);
				resolve(result);
				return params;
			} catch (e) {
				if (e instanceof RetryAfterError) throw e;
				reject(e);
				return;
			}
		});
		const settledPromises = await Promise.allSettled(promises);
		const rejectedPromises = settledPromises.filter((p) => p.status === "rejected");
		const now = Date.now();
		if (rejectedPromises.length) {
			this._logger.trace("runRequestBatch some rejected");
			const retryAfter = Math.max(now, ...rejectedPromises.map((p) => p.reason.retryAt)) - now;
			this._logger.warn(`Waiting for ${retryAfter} ms because the rate limit was exceeded`);
			this._nextBatchTimer = setTimeout(() => {
				this._parameters = void 0;
				this._runNextBatch();
			}, retryAfter);
		} else {
			this._logger.trace("runRequestBatch none rejected");
			const params = settledPromises.filter((p) => p.status === "fulfilled" && p.value !== void 0).map((p) => p.value).reduce((carry, v) => {
				if (!carry) return v;
				return v.remaining < carry.remaining ? v : carry;
			}, void 0);
			this._batchRunning = false;
			if (params) {
				this._parameters = params;
				if (params.resetsAt < now || params.remaining > 0) {
					this._logger.trace("runRequestBatch canRunMore");
					this._runNextBatch();
				} else {
					const delay = params.resetsAt - now;
					this._logger.trace(`runRequestBatch delay:${delay}`);
					this._logger.warn(`Waiting for ${delay} ms because the rate limit was reached`);
					this._queue = this._queue.filter((entry) => {
						switch (entry.limitReachedBehavior) {
							case "enqueue": return true;
							case "null":
								entry.resolve(null);
								return false;
							case "throw":
								entry.reject(new RateLimitReachedError("Request removed from queue because the rate limit was reached"));
								return false;
							default: throw new Error("this should never happen");
						}
					});
					this._nextBatchTimer = setTimeout(() => {
						this._parameters = void 0;
						this._runNextBatch();
					}, delay);
				}
			}
		}
		this._logger.trace("runRequestBatch end");
	}
	_runNextBatch() {
		if (this._paused) return;
		this._logger.trace("runNextBatch start");
		if (this._nextBatchTimer) {
			clearTimeout(this._nextBatchTimer);
			this._nextBatchTimer = void 0;
		}
		const amount = this._parameters ? Math.min(this._parameters.remaining, this._parameters.limit / 10) : 1;
		const reqSpecs = this._queue.splice(0, amount);
		if (reqSpecs.length) this._runRequestBatch(reqSpecs);
		this._logger.trace("runNextBatch end");
	}
};
//#endregion
//#region node_modules/.pnpm/@d-fischer+rate-limiter@1.1.0/node_modules/@d-fischer/rate-limiter/es/limiters/PartitionedRateLimiter.mjs
var PartitionedRateLimiter = class {
	constructor(options) {
		this._children = /* @__PURE__ */ new Map();
		this._paused = false;
		this._partitionKeyCallback = options.getPartitionKey;
		this._createChildCallback = options.createChild;
	}
	async request(req, options) {
		const partitionKey = this._partitionKeyCallback(req);
		return await this._getChild(partitionKey).request(req, options);
	}
	clear() {
		for (const child of this._children.values()) child.clear();
	}
	pause() {
		this._paused = true;
		for (const child of this._children.values()) child.pause();
	}
	resume() {
		this._paused = false;
		for (const child of this._children.values()) child.resume();
	}
	getChildStats(partitionKey) {
		if (!this._children.has(partitionKey)) return null;
		const child = this._children.get(partitionKey);
		if (!(child instanceof ResponseBasedRateLimiter)) return null;
		return child.stats;
	}
	_getChild(partitionKey) {
		if (this._children.has(partitionKey)) return this._children.get(partitionKey);
		const result = this._createChildCallback(partitionKey);
		if (this._paused) result.pause();
		this._children.set(partitionKey, result);
		return result;
	}
};
//#endregion
//#region extensions/twitch/src/send.ts
/**
* Internal send function used by the outbound adapter.
*
* This function has access to the full OpenClaw config and handles
* account resolution, markdown stripping, and actual message sending.
*
* @param channel - The channel name
* @param text - The message text
* @param cfg - Full OpenClaw configuration
* @param accountId - Account ID to use
* @param stripMarkdown - Whether to strip markdown (default: true)
* @param logger - Logger instance
* @returns Result with message ID and status
*
* @example
* const result = await sendMessageTwitchInternal(
*   "#mychannel",
*   "Hello Twitch!",
*   openclawConfig,
*   "default",
*   true,
*   console,
* );
*/
async function sendMessageTwitchInternal(channel, text, cfg, accountId = DEFAULT_ACCOUNT_ID, stripMarkdown = true, logger = console) {
	const account = getAccountConfig(cfg, accountId);
	if (!account) {
		const availableIds = Object.keys(cfg.channels?.twitch?.accounts ?? {});
		return {
			ok: false,
			messageId: generateMessageId(),
			error: `Account not found: ${accountId}. Available accounts: ${availableIds.join(", ") || "none"}`
		};
	}
	if (!isAccountConfigured(account, resolveTwitchToken(cfg, { accountId }).token)) return {
		ok: false,
		messageId: generateMessageId(),
		error: `Account ${accountId} is not properly configured. Required: username, clientId, and token (config or env for default account).`
	};
	const normalizedChannel = channel || account.channel;
	if (!normalizedChannel) return {
		ok: false,
		messageId: generateMessageId(),
		error: "No channel specified and no default channel in account config"
	};
	const cleanedText = stripMarkdown ? stripMarkdownForTwitch(text) : text;
	if (!cleanedText) return {
		ok: true,
		messageId: "skipped"
	};
	const clientManager = getClientManager(accountId);
	if (!clientManager) return {
		ok: false,
		messageId: generateMessageId(),
		error: `Client manager not found for account: ${accountId}. Please start the Twitch gateway first.`
	};
	try {
		const result = await clientManager.sendMessage(account, normalizeTwitchChannel(normalizedChannel), cleanedText, cfg, accountId);
		if (!result.ok) return {
			ok: false,
			messageId: result.messageId ?? generateMessageId(),
			error: result.error ?? "Send failed"
		};
		return {
			ok: true,
			messageId: result.messageId ?? generateMessageId()
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.error(`Failed to send message: ${errorMsg}`);
		return {
			ok: false,
			messageId: generateMessageId(),
			error: errorMsg
		};
	}
}
//#endregion
//#region extensions/twitch/src/outbound.ts
/**
* Twitch outbound adapter for sending messages.
*
* Implements the ChannelOutboundAdapter interface for Twitch chat.
* Supports text and media (URL) sending with markdown stripping and chunking.
*/
/**
* Twitch outbound adapter.
*
* Handles sending text and media to Twitch channels with automatic
* markdown stripping and message chunking.
*/
const twitchOutbound = {
	deliveryMode: "direct",
	textChunkLimit: 500,
	chunker: chunkTextForTwitch,
	resolveTarget: ({ to, allowFrom, mode }) => {
		const trimmed = to?.trim() ?? "";
		const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
		const hasWildcard = allowListRaw.includes("*");
		const allowList = allowListRaw.filter((entry) => entry !== "*").map((entry) => normalizeTwitchChannel(entry)).filter((entry) => entry.length > 0);
		if (trimmed) {
			const normalizedTo = normalizeTwitchChannel(trimmed);
			if (!normalizedTo) return {
				ok: false,
				error: missingTargetError("Twitch", "<channel-name>")
			};
			if (mode === "implicit" || mode === "heartbeat") {
				if (hasWildcard || allowList.length === 0) return {
					ok: true,
					to: normalizedTo
				};
				if (allowList.includes(normalizedTo)) return {
					ok: true,
					to: normalizedTo
				};
				return {
					ok: false,
					error: missingTargetError("Twitch", "<channel-name>")
				};
			}
			return {
				ok: true,
				to: normalizedTo
			};
		}
		return {
			ok: false,
			error: missingTargetError("Twitch", "<channel-name>")
		};
	},
	sendText: async (params) => {
		const { cfg, to, text, accountId } = params;
		if (params.signal?.aborted) throw new Error("Outbound delivery aborted");
		const resolvedAccountId = accountId ?? "default";
		const account = getAccountConfig(cfg, resolvedAccountId);
		if (!account) {
			const availableIds = Object.keys(cfg.channels?.twitch?.accounts ?? {});
			throw new Error(`Twitch account not found: ${resolvedAccountId}. Available accounts: ${availableIds.join(", ") || "none"}`);
		}
		const channel = to || account.channel;
		if (!channel) throw new Error("No channel specified and no default channel in account config");
		const result = await sendMessageTwitchInternal(normalizeTwitchChannel(channel), text, cfg, resolvedAccountId, true, console);
		if (!result.ok) throw new Error(result.error ?? "Send failed");
		return {
			channel: "twitch",
			messageId: result.messageId,
			timestamp: Date.now()
		};
	},
	sendMedia: async (params) => {
		const { text, mediaUrl } = params;
		if (params.signal?.aborted) throw new Error("Outbound delivery aborted");
		const message = mediaUrl ? `${text || ""} ${mediaUrl}`.trim() : text;
		if (!twitchOutbound.sendText) throw new Error("sendText not implemented");
		return twitchOutbound.sendText({
			...params,
			text: message
		});
	}
};
//#endregion
//#region extensions/twitch/src/actions.ts
/**
* Twitch message actions adapter.
*
* Handles tool-based actions for Twitch, such as sending messages.
*/
/**
* Create a tool result with error content.
*/
function errorResponse(error) {
	return {
		content: [{
			type: "text",
			text: JSON.stringify({
				ok: false,
				error
			})
		}],
		details: { ok: false }
	};
}
/**
* Read a string parameter from action arguments.
*
* @param args - Action arguments
* @param key - Parameter key
* @param options - Options for reading the parameter
* @returns The parameter value or undefined if not found
*/
function readStringParam(args, key, options = {}) {
	const value = args[key];
	if (value === void 0 || value === null) {
		if (options.required) throw new Error(`Missing required parameter: ${key}`);
		return;
	}
	if (typeof value === "string") return options.trim !== false ? value.trim() : value;
	if (typeof value === "number" || typeof value === "boolean") {
		const str = String(value);
		return options.trim !== false ? str.trim() : str;
	}
	throw new Error(`Parameter ${key} must be a string, number, or boolean`);
}
/** Supported Twitch actions */
const TWITCH_ACTIONS = new Set(["send"]);
/**
* Twitch message actions adapter.
*/
const twitchMessageActions = {
	listActions: () => [...TWITCH_ACTIONS],
	supportsAction: ({ action }) => TWITCH_ACTIONS.has(action),
	extractToolSend: ({ args }) => {
		try {
			const to = readStringParam(args, "to", { required: true });
			const message = readStringParam(args, "message", { required: true });
			if (!to || !message) return null;
			return {
				to,
				message
			};
		} catch {
			return null;
		}
	},
	handleAction: async (ctx) => {
		if (ctx.action !== "send") return {
			content: [{
				type: "text",
				text: "Unsupported action"
			}],
			details: {
				ok: false,
				error: "Unsupported action"
			}
		};
		const message = readStringParam(ctx.params, "message", { required: true });
		const to = readStringParam(ctx.params, "to", { required: false });
		const accountId = ctx.accountId ?? "default";
		const account = getAccountConfig(ctx.cfg, accountId);
		if (!account) return errorResponse(`Account not found: ${accountId}. Available accounts: ${Object.keys(ctx.cfg.channels?.twitch?.accounts ?? {}).join(", ") || "none"}`);
		const targetChannel = to || account.channel;
		if (!targetChannel) return errorResponse("No channel specified and no default channel in account config");
		if (!twitchOutbound.sendText) return errorResponse("sendText not implemented");
		try {
			const result = await twitchOutbound.sendText({
				cfg: ctx.cfg,
				to: targetChannel,
				text: message ?? "",
				accountId
			});
			return {
				content: [{
					type: "text",
					text: JSON.stringify(result)
				}],
				details: { ok: true }
			};
		} catch (error) {
			return errorResponse(error instanceof Error ? error.message : String(error));
		}
	}
};
//#endregion
//#region extensions/twitch/src/config-schema.ts
/**
* Twitch user roles that can be allowed to interact with the bot
*/
const TwitchRoleSchema = z.enum([
	"moderator",
	"owner",
	"vip",
	"subscriber",
	"all"
]);
/**
* Twitch account configuration schema
*/
const TwitchAccountSchema = z.object({
	username: z.string(),
	accessToken: z.string(),
	clientId: z.string().optional(),
	channel: z.string().min(1),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.string()).optional(),
	allowedRoles: z.array(TwitchRoleSchema).optional(),
	requireMention: z.boolean().optional(),
	responsePrefix: z.string().optional(),
	clientSecret: z.string().optional(),
	refreshToken: z.string().optional(),
	expiresIn: z.number().nullable().optional(),
	obtainmentTimestamp: z.number().optional()
});
/**
* Base configuration properties shared by both single and multi-account modes
*/
const TwitchConfigBaseSchema = z.object({
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	markdown: MarkdownConfigSchema.optional()
});
/**
* Simplified single-account configuration schema
*
* Use this for single-account setups. Properties are at the top level,
* creating an implicit "default" account.
*/
const SimplifiedSchema = z.intersection(TwitchConfigBaseSchema, TwitchAccountSchema);
/**
* Multi-account configuration schema
*
* Use this for multi-account setups. Each key is an account ID (e.g., "default", "secondary").
*/
const MultiAccountSchema = z.intersection(TwitchConfigBaseSchema, z.object({ accounts: z.record(z.string(), TwitchAccountSchema) }).refine((val) => Object.keys(val.accounts || {}).length > 0, { message: "accounts must contain at least one entry" }));
/**
* Twitch plugin configuration schema
*
* Supports two mutually exclusive patterns:
* 1. Simplified single-account: username, accessToken, clientId, channel at top level
* 2. Multi-account: accounts object with named account configs
*
* The union ensures clear discrimination between the two modes.
*/
const TwitchConfigSchema = z.union([SimplifiedSchema, MultiAccountSchema]);
//#endregion
//#region extensions/twitch/src/probe.ts
/**
* Probe a Twitch account to verify the connection is working
*
* This tests the Twitch OAuth token by attempting to connect
* to the chat server and verify the bot's username.
*/
async function probeTwitch(account, timeoutMs) {
	const started = Date.now();
	if (!account.accessToken || !account.username) return {
		ok: false,
		error: "missing credentials (accessToken, username)",
		username: account.username,
		elapsedMs: Date.now() - started
	};
	const rawToken = normalizeToken(account.accessToken.trim());
	let client;
	try {
		client = new ChatClient({ authProvider: new StaticAuthProvider(account.clientId ?? "", rawToken) });
		const connectionPromise = new Promise((resolve, reject) => {
			let settled = false;
			let connectListener;
			let disconnectListener;
			let authFailListener;
			const cleanup = () => {
				if (settled) return;
				settled = true;
				connectListener?.unbind();
				disconnectListener?.unbind();
				authFailListener?.unbind();
			};
			connectListener = client?.onConnect(() => {
				cleanup();
				resolve();
			});
			disconnectListener = client?.onDisconnect((_manually, reason) => {
				cleanup();
				reject(reason || /* @__PURE__ */ new Error("Disconnected"));
			});
			authFailListener = client?.onAuthenticationFailure(() => {
				cleanup();
				reject(/* @__PURE__ */ new Error("Authentication failed"));
			});
		});
		const timeout = new Promise((_, reject) => {
			setTimeout(() => reject(/* @__PURE__ */ new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
		});
		client.connect();
		await Promise.race([connectionPromise, timeout]);
		client.quit();
		client = void 0;
		return {
			ok: true,
			connected: true,
			username: account.username,
			channel: account.channel,
			elapsedMs: Date.now() - started
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			username: account.username,
			channel: account.channel,
			elapsedMs: Date.now() - started
		};
	} finally {
		if (client) try {
			client.quit();
		} catch {}
	}
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/errors/ConfigError.js
/**
* Thrown whenever you try using invalid values in the client configuration.
*/
var ConfigError = class extends CustomError {};
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/utils/HelixRateLimiter.js
/** @internal */
var HelixRateLimiter = class extends ResponseBasedRateLimiter {
	async doRequest({ options, clientId, accessToken, authorizationType, fetchOptions }) {
		return await callTwitchApiRaw(options, clientId, accessToken, authorizationType, fetchOptions);
	}
	needsToRetryAfter(res) {
		if (res.status === 429 && (!res.headers.has("ratelimit-remaining") || Number(res.headers.get("ratelimit-remaining")) === 0)) return +res.headers.get("ratelimit-reset") * 1e3 - Date.now();
		return null;
	}
	getParametersFromResponse(res) {
		const { headers } = res;
		return {
			limit: +headers.get("ratelimit-limit"),
			remaining: +headers.get("ratelimit-remaining"),
			resetsAt: +headers.get("ratelimit-reset") * 1e3
		};
	}
};
//#endregion
//#region node_modules/.pnpm/retry@0.13.1/node_modules/retry/lib/retry_operation.js
var require_retry_operation = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function RetryOperation(timeouts, options) {
		if (typeof options === "boolean") options = { forever: options };
		this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
		this._timeouts = timeouts;
		this._options = options || {};
		this._maxRetryTime = options && options.maxRetryTime || Infinity;
		this._fn = null;
		this._errors = [];
		this._attempts = 1;
		this._operationTimeout = null;
		this._operationTimeoutCb = null;
		this._timeout = null;
		this._operationStart = null;
		this._timer = null;
		if (this._options.forever) this._cachedTimeouts = this._timeouts.slice(0);
	}
	module.exports = RetryOperation;
	RetryOperation.prototype.reset = function() {
		this._attempts = 1;
		this._timeouts = this._originalTimeouts.slice(0);
	};
	RetryOperation.prototype.stop = function() {
		if (this._timeout) clearTimeout(this._timeout);
		if (this._timer) clearTimeout(this._timer);
		this._timeouts = [];
		this._cachedTimeouts = null;
	};
	RetryOperation.prototype.retry = function(err) {
		if (this._timeout) clearTimeout(this._timeout);
		if (!err) return false;
		var currentTime = (/* @__PURE__ */ new Date()).getTime();
		if (err && currentTime - this._operationStart >= this._maxRetryTime) {
			this._errors.push(err);
			this._errors.unshift(/* @__PURE__ */ new Error("RetryOperation timeout occurred"));
			return false;
		}
		this._errors.push(err);
		var timeout = this._timeouts.shift();
		if (timeout === void 0) if (this._cachedTimeouts) {
			this._errors.splice(0, this._errors.length - 1);
			timeout = this._cachedTimeouts.slice(-1);
		} else return false;
		var self = this;
		this._timer = setTimeout(function() {
			self._attempts++;
			if (self._operationTimeoutCb) {
				self._timeout = setTimeout(function() {
					self._operationTimeoutCb(self._attempts);
				}, self._operationTimeout);
				if (self._options.unref) self._timeout.unref();
			}
			self._fn(self._attempts);
		}, timeout);
		if (this._options.unref) this._timer.unref();
		return true;
	};
	RetryOperation.prototype.attempt = function(fn, timeoutOps) {
		this._fn = fn;
		if (timeoutOps) {
			if (timeoutOps.timeout) this._operationTimeout = timeoutOps.timeout;
			if (timeoutOps.cb) this._operationTimeoutCb = timeoutOps.cb;
		}
		var self = this;
		if (this._operationTimeoutCb) this._timeout = setTimeout(function() {
			self._operationTimeoutCb();
		}, self._operationTimeout);
		this._operationStart = (/* @__PURE__ */ new Date()).getTime();
		this._fn(this._attempts);
	};
	RetryOperation.prototype.try = function(fn) {
		console.log("Using RetryOperation.try() is deprecated");
		this.attempt(fn);
	};
	RetryOperation.prototype.start = function(fn) {
		console.log("Using RetryOperation.start() is deprecated");
		this.attempt(fn);
	};
	RetryOperation.prototype.start = RetryOperation.prototype.try;
	RetryOperation.prototype.errors = function() {
		return this._errors;
	};
	RetryOperation.prototype.attempts = function() {
		return this._attempts;
	};
	RetryOperation.prototype.mainError = function() {
		if (this._errors.length === 0) return null;
		var counts = {};
		var mainError = null;
		var mainErrorCount = 0;
		for (var i = 0; i < this._errors.length; i++) {
			var error = this._errors[i];
			var message = error.message;
			var count = (counts[message] || 0) + 1;
			counts[message] = count;
			if (count >= mainErrorCount) {
				mainError = error;
				mainErrorCount = count;
			}
		}
		return mainError;
	};
}));
//#endregion
//#region node_modules/.pnpm/retry@0.13.1/node_modules/retry/lib/retry.js
var require_retry$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var RetryOperation = require_retry_operation();
	exports.operation = function(options) {
		return new RetryOperation(exports.timeouts(options), {
			forever: options && (options.forever || options.retries === Infinity),
			unref: options && options.unref,
			maxRetryTime: options && options.maxRetryTime
		});
	};
	exports.timeouts = function(options) {
		if (options instanceof Array) return [].concat(options);
		var opts = {
			retries: 10,
			factor: 2,
			minTimeout: 1 * 1e3,
			maxTimeout: Infinity,
			randomize: false
		};
		for (var key in options) opts[key] = options[key];
		if (opts.minTimeout > opts.maxTimeout) throw new Error("minTimeout is greater than maxTimeout");
		var timeouts = [];
		for (var i = 0; i < opts.retries; i++) timeouts.push(this.createTimeout(i, opts));
		if (options && options.forever && !timeouts.length) timeouts.push(this.createTimeout(i, opts));
		timeouts.sort(function(a, b) {
			return a - b;
		});
		return timeouts;
	};
	exports.createTimeout = function(attempt, opts) {
		var random = opts.randomize ? Math.random() + 1 : 1;
		var timeout = Math.round(random * Math.max(opts.minTimeout, 1) * Math.pow(opts.factor, attempt));
		timeout = Math.min(timeout, opts.maxTimeout);
		return timeout;
	};
	exports.wrap = function(obj, options, methods) {
		if (options instanceof Array) {
			methods = options;
			options = null;
		}
		if (!methods) {
			methods = [];
			for (var key in obj) if (typeof obj[key] === "function") methods.push(key);
		}
		for (var i = 0; i < methods.length; i++) {
			var method = methods[i];
			var original = obj[method];
			obj[method] = function retryWrapper(original) {
				var op = exports.operation(options);
				var args = Array.prototype.slice.call(arguments, 1);
				var callback = args.pop();
				args.push(function(err) {
					if (op.retry(err)) return;
					if (err) arguments[0] = op.mainError();
					callback.apply(this, arguments);
				});
				op.attempt(function() {
					original.apply(obj, args);
				});
			}.bind(obj, original);
			obj[method].options = options;
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/retry@0.13.1/node_modules/retry/index.js
var require_retry = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_retry$1();
}));
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/bits.external.js
/** @internal */
function createBitsLeaderboardQuery(params = {}) {
	const { count = 10, period = "all", startDate, contextUserId } = params;
	return {
		count: count.toString(),
		period,
		started_at: startDate?.toISOString(),
		user_id: contextUserId
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/BaseApi.js
/** @private */
var BaseApi = class {
	/** @internal */ _client;
	/** @internal */
	constructor(client) {
		this._client = client;
	}
	/** @internal */
	_getUserContextIdWithDefault(userId) {
		return this._client._getUserIdFromRequestContext(userId) ?? userId;
	}
};
__decorate([Enumerable(false)], BaseApi.prototype, "_client", void 0);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/bits/HelixBitsLeaderboardEntry.js
/**
* A Bits leaderboard entry.
*/
let HelixBitsLeaderboardEntry = class HelixBitsLeaderboardEntry extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the user on the leaderboard.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the user on the leaderboard.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user on the leaderboard.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* The position of the user on the leaderboard.
	*/
	get rank() {
		return this[rawDataSymbol].rank;
	}
	/**
	* The amount of bits used in the given period of time.
	*/
	get amount() {
		return this[rawDataSymbol].score;
	}
	/**
	* Gets the user of entry on the leaderboard.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
};
__decorate([Enumerable(false)], HelixBitsLeaderboardEntry.prototype, "_client", void 0);
HelixBitsLeaderboardEntry = __decorate([rtfm("api", "HelixBitsLeaderboardEntry", "userId")], HelixBitsLeaderboardEntry);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/bits/HelixBitsLeaderboard.js
/**
* A leaderboard where the users who used the most bits to a broadcaster are listed.
*/
let HelixBitsLeaderboard = class HelixBitsLeaderboard extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The entries of the leaderboard.
	*/
	get entries() {
		return this[rawDataSymbol].data.map((entry) => new HelixBitsLeaderboardEntry(entry, this._client));
	}
	/**
	* The total amount of people on the requested leaderboard.
	*/
	get totalCount() {
		return this[rawDataSymbol].total;
	}
};
__decorate([Enumerable(false)], HelixBitsLeaderboard.prototype, "_client", void 0);
__decorate([CachedGetter()], HelixBitsLeaderboard.prototype, "entries", null);
HelixBitsLeaderboard = __decorate([Cacheable, rtfm("api", "HelixBitsLeaderboard")], HelixBitsLeaderboard);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/bits/HelixCheermoteList.js
/**
* A list of cheermotes you can use globally or in a specific channel, depending on how you fetched the list.
*
* @inheritDoc
*/
let HelixCheermoteList = class HelixCheermoteList extends DataObject {
	/** @internal */
	constructor(data) {
		super(indexBy(data, (action) => action.prefix.toLowerCase()));
	}
	/**
	* Gets the URL and color needed to properly represent a cheer of the given amount of bits with the given prefix.
	*
	* @param name The name/prefix of the cheermote.
	* @param bits The amount of bits cheered.
	* @param format The format of the cheermote you want to request.
	*/
	getCheermoteDisplayInfo(name, bits, format) {
		name = name.toLowerCase();
		const { background, state, scale } = format;
		const { tiers } = this[rawDataSymbol][name];
		const correctTier = tiers.sort((a, b) => b.min_bits - a.min_bits).find((tier) => tier.min_bits <= bits);
		if (!correctTier) throw new HellFreezesOverError(`Cheermote "${name}" does not have an applicable tier for ${bits} bits`);
		return {
			url: correctTier.images[background][state][scale],
			color: correctTier.color
		};
	}
	/**
	* Gets all possible cheermote names.
	*/
	getPossibleNames() {
		return Object.keys(this[rawDataSymbol]);
	}
};
HelixCheermoteList = __decorate([rtfm("api", "HelixCheermoteList")], HelixCheermoteList);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/bits/HelixBitsApi.js
/**
* The Helix API methods that deal with bits.
*
* Can be accessed using `client.bits` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const leaderboard = await api.bits.getLeaderboard({ period: 'day' });
* ```
*
* @meta category helix
* @meta categorizedTitle Bits
*/
let HelixBitsApi = class HelixBitsApi extends BaseApi {
	/**
	* Gets a bits leaderboard of your channel.
	*
	* @param broadcaster The user to get the leaderboard of.
	* @param params
	* @expandParams
	*/
	async getLeaderboard(broadcaster, params = {}) {
		return new HelixBitsLeaderboard(await this._client.callApi({
			type: "helix",
			url: "bits/leaderboard",
			userId: extractUserId(broadcaster),
			scopes: ["bits:read"],
			query: createBitsLeaderboardQuery(params)
		}), this._client);
	}
	/**
	* Gets all available cheermotes.
	*
	* @param broadcaster The broadcaster to include custom cheermotes of.
	*
	* If not given, only get global cheermotes.
	*/
	async getCheermotes(broadcaster) {
		return new HelixCheermoteList((await this._client.callApi({
			type: "helix",
			url: "bits/cheermotes",
			userId: mapOptional(broadcaster, extractUserId),
			query: mapOptional(broadcaster, createBroadcasterQuery)
		})).data);
	}
};
HelixBitsApi = __decorate([rtfm("api", "HelixBitsApi")], HelixBitsApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/channel.external.js
/** @internal */
function createChannelUpdateBody(data) {
	return {
		game_id: data.gameId,
		broadcaster_language: data.language,
		title: data.title,
		delay: data.delay?.toString(),
		tags: data.tags,
		content_classification_labels: data.contentClassificationLabels,
		is_branded_content: data.isBrandedContent
	};
}
/** @internal */
function createChannelCommercialBody(broadcaster, length) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		length
	};
}
/** @internal */
function createChannelVipUpdateQuery(broadcaster, user) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		user_id: extractUserId(user)
	};
}
/** @internal */
function createChannelFollowerQuery(broadcaster, user) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		user_id: mapOptional(user, extractUserId)
	};
}
/** @internal */
function createFollowedChannelQuery(user, broadcaster) {
	return {
		broadcaster_id: mapOptional(broadcaster, extractUserId),
		user_id: extractUserId(user)
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/generic.external.js
/** @internal */
function createSingleKeyQuery(key, value) {
	return { [key]: value };
}
/** @internal */
function createUserQuery(user) {
	return { user_id: extractUserId(user) };
}
/** @internal */
function createModeratorActionQuery(broadcaster, moderatorId) {
	return {
		broadcaster_id: broadcaster,
		moderator_id: moderatorId
	};
}
/** @internal */
function createGetByIdsQuery(broadcaster, rewardIds) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		id: rewardIds
	};
}
/** @internal */
function createChannelUsersCheckQuery(broadcaster, users) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		user_id: users.map(extractUserId)
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/relations/HelixUserRelation.js
/**
* A relation of anything with a user.
*/
let HelixUserRelation = class HelixUserRelation extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the user.
	*/
	get id() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the user.
	*/
	get name() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user.
	*/
	get displayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets additional information about the user.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
};
__decorate([Enumerable(false)], HelixUserRelation.prototype, "_client", void 0);
HelixUserRelation = __decorate([rtfm("api", "HelixUserRelation", "id")], HelixUserRelation);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/utils/HelixRequestBatcher.js
/** @internal */
var HelixRequestBatcher = class {
	_callOptions;
	_queryParamName;
	_matchKey;
	_mapper;
	_limitPerRequest;
	_client;
	_requestedIds = [];
	_requestResolversById = /* @__PURE__ */ new Map();
	_delay;
	_waitTimer = null;
	constructor(_callOptions, _queryParamName, _matchKey, client, _mapper, _limitPerRequest = 100) {
		this._callOptions = _callOptions;
		this._queryParamName = _queryParamName;
		this._matchKey = _matchKey;
		this._mapper = _mapper;
		this._limitPerRequest = _limitPerRequest;
		this._client = client;
		this._delay = client._batchDelay;
	}
	async request(id) {
		const { promise, resolve, reject } = promiseWithResolvers();
		if (!this._requestedIds.includes(id)) this._requestedIds.push(id);
		if (this._requestResolversById.has(id)) this._requestResolversById.get(id).push({
			resolve,
			reject
		});
		else this._requestResolversById.set(id, [{
			resolve,
			reject
		}]);
		if (this._waitTimer) {
			clearTimeout(this._waitTimer);
			this._waitTimer = null;
		}
		if (this._requestedIds.length >= this._limitPerRequest) this._handleBatch(this._requestedIds.splice(0, this._limitPerRequest));
		else this._waitTimer = setTimeout(() => {
			this._handleBatch(this._requestedIds.splice(0, this._limitPerRequest));
		}, this._delay);
		return await promise;
	}
	async _handleBatch(ids) {
		try {
			const { data } = await this._doRequest(ids);
			const dataById = indexBy(data, this._matchKey);
			for (const id of ids) {
				for (const resolver of this._requestResolversById.get(id) ?? []) if (Object.prototype.hasOwnProperty.call(dataById, id)) resolver.resolve(this._mapper(dataById[id]));
				else resolver.resolve(null);
				this._requestResolversById.delete(id);
			}
		} catch (e) {
			await Promise.all(ids.map(async (id) => {
				try {
					const result = await this._doRequest([id]);
					for (const resolver of this._requestResolversById.get(id) ?? []) resolver.resolve(result.data.length ? this._mapper(result.data[0]) : null);
				} catch (e_) {
					for (const resolver of this._requestResolversById.get(id) ?? []) resolver.reject(e_);
				}
				this._requestResolversById.delete(id);
			}));
		}
	}
	async _doRequest(ids) {
		return await this._client.callApi({
			type: "helix",
			...this._callOptions,
			query: {
				...this._callOptions.query,
				[this._queryParamName]: ids
			}
		});
	}
};
__decorate([Enumerable(false)], HelixRequestBatcher.prototype, "_client", void 0);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/utils/pagination/HelixPaginatedRequest.js
if (!Object.prototype.hasOwnProperty.call(Symbol, "asyncIterator")) Symbol.asyncIterator = Symbol.asyncIterator ?? Symbol.for("Symbol.asyncIterator");
/**
* Represents a request to the new Twitch API (Helix) that utilizes a cursor to paginate through its results.
*
* Aside from the methods described below, you can also utilize the async iterator using `for await .. of`:
*
* ```ts
* const result = client.videos.getVideosByUserPaginated('125328655');
* for await (const video of result) {
*     console.log(video.title);
* }
* ```
*/
let HelixPaginatedRequest = class HelixPaginatedRequest {
	_callOptions;
	_mapper;
	_limitPerPage;
	/** @internal */ _client;
	/** @internal */ _currentCursor;
	/** @internal */ _isFinished = false;
	/** @internal */ _currentData;
	/** @internal */
	constructor(_callOptions, client, _mapper, _limitPerPage = 100) {
		this._callOptions = _callOptions;
		this._mapper = _mapper;
		this._limitPerPage = _limitPerPage;
		this._client = client;
	}
	/**
	* The last fetched page of data associated to the requested resource.
	*
	* Only works with {@link HelixPaginatedRequest#getNext} and not with any other methods of data fetching.
	*/
	get current() {
		return this._currentData?.data;
	}
	/**
	* Gets the next available page of data associated to the requested resource, or an empty array if there are no more available pages.
	*/
	async getNext() {
		if (this._isFinished) return [];
		const result = await this._fetchData();
		if (!result.data?.length) {
			this._isFinished = true;
			return [];
		}
		return this._processResult(result);
	}
	/**
	* Gets all data associated to the requested resource.
	*
	* Be aware that this makes multiple calls to the Twitch API. Due to this, you might be more suspectible to rate limits.
	*
	* Also be aware that this resets the internal cursor, so avoid using this and {@link HelixPaginatedRequest#getNext}} together.
	*/
	async getAll() {
		this.reset();
		const result = [];
		do {
			const data = await this.getNext();
			if (!data.length) break;
			result.push(...data);
		} while (this._currentCursor);
		this.reset();
		return result;
	}
	/**
	* Gets the current cursor.
	*
	* Only useful if you want to make manual requests to the API.
	*/
	get currentCursor() {
		return this._currentCursor;
	}
	/**
	* Resets the internal cursor.
	*
	* This will make {@link HelixPaginatedRequest#getNext}} start from the first page again.
	*/
	reset() {
		this._currentCursor = void 0;
		this._isFinished = false;
		this._currentData = void 0;
	}
	async *[Symbol.asyncIterator]() {
		this.reset();
		while (true) {
			const data = await this.getNext();
			if (!data.length) break;
			yield* data[Symbol.iterator]();
		}
	}
	/** @internal */
	async _fetchData(additionalOptions = {}) {
		return await this._client.callApi({
			type: "helix",
			...this._callOptions,
			...additionalOptions,
			query: {
				...this._callOptions.query,
				after: this._currentCursor,
				first: this._limitPerPage.toString(),
				...additionalOptions.query
			}
		});
	}
	/** @internal */
	_processResult(result) {
		this._currentCursor = typeof result.pagination === "string" ? result.pagination : result.pagination?.cursor;
		if (this._currentCursor === void 0) this._isFinished = true;
		this._currentData = result;
		return result.data.reduce((acc, elem) => {
			const mapped = this._mapper(elem);
			return Array.isArray(mapped) ? [...acc, ...mapped] : [...acc, mapped];
		}, []);
	}
};
__decorate([Enumerable(false)], HelixPaginatedRequest.prototype, "_client", void 0);
HelixPaginatedRequest = __decorate([rtfm("api", "HelixPaginatedRequest")], HelixPaginatedRequest);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/utils/pagination/HelixPaginatedRequestWithTotal.js
/**
* A special case of {@link HelixPaginatedRequest} with support for fetching the total number of entities, whenever an endpoint supports it.
*
* @inheritDoc
*/
let HelixPaginatedRequestWithTotal = class HelixPaginatedRequestWithTotal extends HelixPaginatedRequest {
	/**
	* Gets the total number of entities existing in the queried result set.
	*/
	async getTotalCount() {
		return (this._currentData ?? await this._fetchData({ query: { after: void 0 } })).total;
	}
};
HelixPaginatedRequestWithTotal = __decorate([rtfm("api", "HelixPaginatedRequestWithTotal")], HelixPaginatedRequestWithTotal);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/utils/pagination/HelixPaginatedResult.js
/** @internal */ function createPaginatedResult(response, type, client) {
	let dataCache = void 0;
	return {
		get data() {
			return dataCache ??= response.data?.map((data) => new type(data, client)) ?? [];
		},
		cursor: typeof response.pagination === "string" ? response.pagination : response.pagination?.cursor
	};
}
/** @internal */ function createPaginatedResultWithTotal(response, type, client) {
	let dataCache = void 0;
	return {
		get data() {
			return dataCache ??= response.data?.map((data) => new type(data, client)) ?? [];
		},
		cursor: response.pagination.cursor,
		total: response.total
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/utils/pagination/HelixPagination.js
/** @internal */
function createPaginationQuery({ after, before, limit } = {}) {
	return {
		after,
		before,
		first: limit?.toString()
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channel/HelixChannel.js
/**
* A Twitch channel.
*/
let HelixChannel = class HelixChannel extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the channel.
	*/
	get id() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the channel.
	*/
	get name() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the channel.
	*/
	get displayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the broadcaster of the channel.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The language of the channel.
	*/
	get language() {
		return this[rawDataSymbol].broadcaster_language;
	}
	/**
	* The ID of the game currently played on the channel.
	*/
	get gameId() {
		return this[rawDataSymbol].game_id;
	}
	/**
	* The name of the game currently played on the channel.
	*/
	get gameName() {
		return this[rawDataSymbol].game_name;
	}
	/**
	* Gets information about the game that is being played on the stream.
	*/
	async getGame() {
		return this[rawDataSymbol].game_id ? checkRelationAssertion(await this._client.games.getGameById(this[rawDataSymbol].game_id)) : null;
	}
	/**
	* The title of the channel.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* The stream delay of the channel, in seconds.
	*
	* If you didn't request this with broadcaster access, this is always zero.
	*/
	get delay() {
		return this[rawDataSymbol].delay;
	}
	/**
	* The tags applied to the channel.
	*/
	get tags() {
		return this[rawDataSymbol].tags;
	}
	/**
	* The content classification labels applied to the channel.
	*/
	get contentClassificationLabels() {
		return this[rawDataSymbol].content_classification_labels;
	}
	/**
	* Whether the channel currently displays branded content (as specified by the broadcaster).
	*/
	get isBrandedContent() {
		return this[rawDataSymbol].is_branded_content;
	}
};
__decorate([Enumerable(false)], HelixChannel.prototype, "_client", void 0);
HelixChannel = __decorate([rtfm("api", "HelixChannel", "id")], HelixChannel);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channel/HelixChannelEditor.js
/**
* An editor of a previously given channel.
*/
let HelixChannelEditor = class HelixChannelEditor extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the user.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The display name of the user.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets additional information about the user.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* The date when the user was given editor status.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
};
__decorate([Enumerable(false)], HelixChannelEditor.prototype, "_client", void 0);
HelixChannelEditor = __decorate([rtfm("api", "HelixChannelEditor", "userId")], HelixChannelEditor);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channel/HelixChannelFollower.js
/**
* Represents a user that follows a channel.
*/
let HelixChannelFollower = class HelixChannelFollower extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the user.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the user.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets additional information about the user.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* The date when the user followed the broadcaster.
	*/
	get followDate() {
		return new Date(this[rawDataSymbol].followed_at);
	}
};
__decorate([Enumerable(false)], HelixChannelFollower.prototype, "_client", void 0);
HelixChannelFollower = __decorate([rtfm("api", "HelixChannelFollower", "userId")], HelixChannelFollower);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channel/HelixFollowedChannel.js
/**
* Represents a broadcaster that a user follows.
*/
let HelixFollowedChannel = class HelixFollowedChannel extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the broadcaster.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the broadcaster.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets additional information about the broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The date when the user followed the broadcaster.
	*/
	get followDate() {
		return new Date(this[rawDataSymbol].followed_at);
	}
};
__decorate([Enumerable(false)], HelixFollowedChannel.prototype, "_client", void 0);
HelixFollowedChannel = __decorate([rtfm("api", "HelixFollowedChannel", "broadcasterId")], HelixFollowedChannel);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channel/HelixAdSchedule.js
/**
* Represents a broadcaster's ad schedule.
*/
let HelixAdSchedule = class HelixAdSchedule extends DataObject {
	/**
	* The number of snoozes available for the broadcaster.
	*/
	get snoozeCount() {
		return this[rawDataSymbol].snooze_count;
	}
	/**
	* The date and time when the broadcaster will gain an additional snooze.
	* Returns `null` if all snoozes are already available.
	*/
	get snoozeRefreshDate() {
		return this[rawDataSymbol].snooze_refresh_at ? /* @__PURE__ */ new Date(this[rawDataSymbol].snooze_refresh_at * 1e3) : null;
	}
	/**
	* The date and time of the broadcaster's next scheduled ad.
	* Returns `null` if channel is not live or has no ad scheduled.
	*/
	get nextAdDate() {
		return this[rawDataSymbol].next_ad_at ? /* @__PURE__ */ new Date(this[rawDataSymbol].next_ad_at * 1e3) : null;
	}
	/**
	* The length in seconds of the scheduled upcoming ad break.
	*/
	get duration() {
		return this[rawDataSymbol].duration;
	}
	/**
	* The date and time of the broadcaster's last ad-break.
	* Returns `null` if channel is not live or has not run an ad.
	*/
	get lastAdDate() {
		return this[rawDataSymbol].last_ad_at ? /* @__PURE__ */ new Date(this[rawDataSymbol].last_ad_at * 1e3) : null;
	}
	/**
	* The amount of pre-roll free time remaining for the channel in seconds.
	*/
	get prerollFreeTime() {
		return this[rawDataSymbol].preroll_free_time;
	}
};
HelixAdSchedule = __decorate([rtfm("api", "HelixAdSchedule")], HelixAdSchedule);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channel/HelixSnoozeNextAdResult.js
/**
* Represents the result after a call to snooze the broadcaster's ad schedule.
*/
let HelixSnoozeNextAdResult = class HelixSnoozeNextAdResult extends DataObject {
	/**
	* The number of snoozes remaining for the broadcaster.
	*/
	get snoozeCount() {
		return this[rawDataSymbol].snooze_count;
	}
	/**
	* The date and time when the broadcaster will gain an additional snooze.
	*/
	get snoozeRefreshDate() {
		return /* @__PURE__ */ new Date(this[rawDataSymbol].snooze_refresh_at * 1e3);
	}
	/**
	* The date and time of the broadcaster's next scheduled ad.
	*/
	get nextAdDate() {
		return /* @__PURE__ */ new Date(this[rawDataSymbol].next_ad_at * 1e3);
	}
};
HelixSnoozeNextAdResult = __decorate([rtfm("api", "HelixSnoozeNextAdResult")], HelixSnoozeNextAdResult);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channel/HelixChannelApi.js
/**
* The Helix API methods that deal with channels.
*
* Can be accessed using `client.channels` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const channel = await api.channels.getChannelInfoById('125328655');
* ```
*
* @meta category helix
* @meta categorizedTitle Channels
*/
let HelixChannelApi = class HelixChannelApi extends BaseApi {
	/** @internal */
	_getChannelByIdBatcher = new HelixRequestBatcher({ url: "channels" }, "broadcaster_id", "broadcaster_id", this._client, (data) => new HelixChannel(data, this._client));
	/**
	* Gets the channel data for the given user.
	*
	* @param user The user you want to get channel info for.
	*/
	async getChannelInfoById(user) {
		const userId = extractUserId(user);
		return mapNullable((await this._client.callApi({
			type: "helix",
			url: "channels",
			userId,
			query: createBroadcasterQuery(userId)
		})).data[0], (data) => new HelixChannel(data, this._client));
	}
	/**
	* Gets the channel data for the given user, batching multiple calls into fewer requests as the API allows.
	*
	* @param user The user you want to get channel info for.
	*/
	async getChannelInfoByIdBatched(user) {
		return await this._getChannelByIdBatcher.request(extractUserId(user));
	}
	/**
	* Gets the channel data for the given users.
	*
	* @param users The users you want to get channel info for.
	*/
	async getChannelInfoByIds(users) {
		const userIds = users.map(extractUserId);
		return (await this._client.callApi({
			type: "helix",
			url: "channels",
			query: createSingleKeyQuery("broadcaster_id", userIds)
		})).data.map((data) => new HelixChannel(data, this._client));
	}
	/**
	* Updates the given user's channel data.
	*
	* @param user The user you want to update channel info for.
	* @param data The channel info to set.
	*/
	async updateChannelInfo(user, data) {
		await this._client.callApi({
			type: "helix",
			url: "channels",
			method: "PATCH",
			userId: extractUserId(user),
			scopes: ["channel:manage:broadcast"],
			query: createBroadcasterQuery(user),
			jsonBody: createChannelUpdateBody(data)
		});
	}
	/**
	* Starts a commercial on a channel.
	*
	* @param broadcaster The broadcaster on whose channel the commercial is started.
	* @param length The length of the commercial, in seconds.
	*/
	async startChannelCommercial(broadcaster, length) {
		await this._client.callApi({
			type: "helix",
			url: "channels/commercial",
			method: "POST",
			userId: extractUserId(broadcaster),
			scopes: ["channel:edit:commercial"],
			jsonBody: createChannelCommercialBody(broadcaster, length)
		});
	}
	/**
	* Gets a list of users who have editor permissions on your channel.
	*
	* @param broadcaster The broadcaster to retreive the editors for.
	*/
	async getChannelEditors(broadcaster) {
		return (await this._client.callApi({
			type: "helix",
			url: "channels/editors",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:editors"],
			query: createBroadcasterQuery(broadcaster)
		})).data.map((data) => new HelixChannelEditor(data, this._client));
	}
	/**
	* Gets a list of VIPs in a channel.
	*
	* @param broadcaster The owner of the channel to get VIPs for.
	* @param pagination
	*
	* @expandParams
	*/
	async getVips(broadcaster, pagination) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "channels/vips",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:vips", "channel:manage:vips"],
			query: {
				...createBroadcasterQuery(broadcaster),
				...createPaginationQuery(pagination)
			}
		}), HelixUserRelation, this._client);
	}
	/**
	* Creates a paginator for VIPs in a channel.
	*
	* @param broadcaster The owner of the channel to get VIPs for.
	*/
	getVipsPaginated(broadcaster) {
		return new HelixPaginatedRequest({
			url: "channels/vips",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:vips", "channel:manage:vips"],
			query: createBroadcasterQuery(broadcaster)
		}, this._client, (data) => new HelixUserRelation(data, this._client));
	}
	/**
	* Checks the VIP status of a list of users in a channel.
	*
	* @param broadcaster The owner of the channel to check VIP status in.
	* @param users The users to check.
	*/
	async checkVipForUsers(broadcaster, users) {
		return (await this._client.callApi({
			type: "helix",
			url: "channels/vips",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:vips", "channel:manage:vips"],
			query: createChannelUsersCheckQuery(broadcaster, users)
		})).data.map((data) => new HelixUserRelation(data, this._client));
	}
	/**
	* Checks the VIP status of a user in a channel.
	*
	* @param broadcaster The owner of the channel to check VIP status in.
	* @param user The user to check.
	*/
	async checkVipForUser(broadcaster, user) {
		const userId = extractUserId(user);
		return (await this.checkVipForUsers(broadcaster, [userId])).some((rel) => rel.id === userId);
	}
	/**
	* Adds a VIP to the broadcaster’s chat room.
	*
	* @param broadcaster The broadcaster that’s granting VIP status to the user. This ID must match the user ID in the access token.
	* @param user The user to add as a VIP in the broadcaster’s chat room.
	*/
	async addVip(broadcaster, user) {
		await this._client.callApi({
			type: "helix",
			url: "channels/vips",
			method: "POST",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:vips"],
			query: createChannelVipUpdateQuery(broadcaster, user)
		});
	}
	/**
	* Removes a VIP from the broadcaster’s chat room.
	*
	* @param broadcaster The broadcaster that’s removing VIP status from the user. This ID must match the user ID in the access token.
	* @param user The user to remove as a VIP from the broadcaster’s chat room.
	*/
	async removeVip(broadcaster, user) {
		await this._client.callApi({
			type: "helix",
			url: "channels/vips",
			method: "DELETE",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:vips"],
			query: createChannelVipUpdateQuery(broadcaster, user)
		});
	}
	/**
	* Gets the total number of users that follow the specified broadcaster.
	*
	* @param broadcaster The broadcaster you want to get the number of followers of.
	*/
	async getChannelFollowerCount(broadcaster) {
		return (await this._client.callApi({
			type: "helix",
			url: "channels/followers",
			method: "GET",
			userId: extractUserId(broadcaster),
			query: {
				...createChannelFollowerQuery(broadcaster),
				...createPaginationQuery({ limit: 1 })
			}
		})).total;
	}
	/**
	* Gets a list of users that follow the specified broadcaster.
	* You can also use this endpoint to see whether a specific user follows the broadcaster.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster you want to get a list of followers for.
	* @param user An optional user to determine if this user follows the broadcaster.
	* If specified, the response contains this user if they follow the broadcaster.
	* If not specified, the response contains all users that follow the broadcaster.
	* @param pagination
	*
	* @expandParams
	*/
	async getChannelFollowers(broadcaster, user, pagination) {
		return createPaginatedResultWithTotal(await this._client.callApi({
			type: "helix",
			url: "channels/followers",
			method: "GET",
			userId: extractUserId(broadcaster),
			canOverrideScopedUserContext: true,
			scopes: ["moderator:read:followers"],
			query: {
				...createChannelFollowerQuery(broadcaster, user),
				...createPaginationQuery(pagination)
			}
		}), HelixChannelFollower, this._client);
	}
	/**
	* Creates a paginator for users that follow the specified broadcaster.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster for whom you are getting a list of followers.
	*
	* @expandParams
	*/
	getChannelFollowersPaginated(broadcaster) {
		return new HelixPaginatedRequestWithTotal({
			url: "channels/followers",
			method: "GET",
			userId: extractUserId(broadcaster),
			canOverrideScopedUserContext: true,
			scopes: ["moderator:read:followers"],
			query: createChannelFollowerQuery(broadcaster)
		}, this._client, (data) => new HelixChannelFollower(data, this._client));
	}
	/**
	* Gets a list of broadcasters that the specified user follows.
	* You can also use this endpoint to see whether the user follows a specific broadcaster.
	*
	* @param user The user that's getting a list of followed channels.
	* This ID must match the user ID in the access token.
	* @param broadcaster An optional broadcaster to determine if the user follows this broadcaster.
	* If specified, the response contains this broadcaster if the user follows them.
	* If not specified, the response contains all broadcasters that the user follows.
	* @param pagination
	* @returns
	*/
	async getFollowedChannels(user, broadcaster, pagination) {
		return createPaginatedResultWithTotal(await this._client.callApi({
			type: "helix",
			url: "channels/followed",
			method: "GET",
			userId: extractUserId(user),
			scopes: ["user:read:follows"],
			query: {
				...createFollowedChannelQuery(user, broadcaster),
				...createPaginationQuery(pagination)
			}
		}), HelixFollowedChannel, this._client);
	}
	/**
	* Creates a paginator for broadcasters that the specified user follows.
	*
	* @param user The user that's getting a list of followed channels.
	* The token of this user will be used to get the list of followed channels.
	* @param broadcaster An optional broadcaster to determine if the user follows this broadcaster.
	* If specified, the response contains this broadcaster if the user follows them.
	* If not specified, the response contains all broadcasters that the user follows.
	* @returns
	*/
	getFollowedChannelsPaginated(user, broadcaster) {
		return new HelixPaginatedRequestWithTotal({
			url: "channels/followed",
			method: "GET",
			userId: extractUserId(user),
			scopes: ["user:read:follows"],
			query: createFollowedChannelQuery(user, broadcaster)
		}, this._client, (data) => new HelixFollowedChannel(data, this._client));
	}
	/**
	* Gets information about the broadcaster's ad schedule.
	*
	* @param broadcaster The broadcaster to get ad schedule information about.
	*/
	async getAdSchedule(broadcaster) {
		return new HelixAdSchedule((await this._client.callApi({
			type: "helix",
			url: "channels/ads",
			method: "GET",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:ads"],
			query: createBroadcasterQuery(broadcaster)
		})).data[0]);
	}
	/**
	* Snoozes the broadcaster's next ad, if a snooze is available.
	*
	* @param broadcaster The broadcaster to get ad schedule information about.
	*/
	async snoozeNextAd(broadcaster) {
		return new HelixSnoozeNextAdResult((await this._client.callApi({
			type: "helix",
			url: "channels/ads/schedule/snooze",
			method: "POST",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:ads"],
			query: createBroadcasterQuery(broadcaster)
		})).data[0]);
	}
};
__decorate([Enumerable(false)], HelixChannelApi.prototype, "_getChannelByIdBatcher", void 0);
HelixChannelApi = __decorate([rtfm("api", "HelixChannelApi")], HelixChannelApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/channelPoints.external.js
/** @internal */
function createCustomRewardsQuery(broadcaster, onlyManageable) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		only_manageable_rewards: onlyManageable?.toString()
	};
}
/** @internal */
function createCustomRewardChangeQuery(broadcaster, rewardId) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		id: rewardId
	};
}
/** @internal */
function createCustomRewardBody(data) {
	const result = {
		title: data.title,
		cost: data.cost,
		prompt: data.prompt,
		background_color: data.backgroundColor,
		is_enabled: data.isEnabled,
		is_user_input_required: data.userInputRequired,
		should_redemptions_skip_request_queue: data.autoFulfill
	};
	if (data.maxRedemptionsPerStream !== void 0) {
		result.is_max_per_stream_enabled = !!data.maxRedemptionsPerStream;
		result.max_per_stream = data.maxRedemptionsPerStream ?? 0;
	}
	if (data.maxRedemptionsPerUserPerStream !== void 0) {
		result.is_max_per_user_per_stream_enabled = !!data.maxRedemptionsPerUserPerStream;
		result.max_per_user_per_stream = data.maxRedemptionsPerUserPerStream ?? 0;
	}
	if (data.globalCooldown !== void 0) {
		result.is_global_cooldown_enabled = !!data.globalCooldown;
		result.global_cooldown_seconds = data.globalCooldown ?? 0;
	}
	if ("isPaused" in data) result.is_paused = data.isPaused;
	return result;
}
/** @internal */
function createRewardRedemptionsByIdsQuery(broadcaster, rewardId, redemptionIds) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		reward_id: rewardId,
		id: redemptionIds
	};
}
/** @internal */
function createRedemptionsForBroadcasterQuery(broadcaster, rewardId, status, filter) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		reward_id: rewardId,
		status,
		sort: filter.newestFirst ? "NEWEST" : "OLDEST"
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channelPoints/HelixCustomReward.js
/**
* A custom Channel Points reward.
*/
let HelixCustomReward = class HelixCustomReward extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the reward.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The ID of the broadcaster the reward belongs to.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster the reward belongs to.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the broadcaster the reward belongs to.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the reward's broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* Gets the URL of the image of the reward in the given scale.
	*
	* @param scale The scale of the image.
	*/
	getImageUrl(scale) {
		const urlProp = `url_${scale}x`;
		return this[rawDataSymbol].image?.[urlProp] ?? this[rawDataSymbol].default_image[urlProp];
	}
	/**
	* The background color of the reward.
	*/
	get backgroundColor() {
		return this[rawDataSymbol].background_color;
	}
	/**
	* Whether the reward is enabled (shown to users).
	*/
	get isEnabled() {
		return this[rawDataSymbol].is_enabled;
	}
	/**
	* The channel points cost of the reward.
	*/
	get cost() {
		return this[rawDataSymbol].cost;
	}
	/**
	* The title of the reward.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* The prompt shown to users when redeeming the reward.
	*/
	get prompt() {
		return this[rawDataSymbol].prompt;
	}
	/**
	* Whether the reward requires user input to be redeemed.
	*/
	get userInputRequired() {
		return this[rawDataSymbol].is_user_input_required;
	}
	/**
	* The maximum number of redemptions of the reward per stream. `null` means no limit.
	*/
	get maxRedemptionsPerStream() {
		return this[rawDataSymbol].max_per_stream_setting.is_enabled ? this[rawDataSymbol].max_per_stream_setting.max_per_stream : null;
	}
	/**
	* The maximum number of redemptions of the reward per stream for each user. `null` means no limit.
	*/
	get maxRedemptionsPerUserPerStream() {
		return this[rawDataSymbol].max_per_user_per_stream_setting.is_enabled ? this[rawDataSymbol].max_per_user_per_stream_setting.max_per_user_per_stream : null;
	}
	/**
	* The cooldown between two redemptions of the reward, in seconds. `null` means no cooldown.
	*/
	get globalCooldown() {
		return this[rawDataSymbol].global_cooldown_setting.is_enabled ? this[rawDataSymbol].global_cooldown_setting.global_cooldown_seconds : null;
	}
	/**
	* Whether the reward is paused. If true, users can't redeem it.
	*/
	get isPaused() {
		return this[rawDataSymbol].is_paused;
	}
	/**
	* Whether the reward is currently in stock.
	*/
	get isInStock() {
		return this[rawDataSymbol].is_in_stock;
	}
	/**
	* How often the reward was already redeemed this stream.
	*
	* Only available when the stream is live and `maxRedemptionsPerStream` is set. Otherwise, this is `null`.
	*/
	get redemptionsThisStream() {
		return this[rawDataSymbol].redemptions_redeemed_current_stream;
	}
	/**
	* Whether redemptions should automatically be marked as fulfilled.
	*/
	get autoFulfill() {
		return this[rawDataSymbol].should_redemptions_skip_request_queue;
	}
	/**
	* The time when the cooldown ends. `null` means there is currently no cooldown.
	*/
	get cooldownExpiryDate() {
		return this[rawDataSymbol].cooldown_expires_at ? new Date(this[rawDataSymbol].cooldown_expires_at) : null;
	}
};
__decorate([Enumerable(false)], HelixCustomReward.prototype, "_client", void 0);
HelixCustomReward = __decorate([rtfm("api", "HelixCustomReward", "id")], HelixCustomReward);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channelPoints/HelixCustomRewardRedemption.js
/**
* A redemption of a custom Channel Points reward.
*/
let HelixCustomRewardRedemption = class HelixCustomRewardRedemption extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the redemption.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The ID of the broadcaster where the reward was redeemed.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster where the reward was redeemed.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the broadcaster where the reward was redeemed.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the broadcaster where the reward was redeemed.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The ID of the user that redeemed the reward.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the user that redeemed the reward.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user that redeemed the reward.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets more information about the user that redeemed the reward.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* The text the user wrote when redeeming the reward.
	*/
	get userInput() {
		return this[rawDataSymbol].user_input;
	}
	/**
	* Whether the redemption was fulfilled.
	*/
	get isFulfilled() {
		return this[rawDataSymbol].status === "FULFILLED";
	}
	/**
	* Whether the redemption was canceled.
	*/
	get isCanceled() {
		return this[rawDataSymbol].status === "CANCELED";
	}
	/**
	* The date and time when the reward was redeemed.
	*/
	get redemptionDate() {
		return new Date(this[rawDataSymbol].redeemed_at);
	}
	/**
	* The ID of the reward that was redeemed.
	*/
	get rewardId() {
		return this[rawDataSymbol].reward.id;
	}
	/**
	* The title of the reward that was redeemed.
	*/
	get rewardTitle() {
		return this[rawDataSymbol].reward.title;
	}
	/**
	* The prompt of the reward that was redeemed.
	*/
	get rewardPrompt() {
		return this[rawDataSymbol].reward.prompt;
	}
	/**
	* The cost of the reward that was redeemed.
	*/
	get rewardCost() {
		return this[rawDataSymbol].reward.cost;
	}
	/**
	* Gets more information about the reward that was redeemed.
	*/
	async getReward() {
		return checkRelationAssertion(await this._client.channelPoints.getCustomRewardById(this[rawDataSymbol].broadcaster_id, this[rawDataSymbol].reward.id));
	}
	/**
	* Updates the redemption's status.
	*
	* @param newStatus The status the redemption should have.
	*/
	async updateStatus(newStatus) {
		return (await this._client.channelPoints.updateRedemptionStatusByIds(this[rawDataSymbol].broadcaster_id, this[rawDataSymbol].reward.id, [this[rawDataSymbol].id], newStatus))[0];
	}
};
__decorate([Enumerable(false)], HelixCustomRewardRedemption.prototype, "_client", void 0);
HelixCustomRewardRedemption = __decorate([rtfm("api", "HelixCustomRewardRedemption", "id")], HelixCustomRewardRedemption);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channelPoints/HelixChannelPointsApi.js
/**
* The Helix API methods that deal with channel points.
*
* Can be accessed using `client.channelPoints` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const rewards = await api.channelPoints.getCustomRewards('125328655');
* ```
*
* @meta category helix
* @meta categorizedTitle Channel points
*/
let HelixChannelPointsApi = class HelixChannelPointsApi extends BaseApi {
	/**
	* Gets all custom rewards for the given broadcaster.
	*
	* @param broadcaster The broadcaster to get the rewards for.
	* @param onlyManageable Whether to only get rewards that can be managed by the API.
	*/
	async getCustomRewards(broadcaster, onlyManageable) {
		return (await this._client.callApi({
			type: "helix",
			url: "channel_points/custom_rewards",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:redemptions", "channel:manage:redemptions"],
			query: createCustomRewardsQuery(broadcaster, onlyManageable)
		})).data.map((data) => new HelixCustomReward(data, this._client));
	}
	/**
	* Gets custom rewards by IDs.
	*
	* @param broadcaster The broadcaster to get the rewards for.
	* @param rewardIds The IDs of the rewards.
	*/
	async getCustomRewardsByIds(broadcaster, rewardIds) {
		if (!rewardIds.length) return [];
		return (await this._client.callApi({
			type: "helix",
			url: "channel_points/custom_rewards",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:redemptions", "channel:manage:redemptions"],
			query: createGetByIdsQuery(broadcaster, rewardIds)
		})).data.map((data) => new HelixCustomReward(data, this._client));
	}
	/**
	* Gets a custom reward by ID.
	*
	* @param broadcaster The broadcaster to get the reward for.
	* @param rewardId The ID of the reward.
	*/
	async getCustomRewardById(broadcaster, rewardId) {
		const rewards = await this.getCustomRewardsByIds(broadcaster, [rewardId]);
		return rewards.length ? rewards[0] : null;
	}
	/**
	* Creates a new custom reward.
	*
	* @param broadcaster The broadcaster to create the reward for.
	* @param data The reward data.
	*
	* @expandParams
	*/
	async createCustomReward(broadcaster, data) {
		return new HelixCustomReward((await this._client.callApi({
			type: "helix",
			url: "channel_points/custom_rewards",
			method: "POST",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:redemptions"],
			query: createBroadcasterQuery(broadcaster),
			jsonBody: createCustomRewardBody(data)
		})).data[0], this._client);
	}
	/**
	* Updates a custom reward.
	*
	* @param broadcaster The broadcaster to update the reward for.
	* @param rewardId The ID of the reward.
	* @param data The reward data.
	*/
	async updateCustomReward(broadcaster, rewardId, data) {
		return new HelixCustomReward((await this._client.callApi({
			type: "helix",
			url: "channel_points/custom_rewards",
			method: "PATCH",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:redemptions"],
			query: createCustomRewardChangeQuery(broadcaster, rewardId),
			jsonBody: createCustomRewardBody(data)
		})).data[0], this._client);
	}
	/**
	* Deletes a custom reward.
	*
	* @param broadcaster The broadcaster to delete the reward for.
	* @param rewardId The ID of the reward.
	*/
	async deleteCustomReward(broadcaster, rewardId) {
		await this._client.callApi({
			type: "helix",
			url: "channel_points/custom_rewards",
			method: "DELETE",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:redemptions"],
			query: createCustomRewardChangeQuery(broadcaster, rewardId)
		});
	}
	/**
	* Gets custom reward redemptions by IDs.
	*
	* @param broadcaster The broadcaster to get the redemptions for.
	* @param rewardId The ID of the reward.
	* @param redemptionIds The IDs of the redemptions.
	*/
	async getRedemptionsByIds(broadcaster, rewardId, redemptionIds) {
		if (!redemptionIds.length) return [];
		return (await this._client.callApi({
			type: "helix",
			url: "channel_points/custom_rewards/redemptions",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:redemptions", "channel:manage:redemptions"],
			query: createRewardRedemptionsByIdsQuery(broadcaster, rewardId, redemptionIds)
		})).data.map((data) => new HelixCustomRewardRedemption(data, this._client));
	}
	/**
	* Gets a custom reward redemption by ID.
	*
	* @param broadcaster The broadcaster to get the redemption for.
	* @param rewardId The ID of the reward.
	* @param redemptionId The ID of the redemption.
	*/
	async getRedemptionById(broadcaster, rewardId, redemptionId) {
		const redemptions = await this.getRedemptionsByIds(broadcaster, rewardId, [redemptionId]);
		return redemptions.length ? redemptions[0] : null;
	}
	/**
	* Gets custom reward redemptions for the given broadcaster.
	*
	* @param broadcaster The broadcaster to get the redemptions for.
	* @param rewardId The ID of the reward.
	* @param status The status of the redemptions to get.
	* @param filter
	*
	* @expandParams
	*/
	async getRedemptionsForBroadcaster(broadcaster, rewardId, status, filter) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "channel_points/custom_rewards/redemptions",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:redemptions", "channel:manage:redemptions"],
			query: {
				...createRedemptionsForBroadcasterQuery(broadcaster, rewardId, status, filter),
				...createPaginationQuery(filter)
			}
		}), HelixCustomRewardRedemption, this._client);
	}
	/**
	* Creates a paginator for custom reward redemptions for the given broadcaster.
	*
	* @param broadcaster The broadcaster to get the redemptions for.
	* @param rewardId The ID of the reward.
	* @param status The status of the redemptions to get.
	* @param filter
	*
	* @expandParams
	*/
	getRedemptionsForBroadcasterPaginated(broadcaster, rewardId, status, filter) {
		return new HelixPaginatedRequest({
			url: "channel_points/custom_rewards/redemptions",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:redemptions", "channel:manage:redemptions"],
			query: createRedemptionsForBroadcasterQuery(broadcaster, rewardId, status, filter)
		}, this._client, (data) => new HelixCustomRewardRedemption(data, this._client), 50);
	}
	/**
	* Updates the status of the given redemptions by IDs.
	*
	* @param broadcaster The broadcaster to update the redemptions for.
	* @param rewardId The ID of the reward.
	* @param redemptionIds The IDs of the redemptions to update.
	* @param status The status to set for the redemptions.
	*/
	async updateRedemptionStatusByIds(broadcaster, rewardId, redemptionIds, status) {
		if (!redemptionIds.length) return [];
		return (await this._client.callApi({
			type: "helix",
			url: "channel_points/custom_rewards/redemptions",
			method: "PATCH",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:redemptions"],
			query: createRewardRedemptionsByIdsQuery(broadcaster, rewardId, redemptionIds),
			jsonBody: { status }
		})).data.map((data) => new HelixCustomRewardRedemption(data, this._client));
	}
};
HelixChannelPointsApi = __decorate([rtfm("api", "HelixChannelPointsApi")], HelixChannelPointsApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/charity/HelixCharityCampaignAmount.js
/**
* An object representing monetary amount and currency information for charity donations/goals.
*/
let HelixCharityCampaignAmount = class HelixCharityCampaignAmount extends DataObject {
	/**
	* The monetary amount. The amount is specified in the currency’s minor unit.
	* For example, the minor units for USD is cents, so if the amount is $5.50 USD, `value` is set to 550.
	*/
	get value() {
		return this[rawDataSymbol].value;
	}
	/**
	* The number of decimal places used by the currency. For example, USD uses two decimal places.
	* Use this number to translate `value` from minor units to major units by using the formula:
	*
	* `value / 10^decimalPlaces`
	*/
	get decimalPlaces() {
		return this[rawDataSymbol].decimal_places;
	}
	/**
	* The localized monetary amount based on the value and the decimal places of the currency.
	* For example, the minor units for USD is cents which uses two decimal places, so if `value` is 550, `localizedValue` is set to 5.50.
	*/
	get localizedValue() {
		return this.value / 10 ** this.decimalPlaces;
	}
	/**
	* The ISO-4217 three-letter currency code that identifies the type of currency in `value`.
	*/
	get currency() {
		return this[rawDataSymbol].currency;
	}
};
HelixCharityCampaignAmount = __decorate([rtfm("api", "HelixCharityCampaignAmount")], HelixCharityCampaignAmount);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/charity/HelixCharityCampaign.js
/**
* A charity campaign in a Twitch channel.
*/
let HelixCharityCampaign = class HelixCharityCampaign extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* An ID that identifies the charity campaign.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The ID of the broadcaster.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the broadcaster.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The name of the charity.
	*/
	get charityName() {
		return this[rawDataSymbol].charity_name;
	}
	/**
	* A description of the charity.
	*/
	get charityDescription() {
		return this[rawDataSymbol].charity_description;
	}
	/**
	* A URL to an image of the charity's logo. The image’s type is PNG and its size is 100px X 100px.
	*/
	get charityLogo() {
		return this[rawDataSymbol].charity_logo;
	}
	/**
	* A URL to the charity’s website.
	*/
	get charityWebsite() {
		return this[rawDataSymbol].charity_website;
	}
	/**
	* An object that contains the current amount of donations that the campaign has received.
	*/
	get currentAmount() {
		return new HelixCharityCampaignAmount(this[rawDataSymbol].current_amount);
	}
	/**
	* An object that contains the campaign’s target fundraising goal.
	*/
	get targetAmount() {
		return new HelixCharityCampaignAmount(this[rawDataSymbol].target_amount);
	}
};
__decorate([Enumerable(false)], HelixCharityCampaign.prototype, "_client", void 0);
HelixCharityCampaign = __decorate([rtfm("api", "HelixCharityCampaign", "id")], HelixCharityCampaign);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/charity/HelixCharityCampaignDonation.js
/**
* A donation to a charity campaign in a Twitch channel.
*/
let HelixCharityCampaignDonation = class HelixCharityCampaignDonation extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* An ID that identifies the charity campaign.
	*/
	get campaignId() {
		return this[rawDataSymbol].campaign_id;
	}
	/**
	* The ID of the donating user.
	*/
	get donorId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the donating user.
	*/
	get donorName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the donating user.
	*/
	get donorDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets more information about the donating user.
	*/
	async getDonor() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* An object that contains the amount of money that the user donated.
	*/
	get amount() {
		return new HelixCharityCampaignAmount(this[rawDataSymbol].amount);
	}
};
__decorate([Enumerable(false)], HelixCharityCampaignDonation.prototype, "_client", void 0);
HelixCharityCampaignDonation = __decorate([rtfm("api", "HelixCharityCampaignDonation")], HelixCharityCampaignDonation);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/charity/HelixCharityApi.js
/**
* The Helix API methods that deal with charity campaigns.
*
* Can be accessed using `client.charity` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const charityCampaign = await api.charity.getCharityCampaign('125328655');
* ```
*
* @meta category helix
* @meta categorizedTitle Charity Campaigns
*/
let HelixCharityApi = class HelixCharityApi extends BaseApi {
	/**
	* Gets information about the charity campaign that a broadcaster is running.
	* Returns null if the specified broadcaster has no active charity campaign.
	*
	* @param broadcaster The broadcaster to get charity campaign information about.
	*/
	async getCharityCampaign(broadcaster) {
		return new HelixCharityCampaign((await this._client.callApi({
			type: "helix",
			url: "charity/campaigns",
			method: "GET",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:charity"],
			query: createBroadcasterQuery(broadcaster)
		})).data[0], this._client);
	}
	/**
	* Gets the list of donations that users have made to the broadcaster’s active charity campaign.
	*
	* @param broadcaster The broadcaster to get charity campaign donation information about.
	* @param pagination
	*
	* @expandParams
	*/
	async getCharityCampaignDonations(broadcaster, pagination) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "charity/donations",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:charity"],
			query: {
				...createBroadcasterQuery(broadcaster),
				...createPaginationQuery(pagination)
			}
		}), HelixCharityCampaignDonation, this._client);
	}
};
HelixCharityApi = __decorate([rtfm("api", "HelixCharityApi")], HelixCharityApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/errors/ChatMessageDroppedError.js
/**
* Thrown when a chat message is dropped and not delivered to the target channel.
*/
var ChatMessageDroppedError = class extends CustomError {
	_code;
	constructor(broadcasterId, message, code) {
		super(`Chat message to channel ${broadcasterId} dropped: ${message ?? "unknown reason"}`);
		this._code = code;
	}
	get code() {
		return this._code;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/chat.external.js
/** @internal */
function createChatSettingsUpdateBody(settings) {
	return {
		slow_mode: settings.slowModeEnabled,
		slow_mode_wait_time: settings.slowModeDelay,
		follower_mode: settings.followerOnlyModeEnabled,
		follower_mode_duration: settings.followerOnlyModeDelay,
		subscriber_mode: settings.subscriberOnlyModeEnabled,
		emote_mode: settings.emoteOnlyModeEnabled,
		unique_chat_mode: settings.uniqueChatModeEnabled,
		non_moderator_chat_delay: settings.nonModeratorChatDelayEnabled,
		non_moderator_chat_delay_duration: settings.nonModeratorChatDelay
	};
}
/** @internal */
function createChatColorUpdateQuery(user, color) {
	return {
		user_id: extractUserId(user),
		color
	};
}
/** @internal */
function createShoutoutQuery(from, to, moderatorId) {
	return {
		from_broadcaster_id: extractUserId(from),
		to_broadcaster_id: extractUserId(to),
		moderator_id: moderatorId
	};
}
/** @internal */
function createSendChatMessageQuery(broadcaster, sender) {
	return {
		broadcaster_id: broadcaster,
		sender_id: sender
	};
}
/** @internal */
function createSendChatMessageBody(message, params) {
	return {
		message,
		reply_parent_message_id: params?.replyParentMessageId
	};
}
/** @internal */
function createSendChatMessageAsAppBody(message, params) {
	return {
		message,
		reply_parent_message_id: params?.replyParentMessageId,
		for_source_only: params?.forSourceOnly
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/shared-chat-session.external.js
/** @internal */
function createSharedChatSessionQuery(broadcaster) {
	return { broadcaster_id: extractUserId(broadcaster) };
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixEmoteBase.js
/** @private */
var HelixEmoteBase = class extends DataObject {
	/**
	* The ID of the emote.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The name of the emote.
	*/
	get name() {
		return this[rawDataSymbol].name;
	}
	/**
	* The formats that the emote is available in.
	*/
	get formats() {
		return this[rawDataSymbol].format;
	}
	/**
	* The scales that the emote is available in.
	*/
	get scales() {
		return this[rawDataSymbol].scale;
	}
	/**
	* The theme modes that the emote is available in.
	*/
	get themeModes() {
		return this[rawDataSymbol].theme_mode;
	}
	/**
	* Gets the URL of the emote image in static format at the given scale and theme mode, or null if a static emote image at that scale/theme mode doesn't exist.
	*
	* @param scale The scale of the image.
	* @param themeMode The theme mode of the image, either `light` or `dark`.
	*/
	getStaticImageUrl(scale = "1.0", themeMode = "light") {
		if (this[rawDataSymbol].format.includes("static") && this[rawDataSymbol].scale.includes(scale)) return this.getFormattedImageUrl(scale, "static", themeMode);
		return null;
	}
	/**
	* Gets the URL of the emote image in animated format at the given scale and theme mode, or null if an animated emote image at that scale/theme mode doesn't exist.
	*
	* @param scale The scale of the image.
	* @param themeMode The theme mode of the image, either `light` or `dark`.
	*/
	getAnimatedImageUrl(scale = "1.0", themeMode = "light") {
		if (this[rawDataSymbol].format.includes("animated") && this[rawDataSymbol].scale.includes(scale)) return this.getFormattedImageUrl(scale, "animated", themeMode);
		return null;
	}
	/**
	* Gets the URL of the emote image in the given scale, format, and theme mode.
	*
	* @param scale The scale of the image, either `1.0` (small), `2.0` (medium), or `3.0` (large).
	* @param format The format of the image, either `static` or `animated`.
	* @param themeMode The theme mode of the image, either `light` or `dark`.
	*/
	getFormattedImageUrl(scale = "1.0", format = "static", themeMode = "light") {
		return `https://static-cdn.jtvnw.net/emoticons/v2/${this[rawDataSymbol].id}/${format}/${themeMode}/${scale}`;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixEmote.js
/**
* A Twitch emote.
*/
let HelixEmote = class HelixEmote extends HelixEmoteBase {
	/**
	* Gets the URL of the emote image in the given scale.
	*
	* @param scale The scale of the image.
	*/
	getImageUrl(scale) {
		return this[rawDataSymbol].images[`url_${scale}x`];
	}
};
HelixEmote = __decorate([rtfm("api", "HelixEmote", "id")], HelixEmote);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixChannelEmote.js
/**
* A Twitch Channel emote.
*
* @inheritDoc
*/
let HelixChannelEmote = class HelixChannelEmote extends HelixEmote {
	/** @internal */ _client;
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The subscription tier necessary to unlock the emote, or null if the emote is not a subscription emote.
	*/
	get tier() {
		return this[rawDataSymbol].tier || null;
	}
	/**
	* The type of the emote.
	*
	* There are many types of emotes that Twitch seems to arbitrarily assign. Do not rely on this value.
	*/
	get type() {
		return this[rawDataSymbol].emote_type;
	}
	/**
	* The ID of the emote set the emote is part of.
	*/
	get emoteSetId() {
		return this[rawDataSymbol].emote_set_id;
	}
	/**
	* Gets all emotes from the emote's set.
	*/
	async getAllEmotesFromSet() {
		return await this._client.chat.getEmotesFromSets([this[rawDataSymbol].emote_set_id]);
	}
};
__decorate([Enumerable(false)], HelixChannelEmote.prototype, "_client", void 0);
HelixChannelEmote = __decorate([rtfm("api", "HelixChannelEmote", "id")], HelixChannelEmote);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixChatBadgeVersion.js
/**
* A version of a chat badge.
*/
let HelixChatBadgeVersion = class HelixChatBadgeVersion extends DataObject {
	/**
	* The badge version ID.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* Gets an image URL for the given scale.
	*
	* @param scale The scale of the badge image.
	*/
	getImageUrl(scale) {
		return this[rawDataSymbol][`image_url_${scale}x`];
	}
	/**
	* The title of the badge.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* The description of the badge.
	*/
	get description() {
		return this[rawDataSymbol].description;
	}
	/**
	* The action to take when clicking on the badge. Set to `null` if no action is specified.
	*/
	get clickAction() {
		return this[rawDataSymbol].click_action;
	}
	/**
	* The URL to navigate to when clicking on the badge. Set to `null` if no URL is specified.
	*/
	get clickUrl() {
		return this[rawDataSymbol].click_url;
	}
};
HelixChatBadgeVersion = __decorate([rtfm("api", "HelixChatBadgeVersion", "id")], HelixChatBadgeVersion);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixChatBadgeSet.js
/**
* A version of a chat badge.
*/
let HelixChatBadgeSet = class HelixChatBadgeSet extends DataObject {
	/**
	* The badge set ID.
	*/
	get id() {
		return this[rawDataSymbol].set_id;
	}
	/**
	* All versions of the badge.
	*/
	get versions() {
		return this[rawDataSymbol].versions.map((data) => new HelixChatBadgeVersion(data));
	}
	/**
	* Gets a specific version of the badge.
	*
	* @param versionId The ID of the version.
	*/
	getVersion(versionId) {
		return this.versions.find((v) => v.id === versionId) ?? null;
	}
};
__decorate([CachedGetter()], HelixChatBadgeSet.prototype, "versions", null);
HelixChatBadgeSet = __decorate([Cacheable, rtfm("api", "HelixChatBadgeSet", "id")], HelixChatBadgeSet);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixChatChatter.js
/**
* A user connected to a Twitch channel's chat session.
*/
let HelixChatChatter = class HelixChatChatter extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the user.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the user.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets more information about the user.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
};
__decorate([Enumerable(false)], HelixChatChatter.prototype, "_client", void 0);
HelixChatChatter = __decorate([rtfm("api", "HelixChatChatter")], HelixChatChatter);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixChatSettings.js
/**
* The settings of a broadcaster's chat.
*/
let HelixChatSettings = class HelixChatSettings extends DataObject {
	/**
	* The ID of the broadcaster.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* Whether slow mode is enabled.
	*/
	get slowModeEnabled() {
		return this[rawDataSymbol].slow_mode;
	}
	/**
	* The time to wait between messages in slow mode, in seconds.
	*
	* Is `null` if slow mode is not enabled.
	*/
	get slowModeDelay() {
		return this[rawDataSymbol].slow_mode_wait_time;
	}
	/**
	* Whether follower only mode is enabled.
	*/
	get followerOnlyModeEnabled() {
		return this[rawDataSymbol].follower_mode;
	}
	/**
	* The time after which users are able to send messages after following, in minutes.
	*
	* Is `null` if follower only mode is not enabled,
	* but may also be `0` if you can send messages immediately after following.
	*/
	get followerOnlyModeDelay() {
		return this[rawDataSymbol].follower_mode_duration;
	}
	/**
	* Whether subscriber only mode is enabled.
	*/
	get subscriberOnlyModeEnabled() {
		return this[rawDataSymbol].subscriber_mode;
	}
	/**
	* Whether emote only mode is enabled.
	*/
	get emoteOnlyModeEnabled() {
		return this[rawDataSymbol].emote_mode;
	}
	/**
	* Whether unique chat mode is enabled.
	*/
	get uniqueChatModeEnabled() {
		return this[rawDataSymbol].unique_chat_mode;
	}
};
HelixChatSettings = __decorate([rtfm("api", "HelixChatSettings", "broadcasterId")], HelixChatSettings);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixEmoteFromSet.js
/**
* A Twitch Channel emote.
*
* @inheritDoc
*/
let HelixEmoteFromSet = class HelixEmoteFromSet extends HelixEmote {
	/** @internal */ _client;
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The type of the emote.
	*
	* Known values are: `subscriptions`, `bitstier`, `follower`, `rewards`, `globals`, `smilies`, `prime`, `limitedtime`.
	*
	* This list may be non-exhaustive.
	*/
	get type() {
		return this[rawDataSymbol].emote_type;
	}
	/**
	* The ID of the emote set the emote is part of.
	*/
	get emoteSetId() {
		return this[rawDataSymbol].emote_set_id;
	}
	/**
	* The ID of the user that owns the emote, or null if the emote is not owned by a user.
	*/
	get ownerId() {
		switch (this[rawDataSymbol].owner_id) {
			case "0":
			case "twitch": return null;
			default: return this[rawDataSymbol].owner_id;
		}
	}
	/**
	* Gets more information about the user that owns the emote, or null if the emote is not owned by a user.
	*/
	async getOwner() {
		switch (this[rawDataSymbol].owner_id) {
			case "0":
			case "twitch": return null;
			default: return await this._client.users.getUserById(this[rawDataSymbol].owner_id);
		}
	}
};
__decorate([Enumerable(false)], HelixEmoteFromSet.prototype, "_client", void 0);
HelixEmoteFromSet = __decorate([rtfm("api", "HelixEmoteFromSet", "id")], HelixEmoteFromSet);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixPrivilegedChatSettings.js
/**
* The settings of a broadcaster's chat, with additional privileged data.
*/
let HelixPrivilegedChatSettings = class HelixPrivilegedChatSettings extends HelixChatSettings {
	/**
	* Whether non-moderator messages are delayed.
	*/
	get nonModeratorChatDelayEnabled() {
		return this[rawDataSymbol].non_moderator_chat_delay;
	}
	/**
	* The delay of non-moderator messages, in seconds.
	*
	* Is `null` if non-moderator message delay is disabled.
	*/
	get nonModeratorChatDelay() {
		return this[rawDataSymbol].non_moderator_chat_delay_duration;
	}
};
HelixPrivilegedChatSettings = __decorate([rtfm("api", "HelixPrivilegedChatSettings", "broadcasterId")], HelixPrivilegedChatSettings);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixSentChatMessage.js
/**
* Information about a sent Twitch chat message.
*/
let HelixSentChatMessage = class HelixSentChatMessage extends DataObject {
	/**
	* The message ID of the sent message.
	*/
	get id() {
		return this[rawDataSymbol].message_id;
	}
	/**
	* If the message passed all checks and was sent.
	*/
	get isSent() {
		return this[rawDataSymbol].is_sent;
	}
	/**
	* The reason code for why the chat message was dropped, if dropped.
	*/
	get dropReasonCode() {
		return this[rawDataSymbol].drop_reason?.code;
	}
	/**
	* The reason message for why the chat message was dropped, if dropped.
	*/
	get dropReasonMessage() {
		return this[rawDataSymbol].drop_reason?.message;
	}
};
HelixSentChatMessage = __decorate([rtfm("api", "HelixSentChatMessage", "id")], HelixSentChatMessage);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixSharedChatSessionParticipant.js
/**
* A shared chat session participant.
*/
let HelixSharedChatSessionParticipant = class HelixSharedChatSessionParticipant extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the participant broadcaster.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* Gets information about the participant broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
};
__decorate([Enumerable(false)], HelixSharedChatSessionParticipant.prototype, "_client", void 0);
HelixSharedChatSessionParticipant = __decorate([rtfm("api", "HelixSharedChatSessionParticipant", "broadcasterId")], HelixSharedChatSessionParticipant);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixSharedChatSession.js
/**
* A shared chat session.
*/
let HelixSharedChatSession = class HelixSharedChatSession extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The unique identifier for the shared chat session.
	*/
	get sessionId() {
		return this[rawDataSymbol].session_id;
	}
	/**
	* The ID of the host broadcaster.
	*/
	get hostBroadcasterId() {
		return this[rawDataSymbol].host_broadcaster_id;
	}
	/**
	* Gets information about the host broadcaster.
	*/
	async getHostBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].host_broadcaster_id));
	}
	/**
	* The list of participants in the session.
	*/
	get participants() {
		return this[rawDataSymbol].participants.map((data) => new HelixSharedChatSessionParticipant(data, this._client));
	}
	/**
	* The date for when the session was created.
	*/
	get createdDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* The date for when the session was updated.
	*/
	get updatedDate() {
		return new Date(this[rawDataSymbol].updated_at);
	}
};
__decorate([Enumerable(false)], HelixSharedChatSession.prototype, "_client", void 0);
HelixSharedChatSession = __decorate([rtfm("api", "HelixSharedChatSession", "sessionId")], HelixSharedChatSession);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixUserEmote.js
/**
* A Twitch user emote.
*/
let HelixUserEmote = class HelixUserEmote extends HelixEmoteBase {
	/** @internal */ _client;
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The type of the emote.
	*
	* There are many types of emotes that Twitch seems to arbitrarily assign.
	* Check the relevant values in the official documentation.
	*
	* @see https://dev.twitch.tv/docs/api/reference/#get-user-emotes
	*/
	get type() {
		return this[rawDataSymbol].emote_type;
	}
	/**
	* The ID that identifies the emote set that the emote belongs to, or `null` if the emote is not from any set.
	*/
	get emoteSetId() {
		return this[rawDataSymbol].emote_set_id || null;
	}
	/**
	* The ID of the broadcaster who owns the emote, or `null` if the emote has no owner, e.g. it's a global emote.
	*/
	get ownerId() {
		return this[rawDataSymbol].owner_id || null;
	}
	/**
	* Gets all emotes from the emotes set, or `null` if emote is not from any set.
	*/
	async getAllEmotesFromSet() {
		return this[rawDataSymbol].emote_set_id ? await this._client.chat.getEmotesFromSets([this[rawDataSymbol].emote_set_id]) : null;
	}
	/**
	* Gets more information about the user that owns the emote, or `null` if the emote is not owned by a user.
	*/
	async getOwner() {
		return this[rawDataSymbol].owner_id ? await this._client.users.getUserById(this[rawDataSymbol].owner_id) : null;
	}
};
__decorate([Enumerable(false)], HelixUserEmote.prototype, "_client", void 0);
HelixUserEmote = __decorate([rtfm("api", "HelixUserEmote", "id")], HelixUserEmote);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/chat/HelixChatApi.js
/**
* The Helix API methods that deal with chat.
*
* Can be accessed using `client.chat` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const rewards = await api.chat.getChannelBadges('125328655');
* ```
*
* @meta category helix
* @meta categorizedTitle Chat
*/
let HelixChatApi = class HelixChatApi extends BaseApi {
	/**
	* Gets the list of users that are connected to the broadcaster’s chat session.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster whose list of chatters you want to get.
	* @param pagination
	*
	* @expandParams
	*/
	async getChatters(broadcaster, pagination) {
		const broadcasterId = extractUserId(broadcaster);
		return createPaginatedResultWithTotal(await this._client.callApi({
			type: "helix",
			url: "chat/chatters",
			userId: broadcasterId,
			canOverrideScopedUserContext: true,
			scopes: ["moderator:read:chatters"],
			query: {
				...this._createModeratorActionQuery(broadcasterId),
				...createPaginationQuery(pagination)
			}
		}), HelixChatChatter, this._client);
	}
	/**
	* Creates a paginator for users that are connected to the broadcaster’s chat session.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster whose list of chatters you want to get.
	*
	* @expandParams
	*/
	getChattersPaginated(broadcaster) {
		const broadcasterId = extractUserId(broadcaster);
		return new HelixPaginatedRequestWithTotal({
			url: "chat/chatters",
			userId: broadcasterId,
			canOverrideScopedUserContext: true,
			scopes: ["moderator:read:chatters"],
			query: this._createModeratorActionQuery(broadcasterId)
		}, this._client, (data) => new HelixChatChatter(data, this._client), 1e3);
	}
	/**
	* Gets all global badges.
	*/
	async getGlobalBadges() {
		return (await this._client.callApi({
			type: "helix",
			url: "chat/badges/global"
		})).data.map((data) => new HelixChatBadgeSet(data));
	}
	/**
	* Gets all badges specific to the given broadcaster.
	*
	* @param broadcaster The broadcaster to get badges for.
	*/
	async getChannelBadges(broadcaster) {
		return (await this._client.callApi({
			type: "helix",
			url: "chat/badges",
			userId: extractUserId(broadcaster),
			query: createBroadcasterQuery(broadcaster)
		})).data.map((data) => new HelixChatBadgeSet(data));
	}
	/**
	* Gets all global emotes.
	*/
	async getGlobalEmotes() {
		return (await this._client.callApi({
			type: "helix",
			url: "chat/emotes/global"
		})).data.map((data) => new HelixEmote(data));
	}
	/**
	* Gets all emotes specific to the given broadcaster.
	*
	* @param broadcaster The broadcaster to get emotes for.
	*/
	async getChannelEmotes(broadcaster) {
		return (await this._client.callApi({
			type: "helix",
			url: "chat/emotes",
			userId: extractUserId(broadcaster),
			query: createBroadcasterQuery(broadcaster)
		})).data.map((data) => new HelixChannelEmote(data, this._client));
	}
	/**
	* Gets all emotes from a list of emote sets.
	*
	* @param setIds The IDs of the emote sets to get emotes from.
	*/
	async getEmotesFromSets(setIds) {
		return (await this._client.callApi({
			type: "helix",
			url: "chat/emotes/set",
			query: createSingleKeyQuery("emote_set_id", setIds)
		})).data.map((data) => new HelixEmoteFromSet(data, this._client));
	}
	/**
	* Gets emotes available to the user across all channels.
	*
	* @param user The ID of the user to get available emotes of.
	* @param filter Additional query filters.
	*/
	async getUserEmotes(user, filter) {
		const userId = extractUserId(user);
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "chat/emotes/user",
			userId: extractUserId(user),
			scopes: ["user:read:emotes"],
			query: {
				...createSingleKeyQuery("user_id", userId),
				...createSingleKeyQuery("broadcasterId", filter?.broadcaster ? extractUserId(filter.broadcaster) : void 0),
				...createPaginationQuery(filter)
			}
		}), HelixUserEmote, this._client);
	}
	/**
	* Creates a paginator for emotes available to the user across all channels.
	*
	* @param user The ID of the user to get available emotes of.
	* @param broadcaster The ID of a broadcaster you wish to get follower emotes of. Using this query parameter will
	* guarantee inclusion of the broadcaster’s follower emotes in the response body.
	*
	* If the user who retrieves their emotes is subscribed to the broadcaster specified, their follower emotes will
	* appear in the response body regardless of whether this query parameter is used.
	*/
	getUserEmotesPaginated(user, broadcaster) {
		const userId = extractUserId(user);
		return new HelixPaginatedRequest({
			url: "chat/emotes/user",
			userId,
			scopes: ["user:read:emotes"],
			query: {
				...createSingleKeyQuery("user_id", userId),
				...createSingleKeyQuery("broadcasterId", broadcaster ? extractUserId(broadcaster) : void 0)
			}
		}, this._client, (data) => new HelixUserEmote(data, this._client));
	}
	/**
	* Gets the settings of a broadcaster's chat.
	*
	* @param broadcaster The broadcaster the chat belongs to.
	*/
	async getSettings(broadcaster) {
		return new HelixChatSettings((await this._client.callApi({
			type: "helix",
			url: "chat/settings",
			userId: extractUserId(broadcaster),
			query: createBroadcasterQuery(broadcaster)
		})).data[0]);
	}
	/**
	* Gets the settings of a broadcaster's chat, including the delay settings.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster the chat belongs to.
	*/
	async getSettingsPrivileged(broadcaster) {
		const broadcasterId = extractUserId(broadcaster);
		return new HelixPrivilegedChatSettings((await this._client.callApi({
			type: "helix",
			url: "chat/settings",
			userId: broadcasterId,
			canOverrideScopedUserContext: true,
			scopes: ["moderator:read:chat_settings"],
			query: this._createModeratorActionQuery(broadcasterId)
		})).data[0]);
	}
	/**
	* Updates the settings of a broadcaster's chat.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @expandParams
	*
	* @param broadcaster The broadcaster the chat belongs to.
	* @param settings The settings to change.
	*/
	async updateSettings(broadcaster, settings) {
		const broadcasterId = extractUserId(broadcaster);
		return new HelixPrivilegedChatSettings((await this._client.callApi({
			type: "helix",
			url: "chat/settings",
			method: "PATCH",
			userId: broadcasterId,
			canOverrideScopedUserContext: true,
			scopes: ["moderator:manage:chat_settings"],
			query: this._createModeratorActionQuery(broadcasterId),
			jsonBody: createChatSettingsUpdateBody(settings)
		})).data[0]);
	}
	/**
	* Sends a chat message to a broadcaster's chat.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @expandParams
	*
	* @param broadcaster The broadcaster the chat belongs to.
	* @param message The message to send.
	* @param params
	*/
	async sendChatMessage(broadcaster, message, params) {
		const broadcasterId = extractUserId(broadcaster);
		const msg = new HelixSentChatMessage((await this._client.callApi({
			type: "helix",
			url: "chat/messages",
			method: "POST",
			userId: broadcasterId,
			canOverrideScopedUserContext: true,
			scopes: ["user:write:chat"],
			query: createSendChatMessageQuery(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)),
			jsonBody: createSendChatMessageBody(message, params)
		})).data[0]);
		this._handleUnsentChatMessage(broadcasterId, msg);
		return msg;
	}
	/**
	* Sends a chat message to a broadcaster's chat, using an app token.
	*
	* This requires the scopes `user:write:chat` and `user:bot` for the `user` and `channel:bot` for the `broadcaster`.
	* `channel:bot` is not required if the `user` has moderator privileges in the `broadcaster`'s channel.
	*
	* These scope requirements can not be checked by the library, so they are just assumed.
	* Make sure to catch authorization errors yourself.
	*
	* @expandParams
	*
	* @param user The user to send the chat message from.
	* @param broadcaster The broadcaster the chat belongs to.
	* @param message The message to send.
	* @param params
	*/
	async sendChatMessageAsApp(user, broadcaster, message, params) {
		const userId = extractUserId(user);
		const broadcasterId = extractUserId(broadcaster);
		const msg = new HelixSentChatMessage((await this._client.callApi({
			type: "helix",
			url: "chat/messages",
			method: "POST",
			forceType: "app",
			query: createSendChatMessageQuery(broadcasterId, userId),
			jsonBody: createSendChatMessageAsAppBody(message, params)
		})).data[0]);
		this._handleUnsentChatMessage(broadcasterId, msg);
		return msg;
	}
	/**
	* Sends an announcement to a broadcaster's chat.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster the chat belongs to.
	* @param announcement The announcement to send.
	*/
	async sendAnnouncement(broadcaster, announcement) {
		const broadcasterId = extractUserId(broadcaster);
		await this._client.callApi({
			type: "helix",
			url: "chat/announcements",
			method: "POST",
			userId: broadcasterId,
			canOverrideScopedUserContext: true,
			scopes: ["moderator:manage:announcements"],
			query: this._createModeratorActionQuery(broadcasterId),
			jsonBody: {
				message: announcement.message,
				color: announcement.color
			}
		});
	}
	/**
	* Gets the chat colors for a list of users.
	*
	* Returns a Map with user IDs as keys and their colors as values.
	* The value is a color hex code, or `null` if the user did not set a color,
	* and unknown users will not be present in the map.
	*
	* @param users The users to get the chat colors of.
	*/
	async getColorsForUsers(users) {
		const response = await this._client.callApi({
			type: "helix",
			url: "chat/color",
			query: createSingleKeyQuery("user_id", users.map(extractUserId))
		});
		return new Map(response.data.map((data) => [data.user_id, data.color || null]));
	}
	/**
	* Gets the chat color for a user.
	*
	* Returns the color as hex code, `null` if the user did not set a color, or `undefined` if the user is unknown.
	*
	* @param user The user to get the chat color of.
	*/
	async getColorForUser(user) {
		const response = await this._client.callApi({
			type: "helix",
			url: "chat/color",
			userId: extractUserId(user),
			query: createSingleKeyQuery("user_id", extractUserId(user))
		});
		if (!response.data.length) return;
		return response.data[0].color || null;
	}
	/**
	* Changes the chat color for a user.
	*
	* @param user The user to change the color of.
	* @param color The color to set.
	*
	* Note that hex codes can only be used by users that have a Prime or Turbo subscription.
	*/
	async setColorForUser(user, color) {
		await this._client.callApi({
			type: "helix",
			url: "chat/color",
			method: "PUT",
			userId: extractUserId(user),
			scopes: ["user:manage:chat_color"],
			query: createChatColorUpdateQuery(user, color)
		});
	}
	/**
	* Sends a shoutout to the specified broadcaster.
	* The broadcaster may send a shoutout once every 2 minutes. They may send the same broadcaster a shoutout once every 60 minutes.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param from The ID of the broadcaster that’s sending the shoutout.
	* @param to The ID of the broadcaster that’s receiving the shoutout.
	*/
	async shoutoutUser(from, to) {
		const fromId = extractUserId(from);
		await this._client.callApi({
			type: "helix",
			url: "chat/shoutouts",
			method: "POST",
			userId: fromId,
			canOverrideScopedUserContext: true,
			scopes: ["moderator:manage:shoutouts"],
			query: createShoutoutQuery(from, to, this._getUserContextIdWithDefault(fromId))
		});
	}
	/**
	* Gets the active shared chat session for a channel.
	*
	* Returns `null` if there is no active shared chat session in the channel.
	*
	* @param broadcaster The broadcaster to get the active shared chat session for.
	*/
	async getSharedChatSession(broadcaster) {
		const broadcasterId = extractUserId(broadcaster);
		const response = await this._client.callApi({
			type: "helix",
			url: "shared_chat/session",
			userId: broadcasterId,
			query: createSharedChatSessionQuery(broadcasterId)
		});
		if (response.data.length === 0) return null;
		return new HelixSharedChatSession(response.data[0], this._client);
	}
	_createModeratorActionQuery(broadcasterId) {
		return createModeratorActionQuery(broadcasterId, this._getUserContextIdWithDefault(broadcasterId));
	}
	_handleUnsentChatMessage(broadcasterId, msg) {
		if (!msg.isSent) throw new ChatMessageDroppedError(broadcasterId, msg.dropReasonMessage, msg.dropReasonCode);
	}
};
HelixChatApi = __decorate([rtfm("api", "HelixChatApi")], HelixChatApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/clip.external.js
/** @internal */
function createClipCreateQuery(params) {
	const { channel, createAfterDelay = false, title, duration } = params;
	return {
		broadcaster_id: extractUserId(channel),
		has_delay: createAfterDelay.toString(),
		title,
		duration: duration?.toFixed(1)
	};
}
/** @internal */
function createClipCreateFromVodQuery(params, editorId) {
	const { channel, title, duration, vodId, vodOffset } = params;
	return {
		broadcaster_id: extractUserId(channel),
		editor_id: editorId,
		title,
		duration: duration?.toFixed(1),
		vod_id: vodId,
		vod_offset: vodOffset.toString()
	};
}
/** @internal */
function createClipQuery(params) {
	const { filterType, ids, startDate, endDate, isFeatured } = params;
	return {
		[filterType]: ids,
		started_at: startDate,
		ended_at: endDate,
		is_featured: isFeatured?.toString()
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/clip/HelixClip.js
/**
* A clip from a Twitch stream.
*/
let HelixClip = class HelixClip extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The clip ID.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The URL of the clip.
	*/
	get url() {
		return this[rawDataSymbol].url;
	}
	/**
	* The embed URL of the clip.
	*/
	get embedUrl() {
		return this[rawDataSymbol].embed_url;
	}
	/**
	* The user ID of the broadcaster of the stream where the clip was created.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The display name of the broadcaster of the stream where the clip was created.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets information about the broadcaster of the stream where the clip was created.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The user ID of the creator of the clip.
	*/
	get creatorId() {
		return this[rawDataSymbol].creator_id;
	}
	/**
	* The display name of the creator of the clip.
	*/
	get creatorDisplayName() {
		return this[rawDataSymbol].creator_name;
	}
	/**
	* Gets information about the creator of the clip.
	*/
	async getCreator() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].creator_id));
	}
	/**
	* The ID of the video the clip is taken from.
	*/
	get videoId() {
		return this[rawDataSymbol].video_id;
	}
	/**
	* Gets information about the video the clip is taken from.
	*/
	async getVideo() {
		return checkRelationAssertion(await this._client.videos.getVideoById(this[rawDataSymbol].video_id));
	}
	/**
	* The ID of the game that was being played when the clip was created.
	*/
	get gameId() {
		return this[rawDataSymbol].game_id;
	}
	/**
	* Gets information about the game that was being played when the clip was created.
	*/
	async getGame() {
		return this[rawDataSymbol].game_id ? checkRelationAssertion(await this._client.games.getGameById(this[rawDataSymbol].game_id)) : null;
	}
	/**
	* The language of the stream where the clip was created.
	*/
	get language() {
		return this[rawDataSymbol].language;
	}
	/**
	* The title of the clip.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* The number of views of the clip.
	*/
	get views() {
		return this[rawDataSymbol].view_count;
	}
	/**
	* The date when the clip was created.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* The URL of the thumbnail of the clip.
	*/
	get thumbnailUrl() {
		return this[rawDataSymbol].thumbnail_url;
	}
	/**
	* The duration of the clip in seconds (up to 0.1 precision).
	*/
	get duration() {
		return this[rawDataSymbol].duration;
	}
	/**
	* The offset of the clip from the start of the corresponding VOD, in seconds.
	*
	* This may be null if there is no VOD or if the clip is created from a live broadcast,
	* in which case it may take a few minutes to associate with the VOD.
	*/
	get vodOffset() {
		return this[rawDataSymbol].vod_offset;
	}
	/**
	* Whether the clip is featured.
	*/
	get isFeatured() {
		return this[rawDataSymbol].is_featured;
	}
};
__decorate([Enumerable(false)], HelixClip.prototype, "_client", void 0);
HelixClip = __decorate([rtfm("api", "HelixClip", "id")], HelixClip);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/clip/HelixClipApi.js
/**
* The Helix API methods that deal with clips.
*
* Can be accessed using `client.clips` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const clipId = await api.clips.createClip({ channel: '125328655' });
* ```
*
* @meta category helix
* @meta categorizedTitle Clips
*/
let HelixClipApi = class HelixClipApi extends BaseApi {
	/** @internal */
	_getClipByIdBatcher = new HelixRequestBatcher({ url: "clips" }, "id", "id", this._client, (data) => new HelixClip(data, this._client));
	/**
	* Gets clips for the specified broadcaster in descending order of views.
	*
	* @param broadcaster The broadcaster to fetch clips for.
	* @param filter
	*
	* @expandParams
	*/
	async getClipsForBroadcaster(broadcaster, filter = {}) {
		return await this._getClips({
			...filter,
			filterType: "broadcaster_id",
			ids: extractUserId(broadcaster),
			userId: extractUserId(broadcaster)
		});
	}
	/**
	* Creates a paginator for clips for the specified broadcaster.
	*
	* @param broadcaster The broadcaster to fetch clips for.
	* @param filter
	*
	* @expandParams
	*/
	getClipsForBroadcasterPaginated(broadcaster, filter = {}) {
		return this._getClipsPaginated({
			...filter,
			filterType: "broadcaster_id",
			ids: extractUserId(broadcaster),
			userId: extractUserId(broadcaster)
		});
	}
	/**
	* Gets clips for the specified game in descending order of views.
	*
	* @param gameId The game ID.
	* @param filter
	*
	* @expandParams
	*/
	async getClipsForGame(gameId, filter = {}) {
		return await this._getClips({
			...filter,
			filterType: "game_id",
			ids: gameId
		});
	}
	/**
	* Creates a paginator for clips for the specified game.
	*
	* @param gameId The game ID.
	* @param filter
	*
	* @expandParams
	*/
	getClipsForGamePaginated(gameId, filter = {}) {
		return this._getClipsPaginated({
			...filter,
			filterType: "game_id",
			ids: gameId
		});
	}
	/**
	* Gets the clips identified by the given IDs.
	*
	* @param ids The clip IDs.
	*/
	async getClipsByIds(ids) {
		return (await this._getClips({
			filterType: "id",
			ids
		})).data;
	}
	/**
	* Gets the clip identified by the given ID.
	*
	* @param id The clip ID.
	*/
	async getClipById(id) {
		const clips = await this.getClipsByIds([id]);
		return clips.length ? clips[0] : null;
	}
	/**
	* Gets the clip identified by the given ID, batching multiple calls into fewer requests as the API allows.
	*
	* @param id The clip ID.
	*/
	async getClipByIdBatched(id) {
		return await this._getClipByIdBatcher.request(id);
	}
	/**
	* Creates a clip of a running stream.
	*
	* Returns the ID of the clip.
	*
	* @param params
	* @expandParams
	*/
	async createClip(params) {
		return (await this._client.callApi({
			type: "helix",
			url: "clips",
			method: "POST",
			userId: extractUserId(params.channel),
			scopes: ["clips:edit"],
			canOverrideScopedUserContext: true,
			query: createClipCreateQuery(params)
		})).data[0].id;
	}
	/**
	* Creates a clip of a VOD.
	*
	* Returns the ID of the clip.
	*
	* @param params
	* @expandParams
	*/
	async createClipFromVod(params) {
		const broadcasterId = extractUserId(params.channel);
		return (await this._client.callApi({
			type: "helix",
			url: "videos/clips",
			method: "POST",
			userId: broadcasterId,
			scopes: ["editor:manage:clips", "channel:manage:clips"],
			canOverrideScopedUserContext: true,
			query: createClipCreateFromVodQuery(params, this._getUserContextIdWithDefault(broadcasterId))
		})).data[0].id;
	}
	async _getClips(params) {
		if (!params.ids.length) return { data: [] };
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "clips",
			userId: params.userId,
			query: {
				...createClipQuery(params),
				...createPaginationQuery(params)
			}
		}), HelixClip, this._client);
	}
	_getClipsPaginated(params) {
		return new HelixPaginatedRequest({
			url: "clips",
			userId: params.userId,
			query: createClipQuery(params)
		}, this._client, (data) => new HelixClip(data, this._client));
	}
};
__decorate([Enumerable(false)], HelixClipApi.prototype, "_getClipByIdBatcher", void 0);
HelixClipApi = __decorate([rtfm("api", "HelixClipApi")], HelixClipApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/contentClassificationLabels/HelixContentClassificationLabel.js
/**
* A content classification label that can be applied to a Twitch stream.
*/
var HelixContentClassificationLabel = class extends DataObject {
	/**
	* The ID of the content classification label.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The name of the content classification label.
	*/
	get name() {
		return this[rawDataSymbol].name;
	}
	/**
	* The description of the content classification label.
	*/
	get description() {
		return this[rawDataSymbol].description;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/contentClassificationLabels/HelixContentClassificationLabelApi.js
/**
* The Helix API methods that deal with content classification labels.
*
* Can be accessed using `client.contentClassificationLabels` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const labels = await api.contentClassificationLabels.getAll();
* ```
*
* @meta category helix
* @meta categorizedTitle Content classification labels
*/
let HelixContentClassificationLabelApi = class HelixContentClassificationLabelApi extends BaseApi {
	/**
	* Fetches a list of all content classification labels.
	*
	* @param locale The locale for the content classification labels.
	*/
	async getAll(locale) {
		return (await this._client.callApi({
			url: "content_classification_labels",
			query: { locale }
		})).data.map((data) => new HelixContentClassificationLabel(data));
	}
};
HelixContentClassificationLabelApi = __decorate([rtfm("api", "HelixContentClassificationLabelApi")], HelixContentClassificationLabelApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/entitlement.external.js
/** @internal */
function createDropsEntitlementQuery(filters, alwaysApp) {
	return {
		user_id: alwaysApp ? mapOptional(filters.user, extractUserId) : void 0,
		game_id: filters.gameId,
		fulfillment_status: filters.fulfillmentStatus
	};
}
/** @internal */
function createDropsEntitlementUpdateBody(ids, fulfillmentStatus) {
	return {
		fulfillment_status: fulfillmentStatus,
		entitlement_ids: ids
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/entitlements/HelixDropsEntitlement.js
/**
* An entitlement for a drop.
*/
let HelixDropsEntitlement = class HelixDropsEntitlement extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the entitlement.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The ID of the reward.
	*/
	get rewardId() {
		return this[rawDataSymbol].benefit_id;
	}
	/**
	* The date when the entitlement was granted.
	*/
	get grantDate() {
		return new Date(this[rawDataSymbol].timestamp);
	}
	/**
	* The ID of the entitled user.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* Gets more information about the entitled user.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* The ID of the game the entitlement was granted for.
	*/
	get gameId() {
		return this[rawDataSymbol].game_id;
	}
	/**
	* Gets more information about the game the entitlement was granted for.
	*/
	async getGame() {
		return checkRelationAssertion(await this._client.games.getGameById(this[rawDataSymbol].game_id));
	}
	/**
	* The fulfillment status of the entitlement.
	*/
	get fulfillmentStatus() {
		return this[rawDataSymbol].fulfillment_status;
	}
	/**
	* The date when the entitlement was last updated.
	*/
	get updateDate() {
		return new Date(this[rawDataSymbol].last_updated);
	}
};
__decorate([Enumerable(false)], HelixDropsEntitlement.prototype, "_client", void 0);
HelixDropsEntitlement = __decorate([rtfm("api", "HelixDropsEntitlement")], HelixDropsEntitlement);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/entitlements/HelixEntitlementApi.js
/**
* The Helix API methods that deal with entitlements (drops).
*
* Can be accessed using `client.entitlements` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const clipId = await api.entitlements.getDropsEntitlements();
* ```
*
* @meta category helix
* @meta categorizedTitle Entitlements (Drops)
*/
let HelixEntitlementApi = class HelixEntitlementApi extends BaseApi {
	/** @internal */ _getDropsEntitlementByIdBatcher = new HelixRequestBatcher({ url: "entitlements/drops" }, "id", "id", this._client, (data) => new HelixDropsEntitlement(data, this._client));
	/**
	* Gets the drops entitlements for the given filter.
	*
	* @expandParams
	*
	* @param filter
	* @param alwaysApp Whether an app token should always be used, even if a user filter is given.
	*/
	async getDropsEntitlements(filter, alwaysApp = false) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "entitlements/drops",
			userId: mapOptional(filter.user, extractUserId),
			forceType: filter.user && alwaysApp ? "app" : void 0,
			query: {
				...createDropsEntitlementQuery(filter, alwaysApp),
				...createPaginationQuery(filter)
			}
		}), HelixDropsEntitlement, this._client);
	}
	/**
	* Creates a paginator for drops entitlements for the given filter.
	*
	* @expandParams
	*
	* @param filter
	* @param alwaysApp Whether an app token should always be used, even if a user filter is given.
	*/
	getDropsEntitlementsPaginated(filter, alwaysApp = false) {
		return new HelixPaginatedRequest({
			url: "entitlements/drops",
			userId: mapOptional(filter.user, extractUserId),
			forceType: filter.user && alwaysApp ? "app" : void 0,
			query: createDropsEntitlementQuery(filter, alwaysApp)
		}, this._client, (data) => new HelixDropsEntitlement(data, this._client));
	}
	/**
	* Gets the drops entitlements for the given IDs.
	*
	* @param ids The IDs to fetch.
	*/
	async getDropsEntitlementsByIds(ids) {
		return (await this._client.callApi({
			type: "helix",
			url: "entitlements/drops",
			query: { id: ids }
		})).data.map((data) => new HelixDropsEntitlement(data, this._client));
	}
	/**
	* Gets the drops entitlement for the given ID.
	*
	* @param id The ID to fetch.
	*/
	async getDropsEntitlementById(id) {
		return (await this.getDropsEntitlementsByIds([id]))[0] ?? null;
	}
	/**
	* Gets the drops entitlement for the given ID, batching multiple calls into fewer requests as the API allows.
	*
	* @param id The ID to fetch.
	*/
	async getDropsEntitlementByIdBatched(id) {
		return await this._getDropsEntitlementByIdBatcher.request(id);
	}
	/**
	* Updates the status of a list of drops entitlements.
	*
	* Returns a map that associates each given ID with its update status.
	*
	* @param ids The IDs of the entitlements.
	* @param fulfillmentStatus The fulfillment status to set the entitlements to.
	*/
	async updateDropsEntitlements(ids, fulfillmentStatus) {
		const response = await this._client.callApi({
			type: "helix",
			url: "entitlements/drops",
			method: "PATCH",
			jsonBody: createDropsEntitlementUpdateBody(ids, fulfillmentStatus)
		});
		return new Map(response.data.flatMap((entry) => entry.ids.map((id) => [id, entry.status])));
	}
};
__decorate([Enumerable(false)], HelixEntitlementApi.prototype, "_getDropsEntitlementByIdBatcher", void 0);
HelixEntitlementApi = __decorate([rtfm("api", "HelixEntitlementApi")], HelixEntitlementApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/eventSub.external.js
/** @internal */
function createEventSubBroadcasterCondition(broadcaster) {
	return { broadcaster_user_id: extractUserId(broadcaster) };
}
/** @internal */
function createEventSubRewardCondition(broadcaster, rewardId) {
	return {
		broadcaster_user_id: extractUserId(broadcaster),
		reward_id: rewardId
	};
}
/** @internal */
function createEventSubModeratorCondition(broadcasterId, moderatorId) {
	return {
		broadcaster_user_id: broadcasterId,
		moderator_user_id: moderatorId
	};
}
/** @internal */
function createEventSubUserCondition(broadcasterId, userId) {
	return {
		broadcaster_user_id: broadcasterId,
		user_id: userId
	};
}
/** @internal */
function createEventSubDropEntitlementGrantCondition(filter) {
	return {
		organization_id: filter.organizationId,
		category_id: filter.categoryId,
		campaign_id: filter.campaignId
	};
}
/** @internal */
function createEventSubConduitCondition(conduitId, status) {
	return {
		conduit_id: conduitId,
		status
	};
}
/** @internal */
function createEventSubConduitUpdateCondition(conduitId, shardCount) {
	return {
		id: conduitId,
		shard_count: shardCount.toString()
	};
}
/** @internal */
function createEventSubConduitShardsUpdateCondition(conduitId, shards) {
	return {
		conduit_id: conduitId,
		shards
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/eventSub/HelixEventSubSubscription.js
/**
* An EventSub subscription.
*/
let HelixEventSubSubscription = class HelixEventSubSubscription extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the subscription.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The status of the subscription.
	*/
	get status() {
		return this[rawDataSymbol].status;
	}
	/**
	* The event type that the subscription is listening to.
	*/
	get type() {
		return this[rawDataSymbol].type;
	}
	/**
	* The cost of the subscription.
	*/
	get cost() {
		return this[rawDataSymbol].cost;
	}
	/**
	* The condition of the subscription.
	*/
	get condition() {
		return this[rawDataSymbol].condition;
	}
	/**
	* The date and time of creation of the subscription.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* The transport method of the subscription.
	*/
	get transportMethod() {
		return this[rawDataSymbol].transport.method;
	}
	/**
	* End the EventSub subscription.
	*/
	async unsubscribe() {
		await this._client.eventSub.deleteSubscription(this[rawDataSymbol].id);
	}
	/** @private */
	get _transport() {
		return this[rawDataSymbol].transport;
	}
	/** @private */
	set _status(status) {
		this[rawDataSymbol].status = status;
	}
};
__decorate([Enumerable(false)], HelixEventSubSubscription.prototype, "_client", void 0);
HelixEventSubSubscription = __decorate([rtfm("api", "HelixEventSubSubscription", "id")], HelixEventSubSubscription);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/eventSub/HelixPaginatedEventSubSubscriptionsRequest.js
/**
* A special case of {@link HelixPaginatedRequestWithTotal} with support for fetching the total cost and cost limit
* of EventSub subscriptions.
*
* @inheritDoc
*/
let HelixPaginatedEventSubSubscriptionsRequest = class HelixPaginatedEventSubSubscriptionsRequest extends HelixPaginatedRequestWithTotal {
	/** @internal */
	constructor(query, userId, client) {
		super({
			url: "eventsub/subscriptions",
			userId,
			query
		}, client, (data) => new HelixEventSubSubscription(data, client));
	}
	/**
	* Gets the total cost of EventSub subscriptions.
	*/
	async getTotalCost() {
		return (this._currentData ?? await this._fetchData({ query: { after: void 0 } })).total_cost;
	}
	/**
	* Gets the cost limit of EventSub subscriptions.
	*/
	async getMaxTotalCost() {
		return (this._currentData ?? await this._fetchData({ query: { after: void 0 } })).max_total_cost;
	}
};
HelixPaginatedEventSubSubscriptionsRequest = __decorate([rtfm("api", "HelixPaginatedEventSubSubscriptionsRequest")], HelixPaginatedEventSubSubscriptionsRequest);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/eventSub/HelixEventSubConduit.js
/**
* Represents an EventSub conduit.
*/
let HelixEventSubConduit = class HelixEventSubConduit extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the conduit.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The shard count of the conduit.
	*/
	get shardCount() {
		return this[rawDataSymbol].shard_count;
	}
	/**
	* Update the conduit.
	*
	* @param shardCount The new shard count.
	*/
	async update(shardCount) {
		return await this._client.eventSub.updateConduit(this[rawDataSymbol].id, shardCount);
	}
	/**
	* Delete the conduit.
	*/
	async delete() {
		await this._client.eventSub.deleteConduit(this[rawDataSymbol].id);
	}
	/**
	* Get the conduit shards.
	*/
	async getShards() {
		return await this._client.eventSub.getConduitShards(this[rawDataSymbol].id);
	}
};
__decorate([Enumerable(false)], HelixEventSubConduit.prototype, "_client", void 0);
HelixEventSubConduit = __decorate([rtfm("api", "HelixEventSubConduit")], HelixEventSubConduit);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/eventSub/HelixEventSubConduitShard.js
/**
* Represents an EventSub conduit shard.
*/
let HelixEventSubConduitShard = class HelixEventSubConduitShard extends DataObject {
	/**
	* The ID of the shard.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The status of the shard.
	*/
	get status() {
		return this[rawDataSymbol].status;
	}
	/**
	* The transport method of the shard.
	*/
	get transportMethod() {
		return this[rawDataSymbol].transport.method;
	}
};
HelixEventSubConduitShard = __decorate([rtfm("api", "HelixEventSubConduitShard")], HelixEventSubConduitShard);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/eventSub/HelixEventSubApi.js
/**
* The API methods that deal with EventSub.
*
* Can be accessed using `client.eventSub` on an {@link ApiClient} instance.
*
* ## Before using these methods...
*
* All methods in this class assume that you are already running a working EventSub listener reachable using the given transport.
*
* If you don't already have one, we recommend use of the `@twurple/eventsub-http` or `@twurple/eventsub-ws` libraries,
* which handle subscribing and unsubscribing to these topics automatically.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* await api.eventSub.subscribeToUserFollowsTo('125328655', { callbackUrl: 'https://example.com' });
* ```
*
* @meta category helix
* @meta categorizedTitle EventSub
*/
let HelixEventSubApi = class HelixEventSubApi extends BaseApi {
	/**
	* Gets the current EventSub subscriptions for the current client.
	*
	* @param pagination
	*
	* @expandParams
	*/
	async getSubscriptions(pagination) {
		const result = await this._client.callApi({
			type: "helix",
			url: "eventsub/subscriptions",
			query: createPaginationQuery(pagination)
		});
		return {
			...createPaginatedResultWithTotal(result, HelixEventSubSubscription, this._client),
			totalCost: result.total_cost,
			maxTotalCost: result.max_total_cost
		};
	}
	/**
	* Creates a paginator for the current EventSub subscriptions for the current client.
	*/
	getSubscriptionsPaginated() {
		return new HelixPaginatedEventSubSubscriptionsRequest({}, void 0, this._client);
	}
	/**
	* Gets the current EventSub subscriptions with the given status for the current client.
	*
	* @param status The status of the subscriptions to get.
	* @param pagination
	*
	* @expandParams
	*/
	async getSubscriptionsForStatus(status, pagination) {
		const result = await this._client.callApi({
			type: "helix",
			url: "eventsub/subscriptions",
			query: {
				...createPaginationQuery(pagination),
				status
			}
		});
		return {
			...createPaginatedResultWithTotal(result, HelixEventSubSubscription, this._client),
			totalCost: result.total_cost,
			maxTotalCost: result.max_total_cost
		};
	}
	/**
	* Creates a paginator for the current EventSub subscriptions with the given status for the current client.
	*
	* @param status The status of the subscriptions to get.
	*/
	getSubscriptionsForStatusPaginated(status) {
		return new HelixPaginatedEventSubSubscriptionsRequest({ status }, void 0, this._client);
	}
	/**
	* Gets the current EventSub subscriptions with the given type for the current client.
	*
	* @param type The type of the subscriptions to get.
	* @param pagination
	*
	* @expandParams
	*/
	async getSubscriptionsForType(type, pagination) {
		const result = await this._client.callApi({
			type: "helix",
			url: "eventsub/subscriptions",
			query: {
				...createPaginationQuery(pagination),
				type
			}
		});
		return {
			...createPaginatedResultWithTotal(result, HelixEventSubSubscription, this._client),
			totalCost: result.total_cost,
			maxTotalCost: result.max_total_cost
		};
	}
	/**
	* Creates a paginator for the current EventSub subscriptions with the given type for the current client.
	*
	* @param type The type of the subscriptions to get.
	*/
	getSubscriptionsForTypePaginated(type) {
		return new HelixPaginatedEventSubSubscriptionsRequest({ type }, void 0, this._client);
	}
	/**
	* Gets the current EventSub subscriptions for the current user and client.
	*
	* @param user The user to get subscriptions for.
	* @param pagination
	*
	* @expandParams
	*/
	async getSubscriptionsForUser(user, pagination) {
		const result = await this._client.callApi({
			type: "helix",
			url: "eventsub/subscriptions",
			userId: extractUserId(user),
			query: {
				...createSingleKeyQuery("user_id", extractUserId(user)),
				...createPaginationQuery(pagination)
			}
		});
		return {
			...createPaginatedResultWithTotal(result, HelixEventSubSubscription, this._client),
			totalCost: result.total_cost,
			maxTotalCost: result.max_total_cost
		};
	}
	/**
	* Creates a paginator for the current EventSub subscriptions with the given type for the current client.
	*
	* @param user The user to get subscriptions for.
	*/
	getSubscriptionsForUserPaginated(user) {
		const userId = extractUserId(user);
		return new HelixPaginatedEventSubSubscriptionsRequest(createSingleKeyQuery("user_id", userId), userId, this._client);
	}
	/**
	* Sends an arbitrary request to subscribe to an event.
	*
	* You can only create WebHook transport subscriptions using app tokens
	* and WebSocket transport subscriptions using user tokens.
	*
	* @param type The type of the event.
	* @param version The version of the event.
	* @param condition The condition of the subscription.
	* @param transport The transport of the subscription.
	* @param user The user to create the subscription in context of.
	* @param requiredScopeSet The scope set required by the subscription. Will only be checked for applicable transports.
	* @param canOverrideScopedUserContext Whether the auth user context can be overridden.
	* @param isBatched Whether to enable batching for the subscription. Is only supported for select topics.
	*/
	async createSubscription(type, version, condition, transport, user, requiredScopeSet, canOverrideScopedUserContext, isBatched) {
		const usesAppAuth = transport.method === "webhook" || transport.method === "conduit";
		const scopes = usesAppAuth ? void 0 : requiredScopeSet;
		if (!usesAppAuth && !user) throw new Error(`Transport ${transport.method} can only handle subscriptions with user context`);
		const jsonBody = {
			type,
			version,
			condition,
			transport
		};
		if (isBatched) jsonBody.is_batching_enabled = true;
		return new HelixEventSubSubscription((await this._client.callApi({
			type: "helix",
			url: "eventsub/subscriptions",
			method: "POST",
			scopes,
			userId: mapOptional(user, extractUserId),
			canOverrideScopedUserContext,
			forceType: usesAppAuth ? "app" : "user",
			jsonBody
		})).data[0], this._client);
	}
	/**
	* Deletes a subscription.
	*
	* @param id The ID of the subscription.
	*/
	async deleteSubscription(id) {
		await this._client.callApi({
			type: "helix",
			url: "eventsub/subscriptions",
			method: "DELETE",
			query: { id }
		});
	}
	/**
	* Deletes *all* subscriptions.
	*/
	async deleteAllSubscriptions() {
		await this._deleteSubscriptionsWithCondition();
	}
	/**
	* Deletes all broken subscriptions, i.e. all that are not enabled or pending verification.
	*/
	async deleteBrokenSubscriptions() {
		await this._deleteSubscriptionsWithCondition((sub) => sub.status !== "enabled" && sub.status !== "webhook_callback_verification_pending");
	}
	/**
	* Subscribe to events that represent a stream going live.
	*
	* @param broadcaster The broadcaster you want to listen to online events for.
	* @param transport The transport options.
	*/
	async subscribeToStreamOnlineEvents(broadcaster, transport) {
		return await this.createSubscription("stream.online", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster);
	}
	/**
	* Subscribe to events that represent a stream going offline.
	*
	* @param broadcaster The broadcaster you want to listen to online events for.
	* @param transport The transport options.
	*/
	async subscribeToStreamOfflineEvents(broadcaster, transport) {
		return await this.createSubscription("stream.offline", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster);
	}
	/**
	* Subscribe to events that represent a channel updating their metadata.
	*
	* @param broadcaster The broadcaster you want to listen to update events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelUpdateEvents(broadcaster, transport) {
		return await this.createSubscription("channel.update", "2", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster);
	}
	/**
	* Subscribe to events that represent a user following a channel.
	*
	* @param broadcaster The broadcaster you want to listen to follow events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelFollowEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.follow", "2", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcasterId, ["moderator:read:followers"], true);
	}
	/**
	* Subscribe to events that represent a user subscribing to a channel.
	*
	* @param broadcaster The broadcaster you want to listen to subscribe events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelSubscriptionEvents(broadcaster, transport) {
		return await this.createSubscription("channel.subscribe", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:subscriptions"]);
	}
	/**
	* Subscribe to events that represent a user gifting another user a subscription to a channel.
	*
	* @param broadcaster The broadcaster you want to listen to subscription gift events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelSubscriptionGiftEvents(broadcaster, transport) {
		return await this.createSubscription("channel.subscription.gift", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:subscriptions"]);
	}
	/**
	* Subscribe to events that represent a user's subscription to a channel being announced.
	*
	* @param broadcaster The broadcaster you want to listen to subscription message events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelSubscriptionMessageEvents(broadcaster, transport) {
		return await this.createSubscription("channel.subscription.message", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:subscriptions"]);
	}
	/**
	* Subscribe to events that represent a user's subscription to a channel ending.
	*
	* @param broadcaster The broadcaster you want to listen to subscription end events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelSubscriptionEndEvents(broadcaster, transport) {
		return await this.createSubscription("channel.subscription.end", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:subscriptions"]);
	}
	/**
	* Subscribe to events that represent a user cheering bits to a channel.
	*
	* @param broadcaster The broadcaster you want to listen to cheer events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelCheerEvents(broadcaster, transport) {
		return await this.createSubscription("channel.cheer", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["bits:read"]);
	}
	/**
	* Subscribe to events that represent a charity campaign starting in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to charity donation events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelCharityCampaignStartEvents(broadcaster, transport) {
		return await this.createSubscription("channel.charity_campaign.start", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:charity"]);
	}
	/**
	* Subscribe to events that represent a charity campaign ending in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to charity donation events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelCharityCampaignStopEvents(broadcaster, transport) {
		return await this.createSubscription("channel.charity_campaign.stop", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:charity"]);
	}
	/**
	* Subscribe to events that represent a user donating to a charity campaign in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to charity donation events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelCharityDonationEvents(broadcaster, transport) {
		return await this.createSubscription("channel.charity_campaign.donate", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:charity"]);
	}
	/**
	* Subscribe to events that represent a charity campaign progressing in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to charity donation events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelCharityCampaignProgressEvents(broadcaster, transport) {
		return await this.createSubscription("channel.charity_campaign.progress", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:charity"]);
	}
	/**
	* Subscribe to events that represent a user being banned in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to ban events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelBanEvents(broadcaster, transport) {
		return await this.createSubscription("channel.ban", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:moderate"]);
	}
	/**
	* Subscribe to events that represent a user being unbanned in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to unban events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelUnbanEvents(broadcaster, transport) {
		return await this.createSubscription("channel.unban", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:moderate"]);
	}
	/**
	* Subscribe to events that represent Shield Mode being activated in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to Shield Mode activation events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelShieldModeBeginEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.shield_mode.begin", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcasterId, ["moderator:read:shield_mode", "moderator:manage:shield_mode"], true);
	}
	/**
	* Subscribe to events that represent Shield Mode being deactivated in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to Shield Mode deactivation events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelShieldModeEndEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.shield_mode.end", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcasterId, ["moderator:read:shield_mode", "moderator:manage:shield_mode"], true);
	}
	/**
	* Subscribe to events that represent a moderator being added to a channel.
	*
	* @param broadcaster The broadcaster you want to listen for moderator add events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelModeratorAddEvents(broadcaster, transport) {
		return await this.createSubscription("channel.moderator.add", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["moderation:read"]);
	}
	/**
	* Subscribe to events that represent a moderator being removed from a channel.
	*
	* @param broadcaster The broadcaster you want to listen for moderator remove events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelModeratorRemoveEvents(broadcaster, transport) {
		return await this.createSubscription("channel.moderator.remove", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["moderation:read"]);
	}
	/**
	* Subscribe to events that represent a broadcaster raiding another broadcaster.
	*
	* @param broadcaster The broadcaster you want to listen to outgoing raid events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRaidEventsFrom(broadcaster, transport) {
		return await this.createSubscription("channel.raid", "1", createSingleKeyQuery("from_broadcaster_user_id", extractUserId(broadcaster)), transport, broadcaster);
	}
	/**
	* Subscribe to events that represent a broadcaster being raided by another broadcaster.
	*
	* @param broadcaster The broadcaster you want to listen to incoming raid events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRaidEventsTo(broadcaster, transport) {
		return await this.createSubscription("channel.raid", "1", createSingleKeyQuery("to_broadcaster_user_id", extractUserId(broadcaster)), transport, broadcaster);
	}
	/**
	* Subscribe to events that represent a Channel Points reward being added to a channel.
	*
	* @param broadcaster The broadcaster you want to listen to reward add events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRewardAddEvents(broadcaster, transport) {
		return await this.createSubscription("channel.channel_points_custom_reward.add", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a Channel Points reward being updated in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to reward update events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRewardUpdateEvents(broadcaster, transport) {
		return await this.createSubscription("channel.channel_points_custom_reward.update", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a specific Channel Points reward being updated.
	*
	* @param broadcaster The broadcaster you want to listen to reward update events for.
	* @param rewardId The ID of the reward you want to listen to update events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRewardUpdateEventsForReward(broadcaster, rewardId, transport) {
		return await this.createSubscription("channel.channel_points_custom_reward.update", "1", createEventSubRewardCondition(broadcaster, rewardId), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a Channel Points reward being removed from a channel.
	*
	* @param broadcaster The broadcaster you want to listen to reward remove events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRewardRemoveEvents(broadcaster, transport) {
		return await this.createSubscription("channel.channel_points_custom_reward.remove", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a specific Channel Points reward being removed from a channel.
	*
	* @param broadcaster The broadcaster you want to listen to reward remove events for.
	* @param rewardId The ID of the reward you want to listen to remove events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRewardRemoveEventsForReward(broadcaster, rewardId, transport) {
		return await this.createSubscription("channel.channel_points_custom_reward.remove", "1", createEventSubRewardCondition(broadcaster, rewardId), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a Channel Points reward being redeemed.
	*
	* @param broadcaster The broadcaster you want to listen to redemption events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRedemptionAddEvents(broadcaster, transport) {
		return await this.createSubscription("channel.channel_points_custom_reward_redemption.add", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a specific Channel Points reward being redeemed.
	*
	* @param broadcaster The broadcaster you want to listen to redemption events for.
	* @param rewardId The ID of the reward you want to listen to redemption events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRedemptionAddEventsForReward(broadcaster, rewardId, transport) {
		return await this.createSubscription("channel.channel_points_custom_reward_redemption.add", "1", createEventSubRewardCondition(broadcaster, rewardId), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a Channel Points redemption being updated.
	*
	* @param broadcaster The broadcaster you want to listen to redemption update events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRedemptionUpdateEvents(broadcaster, transport) {
		return await this.createSubscription("channel.channel_points_custom_reward_redemption.update", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a specific Channel Points reward's redemption being updated.
	*
	* @param broadcaster The broadcaster you want to listen to redemption update events for.
	* @param rewardId The ID of the reward you want to listen to redemption updates for.
	* @param transport The transport options.
	*/
	async subscribeToChannelRedemptionUpdateEventsForReward(broadcaster, rewardId, transport) {
		return await this.createSubscription("channel.channel_points_custom_reward_redemption.update", "1", createEventSubRewardCondition(broadcaster, rewardId), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a Channel Points automatic reward being redeemed.
	*
	* @param broadcaster The broadcaster you want to listen to automatic reward redemption events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelAutomaticRewardRedemptionAddEvents(broadcaster, transport) {
		return await this.createSubscription("channel.channel_points_automatic_reward_redemption.add", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a Channel Points automatic reward being redeemed.
	*
	* @param broadcaster The broadcaster you want to listen to automatic reward redemption events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelAutomaticRewardRedemptionAddV2Events(broadcaster, transport) {
		return await this.createSubscription("channel.channel_points_automatic_reward_redemption.add", "2", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:redemptions", "channel:manage:redemptions"]);
	}
	/**
	* Subscribe to events that represent a poll starting in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to poll begin events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelPollBeginEvents(broadcaster, transport) {
		return await this.createSubscription("channel.poll.begin", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:polls", "channel:manage:polls"]);
	}
	/**
	* Subscribe to events that represent a poll being voted on in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to poll progress events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelPollProgressEvents(broadcaster, transport) {
		return await this.createSubscription("channel.poll.progress", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:polls", "channel:manage:polls"]);
	}
	/**
	* Subscribe to events that represent a poll ending in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to poll end events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelPollEndEvents(broadcaster, transport) {
		return await this.createSubscription("channel.poll.end", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:polls", "channel:manage:polls"]);
	}
	/**
	* Subscribe to events that represent a prediction starting in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to prediction begin events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelPredictionBeginEvents(broadcaster, transport) {
		return await this.createSubscription("channel.prediction.begin", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:predictions", "channel:manage:predictions"]);
	}
	/**
	* Subscribe to events that represent a prediction being voted on in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to prediction preogress events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelPredictionProgressEvents(broadcaster, transport) {
		return await this.createSubscription("channel.prediction.progress", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:predictions", "channel:manage:predictions"]);
	}
	/**
	* Subscribe to events that represent a prediction being locked in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to prediction lock events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelPredictionLockEvents(broadcaster, transport) {
		return await this.createSubscription("channel.prediction.lock", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:predictions", "channel:manage:predictions"]);
	}
	/**
	* Subscribe to events that represent a prediction ending in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to prediction end events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelPredictionEndEvents(broadcaster, transport) {
		return await this.createSubscription("channel.prediction.end", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:predictions", "channel:manage:predictions"]);
	}
	/**
	* Subscribe to events that represent the beginning of a creator goal event in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to goal begin events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelGoalBeginEvents(broadcaster, transport) {
		return await this.createSubscription("channel.goal.begin", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:goals"]);
	}
	/**
	* Subscribe to events that represent progress towards a creator goal.
	*
	* @param broadcaster The broadcaster for which you want to listen to goal progress events.
	* @param transport The transport options.
	*/
	async subscribeToChannelGoalProgressEvents(broadcaster, transport) {
		return await this.createSubscription("channel.goal.progress", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:goals"]);
	}
	/**
	* Subscribe to events that represent the end of a creator goal event.
	*
	* @param broadcaster The broadcaster for which you want to listen to goal end events.
	* @param transport The transport options.
	*/
	async subscribeToChannelGoalEndEvents(broadcaster, transport) {
		return await this.createSubscription("channel.goal.end", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:goals"]);
	}
	/**
	* Subscribe to events that represent the beginning of a Hype Train event in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to Hype train begin events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelHypeTrainBeginEvents(broadcaster, transport) {
		return await this.createSubscription("channel.hype_train.begin", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:hype_train"]);
	}
	/**
	* Subscribe to events that represent progress towards the Hype Train goal.
	*
	* @param broadcaster The broadcaster for which you want to listen to Hype Train progress events.
	* @param transport The transport options.
	*/
	async subscribeToChannelHypeTrainProgressEvents(broadcaster, transport) {
		return await this.createSubscription("channel.hype_train.progress", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:hype_train"]);
	}
	/**
	* Subscribe to events that represent the end of a Hype Train event.
	*
	* @param broadcaster The broadcaster for which you want to listen to Hype Train end events.
	* @param transport The transport options.
	*/
	async subscribeToChannelHypeTrainEndEvents(broadcaster, transport) {
		return await this.createSubscription("channel.hype_train.end", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:hype_train"]);
	}
	/**
	* Subscribe to events that represent the beginning of a Hype Train event in a channel.
	*
	* @param broadcaster The broadcaster you want to listen to Hype train begin events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelHypeTrainBeginV2Events(broadcaster, transport) {
		return await this.createSubscription("channel.hype_train.begin", "2", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:hype_train"]);
	}
	/**
	* Subscribe to events that represent progress towards the Hype Train goal.
	*
	* @param broadcaster The broadcaster for which you want to listen to Hype Train progress events.
	* @param transport The transport options.
	*/
	async subscribeToChannelHypeTrainProgressV2Events(broadcaster, transport) {
		return await this.createSubscription("channel.hype_train.progress", "2", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:hype_train"]);
	}
	/**
	* Subscribe to events that represent the end of a Hype Train event.
	*
	* @param broadcaster The broadcaster for which you want to listen to Hype Train end events.
	* @param transport The transport options.
	*/
	async subscribeToChannelHypeTrainEndV2Events(broadcaster, transport) {
		return await this.createSubscription("channel.hype_train.end", "2", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:hype_train"]);
	}
	/**
	* Subscribe to events that represent a broadcaster shouting out another broadcaster.
	*
	* @param broadcaster The broadcaster for which you want to listen to outgoing shoutout events.
	* @param transport The transport options.
	*/
	async subscribeToChannelShoutoutCreateEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.shoutout.create", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcasterId, ["moderator:read:shoutouts", "moderator:manage:shoutouts"], true);
	}
	/**
	* Subscribe to events that represent a broadcaster being shouting out by another broadcaster.
	*
	* @param broadcaster The broadcaster for which you want to listen to incoming shoutout events.
	* @param transport The transport options.
	*/
	async subscribeToChannelShoutoutReceiveEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.shoutout.receive", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcasterId, ["moderator:read:shoutouts", "moderator:manage:shoutouts"], true);
	}
	/**
	* Subscribe to events that represent an ad break beginning in a channel.
	*
	* @param broadcaster The broadcaster for which you want to listen to ad break begin events.
	* @param transport The transport options.
	*/
	async subscribeToChannelAdBreakBeginEvents(broadcaster, transport) {
		return await this.createSubscription("channel.ad_break.begin", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:ads"]);
	}
	/**
	* Subscribe to events that represent a channel's chat being cleared.
	*
	* @param broadcaster The broadcaster for which you want to listen to chat clear events.
	* @param transport The transport options.
	*/
	async subscribeToChannelChatClearEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.chat.clear", "1", createEventSubUserCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["user:read:chat"], true);
	}
	/**
	* Subscribe to events that represent a user's chat messages being cleared in a channel.
	*
	* @param broadcaster The broadcaster for which you want to listen to user chat message clear events.
	* @param transport The transport options.
	*/
	async subscribeToChannelChatClearUserMessagesEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.chat.clear_user_messages", "1", createEventSubUserCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["user:read:chat"], true);
	}
	/**
	* Subscribe to events that represent a chat message being deleted in a channel.
	*
	* @param broadcaster The broadcaster for which you want to listen to chat message delete events.
	* @param transport The transport options.
	*/
	async subscribeToChannelChatMessageDeleteEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.chat.message_delete", "1", createEventSubUserCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["user:read:chat"], true);
	}
	/**
	* Subscribe to events that represent a chat notification in a channel.
	*
	* @param broadcaster The broadcaster for which you want to listen to chat notification events.
	* @param transport The transport options.
	*/
	async subscribeToChannelChatNotificationEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.chat.notification", "1", createEventSubUserCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["user:read:chat"], true);
	}
	/**
	* Subscribe to events that represent a chat message in a channel.
	*
	* @param broadcaster The broadcaster for which you want to listen to chat message events.
	* @param transport The transport options.
	*/
	async subscribeToChannelChatMessageEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.chat.message", "1", createEventSubUserCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["user:read:chat"], true);
	}
	/**
	* Subscribe to events that represent chat settings being updated in a channel.
	*
	* @param broadcaster The broadcaster for which you want to listen to chat settings update events.
	* @param transport The transport options.
	*/
	async subscribeToChannelChatSettingsUpdateEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.chat_settings.update", "1", createEventSubUserCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["user:read:chat"], true);
	}
	/**
	* Subscribe to events that represent a created unban requests in a channel.
	*
	* @param broadcaster The broadcaster for which you want to listen to unban requests.
	* @param transport The transport options.
	*/
	async subscribeToChannelUnbanRequestCreateEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.unban_request.create", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:read:unban_requests", "moderator:manage:unban_requests"], true);
	}
	/**
	* Subscribe to events that represent a resolved unban requests in a channel.
	*
	* @param broadcaster The broadcaster for which you want to listen to unban requests.
	* @param transport The transport options.
	*/
	async subscribeToChannelUnbanRequestResolveEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.unban_request.resolve", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:read:unban_requests", "moderator:manage:unban_requests"], true);
	}
	/**
	* Subscribe to events that represent a moderator performing an action on a channel.
	*
	* This requires the following scopes:
	* - `moderator:read:blocked_terms` OR `moderator:manage:blocked_terms`
	* - `moderator:read:chat_settings` OR `moderator:manage:chat_settings`
	* - `moderator:read:unban_requests` OR `moderator:manage:unban_requests`
	* - `moderator:read:banned_users` OR `moderator:manage:banned_users`
	* - `moderator:read:chat_messages` OR `moderator:manage:chat_messages`
	* - `moderator:read:warnings` OR `moderator:manage:warnings`
	* - `moderator:read:moderators`
	* - `moderator:read:vips`
	*
	* These scope requirements cannot be checked by the library, so they are just assumed.
	* Make sure to catch authorization errors yourself.
	*
	* @param broadcaster The broadcaster for which you want to listen to moderation events.
	* @param transport The transport options.
	*/
	async subscribeToChannelModerateEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.moderate", "2", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, [], true);
	}
	/**
	* Subscribe to events that represent a warning being acknowledged by a user.
	*
	* @param broadcaster The broadcaster for whom you want to listen to warnings.
	* @param transport The transport options.
	*/
	async subscribeToChannelWarningAcknowledgeEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.warning.acknowledge", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:read:warnings", "moderator:manage:warnings"], true);
	}
	/**
	* Subscribe to events that represent a warning sent to a user.
	*
	* @param broadcaster The broadcaster for whom you want to listen to warnings.
	* @param transport The transport options.
	*/
	async subscribeToChannelWarningSendEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.warning.send", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:read:warnings", "moderator:manage:warnings"], true);
	}
	/**
	* Subscribe to events that represent a VIP being added to a channel.
	*
	* @param broadcaster The broadcaster you want to listen for VIP add events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelVipAddEvents(broadcaster, transport) {
		return await this.createSubscription("channel.vip.add", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:vips", "channel:manage:vips"]);
	}
	/**
	* Subscribe to events that represent a VIP being removed from a channel.
	*
	* @param broadcaster The broadcaster you want to listen for VIP remove events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelVipRemoveEvents(broadcaster, transport) {
		return await this.createSubscription("channel.vip.remove", "1", createEventSubBroadcasterCondition(broadcaster), transport, broadcaster, ["channel:read:vips", "channel:manage:vips"]);
	}
	/**
	* Subscribe to events that represent an extension Bits transaction.
	*
	* @param clientId The Client ID for the extension you want to listen to Bits transactions for.
	* @param transport The transport options.
	*/
	async subscribeToExtensionBitsTransactionCreateEvents(clientId, transport) {
		return await this.createSubscription("extension.bits_transaction.create", "1", createSingleKeyQuery("extension_client_id", clientId), transport);
	}
	/**
	* Subscribe to events that represent a user granting authorization to an application.
	*
	* @param clientId The Client ID for the application you want to listen to authorization grant events for.
	* @param transport The transport options.
	*/
	async subscribeToUserAuthorizationGrantEvents(clientId, transport) {
		return await this.createSubscription("user.authorization.grant", "1", createSingleKeyQuery("client_id", clientId), transport);
	}
	/**
	* Subscribe to events that represent a user revoking their authorization from an application.
	*
	* @param clientId The Client ID for the application you want to listen to authorization revoke events for.
	* @param transport The transport options.
	*/
	async subscribeToUserAuthorizationRevokeEvents(clientId, transport) {
		return await this.createSubscription("user.authorization.revoke", "1", createSingleKeyQuery("client_id", clientId), transport);
	}
	/**
	* Subscribe to events that represent a user updating their account details.
	*
	* @param user The user you want to listen to user update events for.
	* @param transport The transport options.
	* @param withEmail Whether to request adding the email address of the user to the notification.
	*
	* Only has an effect with the websocket transport.
	* With the webhook transport, this depends solely on the previous authorization given by the user.
	*/
	async subscribeToUserUpdateEvents(user, transport, withEmail) {
		return await this.createSubscription("user.update", "1", createSingleKeyQuery("user_id", extractUserId(user)), transport, user, withEmail ? ["user:read:email"] : void 0);
	}
	/**
	* Subscribe to events that represent a user receiving a whisper message from another user.
	*
	* @param user The user you want to listen to whisper message events for.
	* @param transport The transport options.
	*/
	async subscribeToUserWhisperMessageEvents(user, transport) {
		return await this.createSubscription("user.whisper.message", "1", createSingleKeyQuery("user_id", extractUserId(user)), transport, user, ["user:read:whispers", "user:manage:whispers"]);
	}
	/**
	* Subscribe to events that represent a drop entitlement being granted.
	*
	* @expandParams
	*
	* @param filter
	* @param transport The transport options.
	*/
	async subscribeToDropEntitlementGrantEvents(filter, transport) {
		return await this.createSubscription("drop.entitlement.grant", "1", createEventSubDropEntitlementGrantCondition(filter), transport, void 0, void 0, false, true);
	}
	/**
	* Subscribes to events that represent a chat message being held by AutoMod.
	*
	* @param broadcaster The broadcaster you want to listen to AutoMod message hold events for.
	* @param transport The transport options.
	*/
	async subscribeToAutoModMessageHoldEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("automod.message.hold", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:manage:automod"], true);
	}
	/**
	* Subscribes to events that represent a held chat message by AutoMod being resolved.
	*
	* @param broadcaster The broadcaster you want to listen to AutoMod message resolution events for.
	* @param transport The transport options.
	*/
	async subscribeToAutoModMessageUpdateEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("automod.message.update", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:manage:automod"], true);
	}
	/**
	* Subscribes to events (v2) that represent a chat message being held by AutoMod.
	*
	* @param broadcaster The broadcaster you want to listen to AutoMod message hold events for.
	* @param transport The transport options.
	*/
	async subscribeToAutoModMessageHoldV2Events(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("automod.message.hold", "2", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:manage:automod"], true);
	}
	/**
	* Subscribes to events (v2) that represent a held chat message by AutoMod being resolved.
	*
	* @param broadcaster The broadcaster you want to listen to AutoMod message resolution events for.
	* @param transport The transport options.
	*/
	async subscribeToAutoModMessageUpdateV2Events(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("automod.message.update", "2", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:manage:automod"], true);
	}
	/**
	* Subscribes to events that represent the AutoMod settings being updated.
	*
	* @param broadcaster The broadcaster you want to listen to AutoMod settings update events.
	* @param transport The transport options.
	*/
	async subscribeToAutoModSettingsUpdateEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("automod.settings.update", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:read:automod_settings"], true);
	}
	/**
	* Subscribes to events that represent the AutoMod terms being updated.
	*
	* @param broadcaster The broadcaster you want to listen to AutoMod terms update events.
	* @param transport The transport options.
	*/
	async subscribeToAutoModTermsUpdateEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("automod.terms.update", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:manage:automod"], true);
	}
	/**
	* Subscribes to events that represent a user's notification about their message being held by AutoMod.
	*
	* @param broadcaster The broadcaster you want to listen to AutoMod message hold events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelChatUserMessageHoldEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.chat.user_message_hold", "1", createEventSubUserCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["user:read:chat"], true);
	}
	/**
	* Subscribes to events that represent a user's notification about a held chat message by AutoMod being resolved.
	*
	* @param broadcaster The broadcaster you want to listen to AutoMod message resolution events for.
	* @param transport The transport options.
	*/
	async subscribeToChannelChatUserMessageUpdateEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.chat.user_message_update", "1", createEventSubUserCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["user:read:chat"], true);
	}
	/**
	* Subscribes to events that represent a suspicious user updated in a channel.
	*
	* @param broadcaster The broadcaster you want to listen for suspicious user update events.
	* @param transport The transport options.
	*/
	async subscribeToChannelSuspiciousUserUpdateEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.suspicious_user.update", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:read:suspicious_users"], true);
	}
	/**
	* Subscribes to events that represent a message sent by a suspicious user.
	*
	* @param broadcaster The broadcaster you want to listen for messages sent by suspicious users.
	* @param transport The transport options.
	*/
	async subscribeToChannelSuspiciousUserMessageEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.suspicious_user.message", "1", createEventSubModeratorCondition(broadcasterId, this._getUserContextIdWithDefault(broadcasterId)), transport, broadcaster, ["moderator:read:suspicious_users"], true);
	}
	/**
	* Subscribes to events indicating that a shared chat session has begun in a channel.
	*
	* @param broadcaster The broadcaster for whom shared chat session begin events should be listened to.
	* @param transport The transport options to use for the subscription.
	*/
	async subscribeToChannelSharedChatSessionBeginEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.shared_chat.begin", "1", createEventSubBroadcasterCondition(broadcasterId), transport, broadcasterId);
	}
	/**
	* Subscribes to events indicating that a shared chat session has been updated in a channel.
	*
	* @param broadcaster The broadcaster for whom shared chat session update events should be listened to.
	* @param transport The transport options to use for the subscription.
	*/
	async subscribeToChannelSharedChatSessionUpdateEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.shared_chat.update", "1", createEventSubBroadcasterCondition(broadcasterId), transport, broadcasterId);
	}
	/**
	* Subscribes to events indicating that a shared chat session has ended in a channel.
	*
	* @param broadcaster The broadcaster for whom shared chat session end events should be listened to.
	* @param transport The transport options to use for the subscription.
	*/
	async subscribeToChannelSharedChatSessionEndEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.shared_chat.end", "1", createEventSubBroadcasterCondition(broadcasterId), transport, broadcasterId);
	}
	/**
	* Subscribes to events indicating that bits are used in a channel.
	*
	* @param broadcaster The broadcaster for whom you want to listen to bits usage events.
	* @param transport The transport options to use for the subscription.
	*/
	async subscribeToChannelBitsUseEvents(broadcaster, transport) {
		const broadcasterId = extractUserId(broadcaster);
		return await this.createSubscription("channel.bits.use", "1", createEventSubBroadcasterCondition(broadcasterId), transport, broadcasterId, ["bits:read"]);
	}
	/**
	* Gets the current EventSub conduits for the current client.
	*
	*/
	async getConduits() {
		return (await this._client.callApi({
			type: "helix",
			url: "eventsub/conduits"
		})).data.map((data) => new HelixEventSubConduit(data, this._client));
	}
	/**
	* Creates a new EventSub conduit for the current client.
	*
	* @param shardCount The number of shards to create for this conduit.
	*/
	async createConduit(shardCount) {
		return new HelixEventSubConduit((await this._client.callApi({
			type: "helix",
			url: "eventsub/conduits",
			method: "POST",
			query: { ...createSingleKeyQuery("shard_count", shardCount.toString()) }
		})).data[0], this._client);
	}
	/**
	* Updates an EventSub conduit for the current client.
	*
	* @param id The ID of the conduit to update.
	* @param shardCount The number of shards to update for this conduit.
	*/
	async updateConduit(id, shardCount) {
		return new HelixEventSubConduit((await this._client.callApi({
			type: "helix",
			url: "eventsub/conduits",
			method: "PATCH",
			query: createEventSubConduitUpdateCondition(id, shardCount)
		})).data[0], this._client);
	}
	/**
	* Deletes an EventSub conduit for the current client.
	*
	* @param id The ID of the conduit to delete.
	*/
	async deleteConduit(id) {
		await this._client.callApi({
			type: "helix",
			url: "eventsub/conduits",
			method: "DELETE",
			query: { ...createSingleKeyQuery("id", id) }
		});
	}
	/**
	* Gets the shards of an EventSub conduit for the current client.
	*
	* @param conduitId The ID of the conduit to get shards for.
	* @param status The status of the shards to filter by.
	* @param pagination
	*/
	async getConduitShards(conduitId, status, pagination) {
		return { ...createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "eventsub/conduits/shards",
			query: {
				...createEventSubConduitCondition(conduitId, status),
				...createPaginationQuery(pagination)
			}
		}), HelixEventSubConduitShard, this._client) };
	}
	/**
	* Creates a paginator for the shards of an EventSub conduit for the current client.
	*
	* @param conduitId The ID of the conduit to get shards for.
	* @param status The status of the shards to filter by.
	*/
	getConduitShardsPaginated(conduitId, status) {
		return new HelixPaginatedRequest({
			url: "eventsub/conduits/shards",
			query: createEventSubConduitCondition(conduitId, status)
		}, this._client, (data) => new HelixEventSubConduitShard(data));
	}
	/**
	* Updates shards of an EventSub conduit for the current client.
	*
	* @param conduitId The ID of the conduit to update shards for.
	* @param shards List of shards to update
	*/
	async updateConduitShards(conduitId, shards) {
		return (await this._client.callApi({
			type: "helix",
			url: "eventsub/conduits/shards",
			method: "PATCH",
			jsonBody: createEventSubConduitShardsUpdateCondition(conduitId, shards)
		})).data.map((data) => new HelixEventSubConduitShard(data));
	}
	async _deleteSubscriptionsWithCondition(cond) {
		const subsPaginator = this.getSubscriptionsPaginated();
		for await (const sub of subsPaginator) if (!cond || cond(sub)) await sub.unsubscribe();
	}
};
HelixEventSubApi = __decorate([rtfm("api", "HelixEventSubApi")], HelixEventSubApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/extensions.external.js
/** @internal */
function createReleasedExtensionFilter(extensionId, version) {
	return {
		extension_id: extensionId,
		extension_version: version
	};
}
/** @internal */
function createExtensionProductBody(data) {
	return {
		sku: data.sku,
		cost: {
			amount: data.cost,
			type: "bits"
		},
		display_name: data.displayName,
		in_development: data.inDevelopment,
		expiration: data.expirationDate,
		is_broadcast: data.broadcast
	};
}
/** @internal */
function createExtensionTransactionQuery(extensionId, filter) {
	return {
		extension_id: extensionId,
		id: filter.transactionIds
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/channel/HelixChannelReference.js
/**
* A reference to a Twitch channel.
*/
let HelixChannelReference = class HelixChannelReference extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the channel.
	*/
	get id() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The display name of the channel.
	*/
	get displayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the channel.
	*/
	async getChannel() {
		return checkRelationAssertion(await this._client.channels.getChannelInfoById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* Gets more information about the broadcaster of the channel.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The ID of the game currently played on the channel.
	*/
	get gameId() {
		return this[rawDataSymbol].game_id;
	}
	/**
	* The name of the game currently played on the channel.
	*/
	get gameName() {
		return this[rawDataSymbol].game_name;
	}
	/**
	* Gets information about the game that is being played on the stream.
	*/
	async getGame() {
		return this[rawDataSymbol].game_id ? checkRelationAssertion(await this._client.games.getGameById(this[rawDataSymbol].game_id)) : null;
	}
	/**
	* The title of the channel.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
};
__decorate([Enumerable(false)], HelixChannelReference.prototype, "_client", void 0);
HelixChannelReference = __decorate([rtfm("api", "HelixChannelReference", "id")], HelixChannelReference);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/extensions/HelixExtensionBitsProduct.js
/**
* An extension's product to purchase with Bits.
*/
let HelixExtensionBitsProduct = class HelixExtensionBitsProduct extends DataObject {
	/**
	* The product's unique identifier.
	*/
	get sku() {
		return this[rawDataSymbol].sku;
	}
	/**
	* The product's cost, in bits.
	*/
	get cost() {
		return this[rawDataSymbol].cost.amount;
	}
	/**
	* The product's display name.
	*/
	get displayName() {
		return this[rawDataSymbol].display_name;
	}
	/**
	* Whether the product is in development.
	*/
	get inDevelopment() {
		return this[rawDataSymbol].in_development;
	}
	/**
	* Whether the product's purchases is broadcast to all users.
	*/
	get isBroadcast() {
		return this[rawDataSymbol].is_broadcast;
	}
	/**
	* The product's expiration date. If the product never expires, this is null.
	*/
	get expirationDate() {
		return mapNullable(this[rawDataSymbol].expiration, (exp) => new Date(exp));
	}
};
HelixExtensionBitsProduct = __decorate([rtfm("api", "HelixExtensionBitsProduct", "sku")], HelixExtensionBitsProduct);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/extensions/HelixExtensionTransaction.js
/**
* A bits transaction made inside an extension.
*/
let HelixExtensionTransaction = class HelixExtensionTransaction extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the transaction.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The time when the transaction was made.
	*/
	get transactionDate() {
		return new Date(this[rawDataSymbol].timestamp);
	}
	/**
	* The ID of the broadcaster that runs the extension on their channel.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster that runs the extension on their channel.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* The display name of the broadcaster that runs the extension on their channel.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets information about the broadcaster that runs the extension on their channel.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The ID of the user that made the transaction.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the user that made the transaction.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user that made the transaction.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets information about the user that made the transaction.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* The product type. Currently always BITS_IN_EXTENSION.
	*/
	get productType() {
		return this[rawDataSymbol].product_type;
	}
	/**
	* The product SKU.
	*/
	get productSku() {
		return this[rawDataSymbol].product_data.sku;
	}
	/**
	* The cost of the product, in bits.
	*/
	get productCost() {
		return this[rawDataSymbol].product_data.cost.amount;
	}
	/**
	* The display name of the product.
	*/
	get productDisplayName() {
		return this[rawDataSymbol].product_data.displayName;
	}
	/**
	* Whether the product is in development.
	*/
	get productInDevelopment() {
		return this[rawDataSymbol].product_data.inDevelopment;
	}
};
__decorate([Enumerable(false)], HelixExtensionTransaction.prototype, "_client", void 0);
HelixExtensionTransaction = __decorate([rtfm("api", "HelixExtensionTransaction", "id")], HelixExtensionTransaction);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/extensions/HelixExtensionsApi.js
/**
* The Helix API methods that deal with extensions.
*
* Can be accessed using `client.extensions` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const transactions = await api.extionsions.getExtensionTransactions('abcd');
* ```
*
* @meta category helix
* @meta categorizedTitle Extensions
*/
let HelixExtensionsApi = class HelixExtensionsApi extends BaseApi {
	/**
	* Gets a released extension by ID.
	*
	* @param extensionId The ID of the extension.
	* @param version The version of the extension. If not given, gets the latest version.
	*/
	async getReleasedExtension(extensionId, version) {
		return new HelixExtension((await this._client.callApi({
			type: "helix",
			url: "extensions/released",
			query: createReleasedExtensionFilter(extensionId, version)
		})).data[0]);
	}
	/**
	* Gets a list of channels that are currently live and have the given extension installed.
	*
	* @param extensionId The ID of the extension.
	* @param pagination
	*
	* @expandParams
	*/
	async getLiveChannelsWithExtension(extensionId, pagination) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "extensions/live",
			query: {
				...createSingleKeyQuery("extension_id", extensionId),
				...createPaginationQuery(pagination)
			}
		}), HelixChannelReference, this._client);
	}
	/**
	* Creates a paginator for channels that are currently live and have the given extension installed.
	*
	* @param extensionId The ID of the extension.
	*/
	getLiveChannelsWithExtensionPaginated(extensionId) {
		return new HelixPaginatedRequest({
			url: "extensions/live",
			query: createSingleKeyQuery("extension_id", extensionId)
		}, this._client, (data) => new HelixChannelReference(data, this._client));
	}
	/**
	* Gets an extension's Bits products.
	*
	* This only works if the provided token belongs to an extension's client ID,
	* and will return the products for that extension.
	*
	* @param includeDisabled Whether to include disabled/expired products.
	*/
	async getExtensionBitsProducts(includeDisabled) {
		return (await this._client.callApi({
			type: "helix",
			url: "bits/extensions",
			forceType: "app",
			query: createSingleKeyQuery("should_include_all", includeDisabled?.toString())
		})).data.map((data) => new HelixExtensionBitsProduct(data));
	}
	/**
	* Creates or updates a Bits product of an extension.
	*
	* This only works if the provided token belongs to an extension's client ID,
	* and will create/update a product for that extension.
	*
	* @param data
	*
	* @expandParams
	*/
	async putExtensionBitsProduct(data) {
		return new HelixExtensionBitsProduct((await this._client.callApi({
			type: "helix",
			url: "bits/extensions",
			method: "PUT",
			forceType: "app",
			jsonBody: createExtensionProductBody(data)
		})).data[0]);
	}
	/**
	* Gets a list of transactions for the given extension.
	*
	* @param extensionId The ID of the extension to get transactions for.
	* @param filter Additional filters.
	*/
	async getExtensionTransactions(extensionId, filter = {}) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "extensions/transactions",
			forceType: "app",
			query: {
				...createExtensionTransactionQuery(extensionId, filter),
				...createPaginationQuery(filter)
			}
		}), HelixExtensionTransaction, this._client);
	}
	/**
	* Creates a paginator for transactions for the given extension.
	*
	* @param extensionId The ID of the extension to get transactions for.
	* @param filter Additional filters.
	*/
	getExtensionTransactionsPaginated(extensionId, filter = {}) {
		return new HelixPaginatedRequest({
			url: "extensions/transactions",
			forceType: "app",
			query: createExtensionTransactionQuery(extensionId, filter)
		}, this._client, (data) => new HelixExtensionTransaction(data, this._client));
	}
};
HelixExtensionsApi = __decorate([rtfm("api", "HelixExtensionsApi")], HelixExtensionsApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/game/HelixGame.js
/**
* A game as displayed on Twitch.
*/
let HelixGame = class HelixGame extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the game.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The name of the game.
	*/
	get name() {
		return this[rawDataSymbol].name;
	}
	/**
	* The URL of the box art of the game.
	*/
	get boxArtUrl() {
		return this[rawDataSymbol].box_art_url;
	}
	/**
	* The IGDB ID of the game, or null if the game doesn't have an IGDB ID assigned at Twitch.
	*/
	get igdbId() {
		return this[rawDataSymbol].igdb_id || null;
	}
	/**
	* Builds the URL of the box art of the game using the given dimensions.
	*
	* @param width The width of the box art.
	* @param height The height of the box art.
	*/
	getBoxArtUrl(width, height) {
		return this[rawDataSymbol].box_art_url.replace("{width}", width.toString()).replace("{height}", height.toString());
	}
	/**
	* Gets streams that are currently playing the game.
	*
	* @param pagination
	* @expandParams
	*/
	async getStreams(pagination) {
		return await this._client.streams.getStreams({
			...pagination,
			game: this[rawDataSymbol].id
		});
	}
	/**
	* Creates a paginator for streams that are currently playing the game.
	*/
	getStreamsPaginated() {
		return this._client.streams.getStreamsPaginated({ game: this[rawDataSymbol].id });
	}
};
__decorate([Enumerable(false)], HelixGame.prototype, "_client", void 0);
HelixGame = __decorate([rtfm("api", "HelixGame", "id")], HelixGame);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/game/HelixGameApi.js
/**
* The Helix API methods that deal with games.
*
* Can be accessed using `client.games` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const game = await api.games.getGameByName('Hearthstone');
* ```
*
* @meta category helix
* @meta categorizedTitle Games
*/
let HelixGameApi = class HelixGameApi extends BaseApi {
	/** @internal */
	_getGameByIdBatcher = new HelixRequestBatcher({ url: "games" }, "id", "id", this._client, (data) => new HelixGame(data, this._client));
	/** @internal */
	_getGameByNameBatcher = new HelixRequestBatcher({ url: "games" }, "name", "name", this._client, (data) => new HelixGame(data, this._client));
	/** @internal */
	_getGameByIgdbIdBatcher = new HelixRequestBatcher({ url: "games" }, "igdb_id", "igdb_id", this._client, (data) => new HelixGame(data, this._client));
	/**
	* Gets the game data for the given list of game IDs.
	*
	* @param ids The game IDs you want to look up.
	*/
	async getGamesByIds(ids) {
		return await this._getGames("id", ids);
	}
	/**
	* Gets the game data for the given list of game names.
	*
	* @param names The game names you want to look up.
	*/
	async getGamesByNames(names) {
		return await this._getGames("name", names);
	}
	/**
	* Gets the game data for the given list of IGDB IDs.
	*
	* @param igdbIds The IGDB IDs you want to look up.
	*/
	async getGamesByIgdbIds(igdbIds) {
		return await this._getGames("igdb_id", igdbIds);
	}
	/**
	* Gets the game data for the given game ID.
	*
	* @param id The game ID you want to look up.
	*/
	async getGameById(id) {
		return (await this._getGames("id", [id]))[0] ?? null;
	}
	/**
	* Gets the game data for the given game name.
	*
	* @param name The game name you want to look up.
	*/
	async getGameByName(name) {
		return (await this._getGames("name", [name]))[0] ?? null;
	}
	/**
	* Gets the game data for the given IGDB ID.
	*
	* @param igdbId The IGDB ID you want to look up.
	*/
	async getGameByIgdbId(igdbId) {
		return (await this._getGames("igdb_id", [igdbId]))[0] ?? null;
	}
	/**
	* Gets the game data for the given game ID, batching multiple calls into fewer requests as the API allows.
	*
	* @param id The game ID you want to look up.
	*/
	async getGameByIdBatched(id) {
		return await this._getGameByIdBatcher.request(id);
	}
	/**
	* Gets the game data for the given game name, batching multiple calls into fewer requests as the API allows.
	*
	* @param name The game name you want to look up.
	*/
	async getGameByNameBatched(name) {
		return await this._getGameByNameBatcher.request(name);
	}
	/**
	* Gets the game data for the given IGDB ID, batching multiple calls into fewer requests as the API allows.
	*
	* @param igdbId The IGDB ID you want to look up.
	*/
	async getGameByIgdbIdBatched(igdbId) {
		return await this._getGameByIgdbIdBatcher.request(igdbId);
	}
	/**
	* Gets a list of the most viewed games at the moment.
	*
	* @param pagination
	*
	* @expandParams
	*/
	async getTopGames(pagination) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "games/top",
			query: createPaginationQuery(pagination)
		}), HelixGame, this._client);
	}
	/**
	* Creates a paginator for the most viewed games at the moment.
	*/
	getTopGamesPaginated() {
		return new HelixPaginatedRequest({ url: "games/top" }, this._client, (data) => new HelixGame(data, this._client));
	}
	/** @internal */
	async _getGames(filterType, filterValues) {
		if (!filterValues.length) return [];
		return (await this._client.callApi({
			type: "helix",
			url: "games",
			query: { [filterType]: filterValues }
		})).data.map((entry) => new HelixGame(entry, this._client));
	}
};
__decorate([Enumerable(false)], HelixGameApi.prototype, "_getGameByIdBatcher", void 0);
__decorate([Enumerable(false)], HelixGameApi.prototype, "_getGameByNameBatcher", void 0);
__decorate([Enumerable(false)], HelixGameApi.prototype, "_getGameByIgdbIdBatcher", void 0);
HelixGameApi = __decorate([rtfm("api", "HelixGameApi")], HelixGameApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/goals/HelixGoal.js
/**
* A creator goal.
*/
let HelixGoal = class HelixGoal extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the goal.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The ID of the broadcaster the goal belongs to.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The display name of the broadcaster the goal belongs to.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* The name of the broadcaster the goal belongs to.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* Gets more information about the broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The type of the goal.
	*/
	get type() {
		return this[rawDataSymbol].type;
	}
	/**
	* The description of the goal.
	*/
	get description() {
		return this[rawDataSymbol].description;
	}
	/**
	* The current value of the goal.
	*/
	get currentAmount() {
		return this[rawDataSymbol].current_amount;
	}
	/**
	* The target value of the goal.
	*/
	get targetAmount() {
		return this[rawDataSymbol].target_amount;
	}
	/**
	* The date and time when the goal was created.
	*/
	get creationDate() {
		return this[rawDataSymbol].created_at;
	}
};
__decorate([Enumerable(false)], HelixGoal.prototype, "_client", void 0);
HelixGoal = __decorate([rtfm("api", "HelixGoal", "id")], HelixGoal);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/goals/HelixGoalApi.js
/**
* The Helix API methods that deal with creator goals.
*
* Can be accessed using `client.goals` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const { data: goals } = await api.helix.goals.getGoals('61369223');
*
* @meta category helix
* @meta categorizedTitle Goals
*/
let HelixGoalApi = class HelixGoalApi extends BaseApi {
	async getGoals(broadcaster) {
		return (await this._client.callApi({
			type: "helix",
			url: "goals",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:goals"],
			query: createBroadcasterQuery(broadcaster)
		})).data.map((data) => new HelixGoal(data, this._client));
	}
};
HelixGoalApi = __decorate([rtfm("api", "HelixGoalApi")], HelixGoalApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/hypeTrain/HelixHypeTrainContribution.js
/**
* A Hype Train contributor.
*/
let HelixHypeTrainContribution = class HelixHypeTrainContribution extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the user contributing to the Hype Train.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the user contributing to the Hype Train.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user contributing to the Hype Train.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets additional information about the user contributing to the Hype Train.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* The type of the Hype Train contribution.
	*/
	get type() {
		return this[rawDataSymbol].type;
	}
	/**
	* The total contribution amount in subs or bits.
	*/
	get total() {
		return this[rawDataSymbol].total;
	}
};
__decorate([Enumerable(false)], HelixHypeTrainContribution.prototype, "_client", void 0);
HelixHypeTrainContribution = __decorate([rtfm("api", "HelixHypeTrainContribution", "userId")], HelixHypeTrainContribution);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/hypeTrain/HelixHypeTrain.js
/**
* Data about the currently running Hype Train.
*/
let HelixHypeTrain = class HelixHypeTrain extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The unique ID of the Hype Train event.
	*/
	get eventId() {
		return this[rawDataSymbol].id;
	}
	/**
	* The unique ID of the Hype Train.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The user ID of the broadcaster where the Hype Train is happening.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_user_id;
	}
	/**
	* The name of the broadcaster where the Hype Train is happening.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_user_login;
	}
	/**
	* The display name of the broadcaster where the Hype Train is happening.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_user_name;
	}
	/**
	* Gets more information about the broadcaster where the Hype Train is happening.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_user_id));
	}
	/**
	* The level of the Hype Train.
	*/
	get level() {
		return this[rawDataSymbol].level;
	}
	/**
	* The total amount of progress points of the Hype Train.
	*/
	get total() {
		return this[rawDataSymbol].total;
	}
	/**
	* The amount progress points for the current level of the Hype Train.
	*/
	get progress() {
		return this[rawDataSymbol].progress;
	}
	/**
	* The progress points goal to reach the next Hype Train level.
	*/
	get goal() {
		return this[rawDataSymbol].goal;
	}
	/**
	* Array list of the top contributions to the Hype Train event for bits and subs.
	*/
	get topContributions() {
		return this[rawDataSymbol].top_contributions.map((cont) => new HelixHypeTrainContribution(cont, this._client));
	}
	/**
	* The time when the Hype Train started.
	*/
	get startDate() {
		return new Date(this[rawDataSymbol].started_at);
	}
	/**
	* The time when the Hype Train is set to expire.
	*/
	get expiryDate() {
		return new Date(this[rawDataSymbol].expires_at);
	}
	/**
	* The type of the Hype Train.
	*/
	get type() {
		return this[rawDataSymbol].type;
	}
	/**
	* Whether the Hype Train is a shared train.
	*/
	get isSharedTrain() {
		return this[rawDataSymbol].is_shared_train;
	}
};
__decorate([Enumerable(false)], HelixHypeTrain.prototype, "_client", void 0);
HelixHypeTrain = __decorate([rtfm("api", "HelixHypeTrain", "id")], HelixHypeTrain);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/hypeTrain/HelixHypeTrainAllTimeHigh.js
/**
* All-time-high Hype Train statistics.
*/
let HelixHypeTrainAllTimeHigh = class HelixHypeTrainAllTimeHigh extends DataObject {
	/**
	* The level reached by the all-time-high Hype Train.
	*/
	get level() {
		return this[rawDataSymbol].level;
	}
	/**
	* The total amount of contribution points reached by the all-time-high Hype Train.
	*/
	get total() {
		return this[rawDataSymbol].total;
	}
	/**
	* The time when the all-time-high Hype Train was achieved.
	*/
	get achievementDate() {
		return new Date(this[rawDataSymbol].achieved_at);
	}
};
HelixHypeTrainAllTimeHigh = __decorate([rtfm("api", "HelixHypeTrainAllTimeHigh")], HelixHypeTrainAllTimeHigh);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/hypeTrain/HelixHypeTrainStatus.js
/**
* Statistics of Hype Trains on a channel.
*/
let HelixHypeTrainStatus = class HelixHypeTrainStatus extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The current Hype Train, or null if there is no ongoing Hype Train.
	*/
	get current() {
		return mapNullable(this[rawDataSymbol].current, (data) => new HelixHypeTrain(data, this._client));
	}
	/**
	* The all-time-high Hype Train statistics for this channel, or null if there was no Hype Train yet.
	*/
	get allTimeHigh() {
		return mapNullable(this[rawDataSymbol].all_time_high, (data) => new HelixHypeTrainAllTimeHigh(data));
	}
	/**
	* The all-time-high shared Hype Train statistics for this channel, or null if there was no shared Hype Train yet.
	*/
	get sharedAllTimeHigh() {
		return mapNullable(this[rawDataSymbol].shared_all_time_high, (data) => new HelixHypeTrainAllTimeHigh(data));
	}
};
__decorate([Enumerable(false)], HelixHypeTrainStatus.prototype, "_client", void 0);
HelixHypeTrainStatus = __decorate([rtfm("api", "HelixHypeTrainStatus")], HelixHypeTrainStatus);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/hypeTrain/HelixHypeTrainApi.js
/**
* The Helix API methods that deal with Hype Trains.
*
* Can be accessed using `client.hypeTrain` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const hypeTrainStatus = await api.hypeTrain.getHypeTrainStatusForBroadcaster('125328655');
* ```
*
* @meta category helix
* @meta categorizedTitle Hype Trains
*/
var HelixHypeTrainApi = class extends BaseApi {
	/**
	* Gets the Hype Train status and statistics for the specified broadcaster.
	*
	* @param broadcaster The broadcaster to fetch Hype Train info for.
	*/
	async getHypeTrainStatusForBroadcaster(broadcaster) {
		return new HelixHypeTrainStatus((await this._client.callApi({
			type: "helix",
			url: "hypetrain/status",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:hype_train"],
			query: { ...createBroadcasterQuery(broadcaster) }
		})).data[0], this._client);
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/moderation.external.js
/** @internal */
function createModerationUserListQuery(channel, filter) {
	return {
		broadcaster_id: extractUserId(channel),
		user_id: filter?.userId
	};
}
/** @internal */
function createModeratorModifyQuery(broadcaster, user) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		user_id: extractUserId(user)
	};
}
/** @internal */
function createResolveUnbanRequestQuery(broadcaster, moderator, unbanRequestId, approved, resolutionMessage) {
	return {
		unban_request_id: unbanRequestId,
		broadcaster_id: extractUserId(broadcaster),
		moderator_id: extractUserId(moderator),
		status: approved ? "approved" : "denied",
		resolution_text: resolutionMessage
	};
}
/** @internal */
function createAutoModProcessBody(user, msgId, allow) {
	return {
		user_id: extractUserId(user),
		msg_id: msgId,
		action: allow ? "ALLOW" : "DENY"
	};
}
/** @internal */
function createAutoModSettingsBody(data) {
	return {
		overall_level: data.overallLevel,
		aggression: data.aggression,
		bullying: data.bullying,
		disability: data.disability,
		misogyny: data.misogyny,
		race_ethnicity_or_religion: data.raceEthnicityOrReligion,
		sex_based_terms: data.sexBasedTerms,
		sexuality_sex_or_gender: data.sexualitySexOrGender,
		swearing: data.swearing
	};
}
/** @internal */
function createBanUserBody(data) {
	return { data: {
		duration: data.duration,
		reason: data.reason,
		user_id: extractUserId(data.user)
	} };
}
/** @internal */
function createUpdateShieldModeStatusBody(activate) {
	return { is_active: activate };
}
/** @internal */
function createCheckAutoModStatusBody(data) {
	return { data: data.map((entry) => ({
		msg_id: entry.messageId,
		msg_text: entry.messageText
	})) };
}
/** @internal */
function createWarnUserBody(user, reason) {
	return { data: {
		user_id: extractUserId(user),
		reason
	} };
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixAutoModSettings.js
/**
* The AutoMod settings of a channel.
*/
let HelixAutoModSettings = class HelixAutoModSettings extends DataObject {
	/**
	* The ID of the broadcaster for which the AutoMod settings were fetched.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The ID of a user that has permission to moderate the broadcaster's chat room.
	*/
	get moderatorId() {
		return this[rawDataSymbol].moderator_id;
	}
	/**
	* The default AutoMod level for the broadcaster. This is null if the broadcaster changed individual settings.
	*/
	get overallLevel() {
		return this[rawDataSymbol].overall_level ? this[rawDataSymbol].overall_level : null;
	}
	/**
	* The AutoMod level for discrimination against disability.
	*/
	get disability() {
		return this[rawDataSymbol].disability;
	}
	/**
	* The AutoMod level for hostility involving aggression.
	*/
	get aggression() {
		return this[rawDataSymbol].aggression;
	}
	/**
	* The AutoMod level for discrimination based on sexuality, sex, or gender.
	*/
	get sexualitySexOrGender() {
		return this[rawDataSymbol].sexuality_sex_or_gender;
	}
	/**
	* The AutoMod level for discrimination against women.
	*/
	get misogyny() {
		return this[rawDataSymbol].misogyny;
	}
	/**
	* The AutoMod level for hostility involving name calling or insults.
	*/
	get bullying() {
		return this[rawDataSymbol].bullying;
	}
	/**
	* The AutoMod level for profanity.
	*/
	get swearing() {
		return this[rawDataSymbol].swearing;
	}
	/**
	* The AutoMod level for racial discrimination.
	*/
	get raceEthnicityOrReligion() {
		return this[rawDataSymbol].race_ethnicity_or_religion;
	}
	/**
	* The AutoMod level for sexual content.
	*/
	get sexBasedTerms() {
		return this[rawDataSymbol].sex_based_terms;
	}
};
HelixAutoModSettings = __decorate([rtfm("api", "HelixAutoModSettings", "broadcasterId")], HelixAutoModSettings);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixAutoModStatus.js
/**
* The status of a message that says whether it is permitted by AutoMod or not.
*/
let HelixAutoModStatus = class HelixAutoModStatus extends DataObject {
	/**
	* The developer-generated ID that was sent with the request data.
	*/
	get messageId() {
		return this[rawDataSymbol].msg_id;
	}
	/**
	* Whether the message is permitted by AutoMod or not.
	*/
	get isPermitted() {
		return this[rawDataSymbol].is_permitted;
	}
};
HelixAutoModStatus = __decorate([rtfm("api", "HelixAutoModStatus", "messageId")], HelixAutoModStatus);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixBanUser.js
/**
* Information about a user who has been banned/timed out.
*
* @hideProtected
*/
let HelixBanUser = class HelixBanUser extends DataObject {
	/** @internal */ _client;
	/** @internal */ _expiryTimestamp;
	/** @internal */
	constructor(data, expiryTimestamp, client) {
		super(data);
		this._expiryTimestamp = expiryTimestamp;
		this._client = client;
	}
	/**
	* The date and time that the ban/timeout was created.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* The date and time that the timeout will end. Is `null` if the user was banned instead of put in a timeout.
	*/
	get expiryDate() {
		return mapNullable(this._expiryTimestamp, (ts) => new Date(ts));
	}
	/**
	* The ID of the moderator that banned or put the user in the timeout.
	*/
	get moderatorId() {
		return this[rawDataSymbol].moderator_id;
	}
	/**
	* Gets more information about the moderator that banned or put the user in the timeout.
	*/
	async getModerator() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].moderator_id));
	}
	/**
	* The ID of the user that was banned or put in a timeout.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* Gets more information about the user that was banned or put in a timeout.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
};
__decorate([Enumerable(false)], HelixBanUser.prototype, "_client", void 0);
__decorate([Enumerable(false)], HelixBanUser.prototype, "_expiryTimestamp", void 0);
HelixBanUser = __decorate([rtfm("api", "HelixBanUser", "userId")], HelixBanUser);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixBan.js
/**
* Information about the ban of a user.
*
* @inheritDoc
*/
let HelixBan = class HelixBan extends HelixBanUser {
	/** @internal */
	constructor(data, client) {
		super(data, data.expires_at || null, client);
	}
	/**
	* The name of the user that was banned or put in a timeout.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user that was banned or put in a timeout.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* The name of the moderator that banned or put the user in the timeout.
	*/
	get moderatorName() {
		return this[rawDataSymbol].moderator_login;
	}
	/**
	* The display name of the moderator that banned or put the user in the timeout.
	*/
	get moderatorDisplayName() {
		return this[rawDataSymbol].moderator_name;
	}
	/**
	* The reason why the user was banned or timed out. Returns `null` if no reason was given.
	*/
	get reason() {
		return this[rawDataSymbol].reason || null;
	}
};
HelixBan = __decorate([rtfm("api", "HelixBan", "userId")], HelixBan);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixBlockedTerm.js
/**
* Information about a word or phrase blocked in a broadcaster's channel.
*/
let HelixBlockedTerm = class HelixBlockedTerm extends DataObject {
	/**
	* The ID of the broadcaster that owns the list of blocked terms.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The date and time of when the term was blocked.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* The date and time of when the blocked term is set to expire. After the block expires, users will be able to use the term in the broadcaster’s chat room.
	* Is `null` if the term was added manually or permanently blocked by AutoMod.
	*/
	get expirationDate() {
		return this[rawDataSymbol].expires_at ? new Date(this[rawDataSymbol].expires_at) : null;
	}
	/**
	* An ID that uniquely identifies this blocked term.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The ID of the moderator that blocked the word or phrase from being used in the broadcaster’s chat room.
	*/
	get moderatorId() {
		return this[rawDataSymbol].moderator_id;
	}
	/**
	* The blocked word or phrase.
	*/
	get text() {
		return this[rawDataSymbol].text;
	}
	/**
	* The date and time of when the term was updated.
	*/
	get updatedDate() {
		return new Date(this[rawDataSymbol].updated_at);
	}
};
HelixBlockedTerm = __decorate([rtfm("api", "HelixBlockedTerm", "id")], HelixBlockedTerm);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixModeratedChannel.js
/**
* A reference to a Twitch channel where a user is a moderator.
*/
let HelixModeratedChannel = class HelixModeratedChannel extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the channel.
	*/
	get id() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the channel.
	*/
	get name() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the channel.
	*/
	get displayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the channel.
	*/
	async getChannel() {
		return checkRelationAssertion(await this._client.channels.getChannelInfoById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* Gets more information about the broadcaster of the channel.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
};
__decorate([Enumerable(false)], HelixModeratedChannel.prototype, "_client", void 0);
HelixModeratedChannel = __decorate([rtfm("api", "HelixModeratedChannel", "id")], HelixModeratedChannel);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixModerator.js
/**
* Information about the moderator status of a user.
*/
let HelixModerator = class HelixModerator extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the user.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the user.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets more information about the user.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
};
__decorate([Enumerable(false)], HelixModerator.prototype, "_client", void 0);
HelixModerator = __decorate([rtfm("api", "HelixModerator", "userId")], HelixModerator);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixShieldModeStatus.js
/**
* Information about the Shield Mode status of a channel.
*/
let HelixShieldModeStatus = class HelixShieldModeStatus extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* Whether Shield Mode is active.
	*/
	get isActive() {
		return this[rawDataSymbol].is_active;
	}
	/**
	* The ID of the moderator that last activated Shield Mode.
	*/
	get moderatorId() {
		return this[rawDataSymbol].moderator_id;
	}
	/**
	* The name of the moderator that last activated Shield Mode.
	*/
	get moderatorName() {
		return this[rawDataSymbol].moderator_login;
	}
	/**
	* The display name of the moderator that last activated Shield Mode.
	*/
	get moderatorDisplayName() {
		return this[rawDataSymbol].moderator_name;
	}
	/**
	* Gets more information about the moderator that last activated Shield Mode.
	*/
	async getModerator() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].moderator_id));
	}
	/**
	* The date when Shield Mode was last activated. `null` indicates Shield Mode hasn't been previously activated.
	*/
	get lastActivationDate() {
		return this[rawDataSymbol].last_activated_at === "" ? null : new Date(this[rawDataSymbol].last_activated_at);
	}
};
__decorate([Enumerable(false)], HelixShieldModeStatus.prototype, "_client", void 0);
HelixShieldModeStatus = __decorate([rtfm("api", "HelixShieldModeStatus")], HelixShieldModeStatus);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixUnbanRequest.js
/**
* A request from a user to be unbanned from a channel.
*/
let HelixUnbanRequest = class HelixUnbanRequest extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* Unban request ID.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The ID of the broadcaster whose channel is receiving the unban request.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster whose channel is receiving the unban request.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The display name of the broadcaster whose channel is receiving the unban request.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* Gets more information about the broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The ID of the moderator who resolved the unban request.
	*
	* Can be `null` if the request is not resolved.
	*/
	get moderatorId() {
		return this[rawDataSymbol].moderator_id;
	}
	/**
	* The name of the moderator who resolved the unban request.
	*
	* Can be `null` if the request is not resolved.
	*/
	get moderatorName() {
		return this[rawDataSymbol].moderator_login;
	}
	/**
	* The display name of the moderator who resolved the unban request.
	*
	* Can be `null` if the request is not resolved.
	*/
	get moderatorDisplayName() {
		return this[rawDataSymbol].moderator_name;
	}
	/**
	* Gets more information about the moderator.
	*/
	async getModerator() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].moderator_id));
	}
	/**
	* The ID of the user who requested to be unbanned.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the user who requested to be unbanned.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user who requested to be unbanned.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets more information about the user.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* Text message of the unban request from the requesting user.
	*/
	get message() {
		return this[rawDataSymbol].text;
	}
	/**
	* The date of when the unban request was created.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* The message written by the moderator who resolved the unban request, or `null` if it has not been resolved yet.
	*/
	get resolutionMessage() {
		return this[rawDataSymbol].resolution_text || null;
	}
	/**
	* The date when the unban request was resolved, or `null` if it has not been resolved yet.
	*/
	get resolutionDate() {
		return mapNullable(this[rawDataSymbol].resolved_at, (val) => new Date(val));
	}
};
__decorate([Enumerable(false)], HelixUnbanRequest.prototype, "_client", void 0);
HelixUnbanRequest = __decorate([rtfm("api", "HelixUnbanRequest", "id")], HelixUnbanRequest);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixWarning.js
/**
* Information about the warning.
*/
let HelixWarning = class HelixWarning extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the channel in which the warning will take effect.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* Gets more information about the broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The ID of the user who applied the warning.
	*/
	get moderatorId() {
		return this[rawDataSymbol].moderator_id;
	}
	/**
	* Gets more information about the moderator.
	*/
	async getModerator() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].moderator_id));
	}
	/**
	* The ID of the warned user.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* Gets more information about the user.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* The reason provided for the warning.
	*/
	get reason() {
		return this[rawDataSymbol].reason;
	}
};
__decorate([Enumerable(false)], HelixWarning.prototype, "_client", void 0);
HelixWarning = __decorate([rtfm("api", "HelixWarning", "userId")], HelixWarning);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/moderation/HelixModerationApi.js
/**
* The Helix API methods that deal with moderation.
*
* Can be accessed using `client.moderation` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const { data: users } = await api.moderation.getBannedUsers('61369223');
* ```
*
* @meta category helix
* @meta categorizedTitle Moderation
*/
let HelixModerationApi = class HelixModerationApi extends BaseApi {
	/**
	* Gets a list of banned users in a given channel.
	*
	* @param channel The channel to get the banned users from.
	* @param filter Additional filters for the result set.
	*
	* @expandParams
	*/
	async getBannedUsers(channel, filter) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "moderation/banned",
			userId: extractUserId(channel),
			scopes: ["moderation:read"],
			query: {
				...createModerationUserListQuery(channel, filter),
				...createPaginationQuery(filter)
			}
		}), HelixBan, this._client);
	}
	/**
	* Creates a paginator for banned users in a given channel.
	*
	* @param channel The channel to get the banned users from.
	*/
	getBannedUsersPaginated(channel) {
		return new HelixPaginatedRequest({
			url: "moderation/banned",
			userId: extractUserId(channel),
			scopes: ["moderation:read"],
			query: createBroadcasterQuery(channel)
		}, this._client, (data) => new HelixBan(data, this._client), 50);
	}
	/**
	* Checks whether a given user is banned in a given channel.
	*
	* @param channel The channel to check for a ban of the given user.
	* @param user The user to check for a ban in the given channel.
	*/
	async checkUserBan(channel, user) {
		const userId = extractUserId(user);
		return (await this.getBannedUsers(channel, { userId })).data.some((ban) => ban.userId === userId);
	}
	/**
	* Gets a list of moderators in a given channel.
	*
	* @param channel The channel to get moderators from.
	* @param filter Additional filters for the result set.
	*
	* @expandParams
	*/
	async getModerators(channel, filter) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "moderation/moderators",
			userId: extractUserId(channel),
			scopes: ["moderation:read", "channel:manage:moderators"],
			query: {
				...createModerationUserListQuery(channel, filter),
				...createPaginationQuery(filter)
			}
		}), HelixModerator, this._client);
	}
	/**
	* Creates a paginator for moderators in a given channel.
	*
	* @param channel The channel to get moderators from.
	*/
	getModeratorsPaginated(channel) {
		return new HelixPaginatedRequest({
			url: "moderation/moderators",
			userId: extractUserId(channel),
			scopes: ["moderation:read", "channel:manage:moderators"],
			query: createBroadcasterQuery(channel)
		}, this._client, (data) => new HelixModerator(data, this._client));
	}
	/**
	* Gets a list of channels where the specified user has moderator privileges.
	*
	* @param user The user for whom to return a list of channels where they have moderator privileges.
	* This ID must match the user ID in the access token.
	* @param filter
	*
	* @expandParams
	*
	* @returns A paginated list of channels where the user has moderator privileges.
	*/
	async getModeratedChannels(user, filter) {
		const userId = extractUserId(user);
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "moderation/channels",
			userId,
			scopes: ["user:read:moderated_channels"],
			query: {
				...createSingleKeyQuery("user_id", userId),
				...createPaginationQuery(filter)
			}
		}), HelixModeratedChannel, this._client);
	}
	/**
	* Creates a paginator for channels where the specified user has moderator privileges.
	*
	* @param user The user for whom to return the list of channels where they have moderator privileges.
	* This ID must match the user ID in the access token.
	*/
	getModeratedChannelsPaginated(user) {
		const userId = extractUserId(user);
		return new HelixPaginatedRequest({
			url: "moderation/channels",
			userId,
			scopes: ["user:read:moderated_channels"],
			query: createSingleKeyQuery("user_id", userId)
		}, this._client, (data) => new HelixModeratedChannel(data, this._client));
	}
	/**
	* Checks whether a given user is a moderator of a given channel.
	*
	* @param channel The channel to check.
	* @param user The user to check.
	*/
	async checkUserMod(channel, user) {
		const userId = extractUserId(user);
		return (await this.getModerators(channel, { userId })).data.some((mod) => mod.userId === userId);
	}
	/**
	* Adds a moderator to the broadcaster’s chat room.
	*
	* @param broadcaster The broadcaster that owns the chat room. This ID must match the user ID in the access token.
	* @param user The user to add as a moderator in the broadcaster’s chat room.
	*/
	async addModerator(broadcaster, user) {
		await this._client.callApi({
			type: "helix",
			url: "moderation/moderators",
			method: "POST",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:moderators"],
			query: createModeratorModifyQuery(broadcaster, user)
		});
	}
	/**
	* Removes a moderator from the broadcaster’s chat room.
	*
	* @param broadcaster The broadcaster that owns the chat room. This ID must match the user ID in the access token.
	* @param user The user to remove as a moderator from the broadcaster’s chat room.
	*/
	async removeModerator(broadcaster, user) {
		await this._client.callApi({
			type: "helix",
			url: "moderation/moderators",
			method: "DELETE",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:moderators"],
			query: createModeratorModifyQuery(broadcaster, user)
		});
	}
	/**
	* Determines whether a string message meets the channel's AutoMod requirements.
	*
	* @param channel The channel in which the messages to check are posted.
	* @param data An array of message data objects.
	*/
	async checkAutoModStatus(channel, data) {
		return (await this._client.callApi({
			type: "helix",
			url: "moderation/enforcements/status",
			method: "POST",
			userId: extractUserId(channel),
			scopes: ["moderation:read"],
			query: createBroadcasterQuery(channel),
			jsonBody: createCheckAutoModStatusBody(data)
		})).data.map((statusData) => new HelixAutoModStatus(statusData));
	}
	/**
	* Processes a message held by AutoMod.
	*
	* @param user The user who is processing the message.
	* @param msgId The ID of the message.
	* @param allow Whether to allow the message - `true` allows, and `false` denies.
	*/
	async processHeldAutoModMessage(user, msgId, allow) {
		await this._client.callApi({
			type: "helix",
			url: "moderation/automod/message",
			method: "POST",
			userId: extractUserId(user),
			scopes: ["moderator:manage:automod"],
			jsonBody: createAutoModProcessBody(user, msgId, allow)
		});
	}
	/**
	* Gets the AutoMod settings for a broadcaster.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster to get the AutoMod settings for.
	*/
	async getAutoModSettings(broadcaster) {
		const broadcasterId = extractUserId(broadcaster);
		return (await this._client.callApi({
			type: "helix",
			url: "moderation/automod/settings",
			userId: broadcasterId,
			scopes: ["moderator:read:automod_settings"],
			canOverrideScopedUserContext: true,
			query: this._createModeratorActionQuery(broadcasterId)
		})).data.map((data) => new HelixAutoModSettings(data));
	}
	/**
	* Updates the AutoMod settings for a broadcaster.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster for which the AutoMod settings are updated.
	* @param data The updated AutoMod settings that replace the current AutoMod settings.
	*/
	async updateAutoModSettings(broadcaster, data) {
		const broadcasterId = extractUserId(broadcaster);
		return (await this._client.callApi({
			type: "helix",
			url: "moderation/automod/settings",
			method: "PUT",
			userId: broadcasterId,
			scopes: ["moderator:manage:automod_settings"],
			canOverrideScopedUserContext: true,
			query: this._createModeratorActionQuery(broadcasterId),
			jsonBody: createAutoModSettingsBody(data)
		})).data.map((settingsData) => new HelixAutoModSettings(settingsData));
	}
	/**
	* Bans or times out a user in a channel.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster in whose channel the user will be banned/timed out.
	* @param data
	*
	* @expandParams
	*
	* @returns The result data from the ban/timeout request.
	*/
	async banUser(broadcaster, data) {
		const broadcasterId = extractUserId(broadcaster);
		return (await this._client.callApi({
			type: "helix",
			url: "moderation/bans",
			method: "POST",
			userId: broadcasterId,
			scopes: ["moderator:manage:banned_users"],
			canOverrideScopedUserContext: true,
			query: this._createModeratorActionQuery(broadcasterId),
			jsonBody: createBanUserBody(data)
		})).data.map((banData) => new HelixBanUser(banData, banData.end_time, this._client));
	}
	/**
	* Unbans/removes the timeout for a user in a channel.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster in whose channel the user will be unbanned/removed from timeout.
	* @param user The user who will be unbanned/removed from timeout.
	*/
	async unbanUser(broadcaster, user) {
		const broadcasterId = extractUserId(broadcaster);
		await this._client.callApi({
			type: "helix",
			url: "moderation/bans",
			method: "DELETE",
			userId: broadcasterId,
			scopes: ["moderator:manage:banned_users"],
			canOverrideScopedUserContext: true,
			query: {
				...this._createModeratorActionQuery(broadcasterId),
				...createSingleKeyQuery("user_id", extractUserId(user))
			}
		});
	}
	/**
	* Gets the broadcaster’s list of non-private, blocked words or phrases.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster to get their channel's blocked terms for.
	* @param pagination
	*
	* @expandParams
	*
	* @returns A paginated list of blocked term data in the broadcaster's channel.
	*/
	async getBlockedTerms(broadcaster, pagination) {
		const broadcasterId = extractUserId(broadcaster);
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "moderation/blocked_terms",
			userId: broadcasterId,
			scopes: ["moderator:read:blocked_terms"],
			canOverrideScopedUserContext: true,
			query: {
				...this._createModeratorActionQuery(broadcasterId),
				...createPaginationQuery(pagination)
			}
		}), HelixBlockedTerm, this._client);
	}
	/**
	* Adds a blocked term to the broadcaster's channel.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster in whose channel the term will be blocked.
	* @param text The word or phrase to block from being used in the broadcaster's channel.
	*
	* @returns Information about the term that has been blocked.
	*/
	async addBlockedTerm(broadcaster, text) {
		const broadcasterId = extractUserId(broadcaster);
		return (await this._client.callApi({
			type: "helix",
			url: "moderation/blocked_terms",
			method: "POST",
			userId: broadcasterId,
			scopes: ["moderator:manage:blocked_terms"],
			canOverrideScopedUserContext: true,
			query: this._createModeratorActionQuery(broadcasterId),
			jsonBody: { text }
		})).data.map((blockedTermData) => new HelixBlockedTerm(blockedTermData));
	}
	/**
	* Removes a blocked term from the broadcaster's channel.
	*
	* @param broadcaster The broadcaster in whose channel the term will be unblocked.
	* @param moderator A user that has permission to unblock terms in the broadcaster's channel.
	* The token of this user will be used to remove the blocked term.
	* @param id The ID of the term that should be unblocked.
	*/
	async removeBlockedTerm(broadcaster, moderator, id) {
		const broadcasterId = extractUserId(broadcaster);
		await this._client.callApi({
			type: "helix",
			url: "moderation/blocked_terms",
			method: "DELETE",
			userId: broadcasterId,
			scopes: ["moderator:manage:blocked_terms"],
			canOverrideScopedUserContext: true,
			query: {
				...this._createModeratorActionQuery(broadcasterId),
				id
			}
		});
	}
	/**
	* Removes a single chat message or all chat messages from the broadcaster’s chat room.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster the chat belongs to.
	* @param messageId The ID of the message to remove. If not specified, the request removes all messages in the broadcaster’s chat room.
	*/
	async deleteChatMessages(broadcaster, messageId) {
		const broadcasterId = extractUserId(broadcaster);
		await this._client.callApi({
			type: "helix",
			url: "moderation/chat",
			method: "DELETE",
			userId: broadcasterId,
			scopes: ["moderator:manage:chat_messages"],
			canOverrideScopedUserContext: true,
			query: {
				...this._createModeratorActionQuery(broadcasterId),
				...createSingleKeyQuery("message_id", messageId)
			}
		});
	}
	/**
	* Gets the broadcaster's Shield Mode activation status.
	*
	* @param broadcaster The broadcaster whose Shield Mode activation status you want to get.
	*/
	async getShieldModeStatus(broadcaster) {
		const broadcasterId = extractUserId(broadcaster);
		return new HelixShieldModeStatus((await this._client.callApi({
			type: "helix",
			url: "moderation/shield_mode",
			method: "GET",
			userId: broadcasterId,
			scopes: ["moderator:read:shield_mode", "moderator:manage:shield_mode"],
			canOverrideScopedUserContext: true,
			query: this._createModeratorActionQuery(broadcasterId)
		})).data[0], this._client);
	}
	/**
	* Activates or deactivates the broadcaster's Shield Mode.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The broadcaster whose Shield Mode you want to activate or deactivate.
	* @param activate The desired Shield Mode status on the broadcaster's channel.
	*/
	async updateShieldModeStatus(broadcaster, activate) {
		const broadcasterId = extractUserId(broadcaster);
		return new HelixShieldModeStatus((await this._client.callApi({
			type: "helix",
			url: "moderation/shield_mode",
			method: "PUT",
			userId: broadcasterId,
			scopes: ["moderator:manage:shield_mode"],
			canOverrideScopedUserContext: true,
			query: this._createModeratorActionQuery(broadcasterId),
			jsonBody: createUpdateShieldModeStatusBody(activate)
		})).data[0], this._client);
	}
	/**
	* Gets a list of unban requests.
	*
	* @param broadcaster The broadcaster to get unban requests of.
	* @param status The status of unban requests to retrieve.
	* @param filter Additional filters for the result set.
	*/
	async getUnbanRequests(broadcaster, status, filter) {
		const broadcasterId = extractUserId(broadcaster);
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "moderation/unban_requests",
			method: "GET",
			userId: broadcasterId,
			scopes: ["moderator:read:unban_requests", "moderator:manage:unban_requests"],
			canOverrideScopedUserContext: true,
			query: {
				...this._createModeratorActionQuery(broadcasterId),
				...createSingleKeyQuery("status", status),
				...createPaginationQuery(filter)
			}
		}), HelixUnbanRequest, this._client);
	}
	/**
	* Creates a paginator for unban requests.
	*
	* @param broadcaster The broadcaster to get unban requests of.
	* @param status The status of unban requests to retrieve.
	*/
	getUnbanRequestsPaginated(broadcaster, status) {
		const broadcasterId = extractUserId(broadcaster);
		return new HelixPaginatedRequest({
			url: "moderation/unban_requests",
			method: "GET",
			userId: broadcasterId,
			scopes: ["moderator:read:unban_requests", "moderator:manage:unban_requests"],
			canOverrideScopedUserContext: true,
			query: {
				...this._createModeratorActionQuery(broadcasterId),
				...createSingleKeyQuery("status", status)
			}
		}, this._client, (data) => new HelixUnbanRequest(data, this._client));
	}
	/**
	* Resolves an unban request by approving or denying it.
	*
	* This uses the token of the broadcaster by default.
	* If you want to execute this in the context of another user (who has to be moderator of the channel)
	* you can do so using [user context overrides](/docs/auth/concepts/context-switching).
	*
	* @param broadcaster The ID of the broadcaster whose channel is approving or denying the unban request.
	* @param unbanRequestId The ID of the unban request to resolve.
	* @param approved Whether to approve or deny the unban request.
	* @param resolutionMessage Message supplied by the unban request resolver.
	*
	* The message is limited to a maximum of 500 characters.
	*/
	async resolveUnbanRequest(broadcaster, unbanRequestId, approved, resolutionMessage) {
		const broadcasterId = extractUserId(broadcaster);
		return new HelixUnbanRequest((await this._client.callApi({
			type: "helix",
			url: "moderation/unban_requests",
			method: "PATCH",
			userId: broadcasterId,
			scopes: ["moderator:manage:unban_requests"],
			canOverrideScopedUserContext: true,
			query: createResolveUnbanRequestQuery(broadcasterId, this._getUserContextIdWithDefault(broadcasterId), unbanRequestId, approved, resolutionMessage?.slice(0, 500))
		})).data[0], this._client);
	}
	/**
	* Warns a user in the specified broadcaster’s chat room, preventing them from chat interaction until the
	* warning is acknowledged.
	*
	* New warnings can be issued to a user when they already have a warning in the channel
	* (new warning will replace old warning).
	*
	* @param broadcaster The ID of the broadcaster in which channel the warning will take effect.
	* @param user The ID of the user to be warned.
	* @param reason A custom reason for the warning. Max 500 chars.
	*/
	async warnUser(broadcaster, user, reason) {
		const broadcasterId = extractUserId(broadcaster);
		return new HelixWarning((await this._client.callApi({
			type: "helix",
			url: "moderation/warnings",
			method: "POST",
			userId: broadcasterId,
			scopes: ["moderator:manage:warnings"],
			canOverrideScopedUserContext: true,
			query: this._createModeratorActionQuery(broadcasterId),
			jsonBody: createWarnUserBody(user, reason.slice(0, 500))
		})).data[0], this._client);
	}
	_createModeratorActionQuery(broadcasterId) {
		return createModeratorActionQuery(broadcasterId, this._getUserContextIdWithDefault(broadcasterId));
	}
};
HelixModerationApi = __decorate([rtfm("api", "HelixModerationApi")], HelixModerationApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/poll.external.js
/** @internal */
function createPollBody(broadcaster, data) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		title: data.title,
		choices: data.choices.map((title) => ({ title })),
		duration: data.duration,
		channel_points_voting_enabled: data.channelPointsPerVote != null,
		channel_points_per_vote: data.channelPointsPerVote ?? 0
	};
}
/** @internal */
function createPollEndBody(broadcaster, id, showResult) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		id,
		status: showResult ? "TERMINATED" : "ARCHIVED"
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/poll/HelixPollChoice.js
/**
* A choice in a channel poll.
*/
let HelixPollChoice = class HelixPollChoice extends DataObject {
	/**
	* The ID of the choice.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The title of the choice.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* The total votes the choice received.
	*/
	get totalVotes() {
		return this[rawDataSymbol].votes;
	}
	/**
	* The votes the choice received by spending channel points.
	*/
	get channelPointsVotes() {
		return this[rawDataSymbol].channel_points_votes;
	}
};
HelixPollChoice = __decorate([rtfm("api", "HelixPollChoice", "id")], HelixPollChoice);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/poll/HelixPoll.js
/**
* A channel poll.
*/
let HelixPoll = class HelixPoll extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the poll.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The ID of the broadcaster.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the broadcaster.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The title of the poll.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* Whether voting with channel points is enabled for the poll.
	*/
	get isChannelPointsVotingEnabled() {
		return this[rawDataSymbol].channel_points_voting_enabled;
	}
	/**
	* The amount of channel points that a vote costs.
	*/
	get channelPointsPerVote() {
		return this[rawDataSymbol].channel_points_per_vote;
	}
	/**
	* The status of the poll.
	*/
	get status() {
		return this[rawDataSymbol].status;
	}
	/**
	* The duration of the poll, in seconds.
	*/
	get durationInSeconds() {
		return this[rawDataSymbol].duration;
	}
	/**
	* The date when the poll started.
	*/
	get startDate() {
		return new Date(this[rawDataSymbol].started_at);
	}
	/**
	* The date when the poll ended or will end.
	*/
	get endDate() {
		return new Date(this.startDate.getTime() + this[rawDataSymbol].duration * 1e3);
	}
	/**
	* The choices of the poll.
	*/
	get choices() {
		return this[rawDataSymbol].choices.map((data) => new HelixPollChoice(data));
	}
};
__decorate([Enumerable(false)], HelixPoll.prototype, "_client", void 0);
HelixPoll = __decorate([rtfm("api", "HelixPoll", "id")], HelixPoll);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/poll/HelixPollApi.js
/**
* The Helix API methods that deal with polls.
*
* Can be accessed using `client.polls` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const { data: polls } = await api.helix.polls.getPolls('61369223');
* ```
*
* @meta category helix
* @meta categorizedTitle Polls
*/
let HelixPollApi = class HelixPollApi extends BaseApi {
	/**
	* Gets a list of polls for the given broadcaster.
	*
	* @param broadcaster The broadcaster to get polls for.
	* @param pagination
	*
	* @expandParams
	*/
	async getPolls(broadcaster, pagination) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "polls",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:polls", "channel:manage:polls"],
			query: {
				...createBroadcasterQuery(broadcaster),
				...createPaginationQuery(pagination)
			}
		}), HelixPoll, this._client);
	}
	/**
	* Creates a paginator for polls for the given broadcaster.
	*
	* @param broadcaster The broadcaster to get polls for.
	*/
	getPollsPaginated(broadcaster) {
		return new HelixPaginatedRequest({
			url: "polls",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:polls", "channel:manage:polls"],
			query: createBroadcasterQuery(broadcaster)
		}, this._client, (data) => new HelixPoll(data, this._client), 20);
	}
	/**
	* Gets polls by IDs.
	*
	* @param broadcaster The broadcaster to get the polls for.
	* @param ids The IDs of the polls.
	*/
	async getPollsByIds(broadcaster, ids) {
		if (!ids.length) return [];
		return (await this._client.callApi({
			type: "helix",
			url: "polls",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:polls", "channel:manage:polls"],
			query: createGetByIdsQuery(broadcaster, ids)
		})).data.map((data) => new HelixPoll(data, this._client));
	}
	/**
	* Gets a poll by ID.
	*
	* @param broadcaster The broadcaster to get the poll for.
	* @param id The ID of the poll.
	*/
	async getPollById(broadcaster, id) {
		const polls = await this.getPollsByIds(broadcaster, [id]);
		return polls.length ? polls[0] : null;
	}
	/**
	* Creates a new poll.
	*
	* @param broadcaster The broadcaster to create the poll for.
	* @param data
	*
	* @expandParams
	*/
	async createPoll(broadcaster, data) {
		return new HelixPoll((await this._client.callApi({
			type: "helix",
			url: "polls",
			method: "POST",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:polls"],
			jsonBody: createPollBody(broadcaster, data)
		})).data[0], this._client);
	}
	/**
	* Ends a poll.
	*
	* @param broadcaster The broadcaster to end the poll for.
	* @param id The ID of the poll to end.
	* @param showResult Whether to allow the result to be viewed publicly.
	*/
	async endPoll(broadcaster, id, showResult = true) {
		return new HelixPoll((await this._client.callApi({
			type: "helix",
			url: "polls",
			method: "PATCH",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:polls"],
			jsonBody: createPollEndBody(broadcaster, id, showResult)
		})).data[0], this._client);
	}
};
HelixPollApi = __decorate([rtfm("api", "HelixPollApi")], HelixPollApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/prediction.external.js
/** @internal */
function createPredictionBody(broadcaster, data) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		title: data.title,
		outcomes: data.outcomes.map((title) => ({ title })),
		prediction_window: data.autoLockAfter
	};
}
/** @internal */
function createEndPredictionBody(broadcaster, id, status, outcomeId) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		id,
		status,
		winning_outcome_id: outcomeId
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/prediction/HelixPredictor.js
/**
* A user that took part in a prediction.
*/
let HelixPredictor = class HelixPredictor extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The user ID of the predictor.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the predictor.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the predictor.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets more information about the predictor.
	*/
	async getUser() {
		return await this._client.users.getUserById(this[rawDataSymbol].user_id);
	}
	/**
	* The amount of channel points the predictor used for the prediction.
	*/
	get channelPointsUsed() {
		return this[rawDataSymbol].channel_points_used;
	}
	/**
	* The amount of channel points the predictor won for the prediction, or null if the prediction is not resolved yet, was cancelled or lost.
	*/
	get channelPointsWon() {
		return this[rawDataSymbol].channel_points_won;
	}
};
__decorate([Enumerable(false)], HelixPredictor.prototype, "_client", void 0);
HelixPredictor = __decorate([rtfm("api", "HelixPredictor", "userId")], HelixPredictor);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/prediction/HelixPredictionOutcome.js
/**
* A possible outcome in a channel prediction.
*/
let HelixPredictionOutcome = class HelixPredictionOutcome extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the outcome.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The title of the outcome.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* The number of users that guessed the outcome.
	*/
	get users() {
		return this[rawDataSymbol].users;
	}
	/**
	* The total number of channel points that were spent on guessing the outcome.
	*/
	get totalChannelPoints() {
		return this[rawDataSymbol].channel_points;
	}
	/**
	* The color of the outcome.
	*/
	get color() {
		return this[rawDataSymbol].color;
	}
	/**
	* The top predictors of the outcome.
	*/
	get topPredictors() {
		return this[rawDataSymbol].top_predictors?.map((data) => new HelixPredictor(data, this._client)) ?? [];
	}
};
__decorate([Enumerable(false)], HelixPredictionOutcome.prototype, "_client", void 0);
HelixPredictionOutcome = __decorate([rtfm("api", "HelixPredictionOutcome", "id")], HelixPredictionOutcome);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/prediction/HelixPrediction.js
/**
* A channel prediction.
*/
let HelixPrediction = class HelixPrediction extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the prediction.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The ID of the broadcaster.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the broadcaster.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The title of the prediction.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* The status of the prediction.
	*/
	get status() {
		return this[rawDataSymbol].status;
	}
	/**
	* The time after which the prediction will be automatically locked, in seconds from creation.
	*/
	get autoLockAfter() {
		return this[rawDataSymbol].prediction_window;
	}
	/**
	* The date when the prediction started.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* The date when the prediction ended, or null if it didn't end yet.
	*/
	get endDate() {
		return this[rawDataSymbol].ended_at ? new Date(this[rawDataSymbol].ended_at) : null;
	}
	/**
	* The date when the prediction was locked, or null if it wasn't locked yet.
	*/
	get lockDate() {
		return this[rawDataSymbol].locked_at ? new Date(this[rawDataSymbol].locked_at) : null;
	}
	/**
	* The possible outcomes of the prediction.
	*/
	get outcomes() {
		return this[rawDataSymbol].outcomes.map((data) => new HelixPredictionOutcome(data, this._client));
	}
	/**
	* The ID of the winning outcome, or null if the prediction is currently running or was canceled.
	*/
	get winningOutcomeId() {
		return this[rawDataSymbol].winning_outcome_id || null;
	}
	/**
	* The winning outcome, or null if the prediction is currently running or was canceled.
	*/
	get winningOutcome() {
		if (!this[rawDataSymbol].winning_outcome_id) return null;
		const found = this[rawDataSymbol].outcomes.find((o) => o.id === this[rawDataSymbol].winning_outcome_id);
		if (!found) throw new HellFreezesOverError("Winning outcome not found in outcomes array");
		return new HelixPredictionOutcome(found, this._client);
	}
};
__decorate([Enumerable(false)], HelixPrediction.prototype, "_client", void 0);
HelixPrediction = __decorate([rtfm("api", "HelixPrediction", "id")], HelixPrediction);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/prediction/HelixPredictionApi.js
/**
* The Helix API methods that deal with predictions.
*
* Can be accessed using `client.predictions` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const { data: predictions } = await api.helix.predictions.getPredictions('61369223');
* ```
*
* @meta category helix
* @meta categorizedTitle Predictions
*/
let HelixPredictionApi = class HelixPredictionApi extends BaseApi {
	/**
	* Gets a list of predictions for the given broadcaster.
	*
	* @param broadcaster The broadcaster to get predictions for.
	* @param pagination
	*
	* @expandParams
	*/
	async getPredictions(broadcaster, pagination) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "predictions",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:predictions"],
			query: {
				...createBroadcasterQuery(broadcaster),
				...createPaginationQuery(pagination)
			}
		}), HelixPrediction, this._client);
	}
	/**
	* Creates a paginator for predictions for the given broadcaster.
	*
	* @param broadcaster The broadcaster to get predictions for.
	*/
	getPredictionsPaginated(broadcaster) {
		return new HelixPaginatedRequest({
			url: "predictions",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:predictions"],
			query: createBroadcasterQuery(broadcaster)
		}, this._client, (data) => new HelixPrediction(data, this._client), 20);
	}
	/**
	* Gets predictions by IDs.
	*
	* @param broadcaster The broadcaster to get the predictions for.
	* @param ids The IDs of the predictions.
	*/
	async getPredictionsByIds(broadcaster, ids) {
		if (!ids.length) return [];
		return (await this._client.callApi({
			type: "helix",
			url: "predictions",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:predictions"],
			query: createGetByIdsQuery(broadcaster, ids)
		})).data.map((data) => new HelixPrediction(data, this._client));
	}
	/**
	* Gets a prediction by ID.
	*
	* @param broadcaster The broadcaster to get the prediction for.
	* @param id The ID of the prediction.
	*/
	async getPredictionById(broadcaster, id) {
		const predictions = await this.getPredictionsByIds(broadcaster, [id]);
		return predictions.length ? predictions[0] : null;
	}
	/**
	* Creates a new prediction.
	*
	* @param broadcaster The broadcaster to create the prediction for.
	* @param data
	*
	* @expandParams
	*/
	async createPrediction(broadcaster, data) {
		return new HelixPrediction((await this._client.callApi({
			type: "helix",
			url: "predictions",
			method: "POST",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:predictions"],
			jsonBody: createPredictionBody(broadcaster, data)
		})).data[0], this._client);
	}
	/**
	* Locks a prediction.
	*
	* @param broadcaster The broadcaster to lock the prediction for.
	* @param id The ID of the prediction to lock.
	*/
	async lockPrediction(broadcaster, id) {
		return await this._endPrediction(broadcaster, id, "LOCKED");
	}
	/**
	* Resolves a prediction.
	*
	* @param broadcaster The broadcaster to resolve the prediction for.
	* @param id The ID of the prediction to resolve.
	* @param outcomeId The ID of the winning outcome.
	*/
	async resolvePrediction(broadcaster, id, outcomeId) {
		return await this._endPrediction(broadcaster, id, "RESOLVED", outcomeId);
	}
	/**
	* Cancels a prediction.
	*
	* @param broadcaster The broadcaster to cancel the prediction for.
	* @param id The ID of the prediction to cancel.
	*/
	async cancelPrediction(broadcaster, id) {
		return await this._endPrediction(broadcaster, id, "CANCELED");
	}
	async _endPrediction(broadcaster, id, status, outcomeId) {
		return new HelixPrediction((await this._client.callApi({
			type: "helix",
			url: "predictions",
			method: "PATCH",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:predictions"],
			jsonBody: createEndPredictionBody(broadcaster, id, status, outcomeId)
		})).data[0], this._client);
	}
};
HelixPredictionApi = __decorate([rtfm("api", "HelixPredictionApi")], HelixPredictionApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/raid.external.js
/** @internal */
function createRaidStartQuery(from, to) {
	return {
		from_broadcaster_id: extractUserId(from),
		to_broadcaster_id: extractUserId(to)
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/raids/HelixRaid.js
/**
* A result of a successful raid initiation.
*/
let HelixRaid = class HelixRaid extends DataObject {
	/**
	* The date when the raid was initiated.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* Whether the raid target channel is intended for mature audiences.
	*/
	get targetIsMature() {
		return this[rawDataSymbol].is_mature;
	}
};
HelixRaid = __decorate([rtfm("api", "HelixRaid")], HelixRaid);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/raids/HelixRaidApi.js
/**
* The Helix API methods that deal with raids.
*
* Can be accessed using `client.raids` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const raid = await api.raids.startRaid('125328655', '61369223');
* ```
*
* @meta category helix
* @meta categorizedTitle Raids
*/
let HelixRaidApi = class HelixRaidApi extends BaseApi {
	/**
	* Initiate a raid from a live broadcaster to another live broadcaster.
	*
	* @param from The raiding broadcaster.
	* @param to The raid target.
	*/
	async startRaid(from, to) {
		return new HelixRaid((await this._client.callApi({
			type: "helix",
			url: "raids",
			method: "POST",
			userId: extractUserId(from),
			scopes: ["channel:manage:raids"],
			query: createRaidStartQuery(from, to)
		})).data[0]);
	}
	/**
	* Cancels an initiated raid.
	*
	* @param from The raiding broadcaster.
	*/
	async cancelRaid(from) {
		await this._client.callApi({
			type: "helix",
			url: "raids",
			method: "DELETE",
			userId: extractUserId(from),
			scopes: ["channel:manage:raids"],
			query: createBroadcasterQuery(from)
		});
	}
};
HelixRaidApi = __decorate([rtfm("api", "HelixRaidApi")], HelixRaidApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/schedule.external.js
/** @internal */
function createScheduleQuery(broadcaster, filter) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		start_time: filter?.startDate,
		utc_offset: filter?.utcOffset?.toString()
	};
}
/** @internal */
function createScheduleSettingsUpdateQuery(broadcaster, settings) {
	if (settings.vacation) return {
		broadcaster_id: extractUserId(broadcaster),
		is_vacation_enabled: "true",
		vacation_start_time: settings.vacation.startDate,
		vacation_end_time: settings.vacation.endDate,
		timezone: settings.vacation.timezone
	};
	return {
		broadcaster_id: extractUserId(broadcaster),
		is_vacation_enabled: "false"
	};
}
/** @internal */
function createScheduleSegmentBody(data) {
	return {
		start_time: data.startDate,
		timezone: data.timezone,
		is_recurring: data.isRecurring,
		duration: data.duration,
		category_id: data.categoryId,
		title: data.title
	};
}
/** @internal */
function createScheduleSegmentModifyQuery(broadcaster, segmentId) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		id: segmentId
	};
}
/** @internal */
function createScheduleSegmentUpdateBody(data) {
	return {
		start_time: data.startDate,
		timezone: data.timezone,
		is_canceled: data.isCanceled,
		duration: data.duration,
		category_id: data.categoryId,
		title: data.title
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/schedule/HelixScheduleSegment.js
/**
* A segment of a schedule.
*/
let HelixScheduleSegment = class HelixScheduleSegment extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the segment.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The date when the segment starts.
	*/
	get startDate() {
		return new Date(this[rawDataSymbol].start_time);
	}
	/**
	* The date when the segment ends.
	*/
	get endDate() {
		return new Date(this[rawDataSymbol].end_time);
	}
	/**
	* The title of the segment.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* The date up to which the segment is canceled.
	*/
	get cancelEndDate() {
		return mapNullable(this[rawDataSymbol].canceled_until, (v) => new Date(v));
	}
	/**
	* The ID of the category the segment is scheduled for, or null if no category is specified.
	*/
	get categoryId() {
		return this[rawDataSymbol].category?.id ?? null;
	}
	/**
	* The name of the category the segment is scheduled for, or null if no category is specified.
	*/
	get categoryName() {
		return this[rawDataSymbol].category?.name ?? null;
	}
	/**
	* Gets more information about the category the segment is scheduled for, or null if no category is specified.
	*/
	async getCategory() {
		const categoryId = this[rawDataSymbol].category?.id;
		return categoryId ? await this._client.games.getGameById(categoryId) : null;
	}
	/**
	* Whether the segment is recurring every week.
	*/
	get isRecurring() {
		return this[rawDataSymbol].is_recurring;
	}
};
__decorate([Enumerable(false)], HelixScheduleSegment.prototype, "_client", void 0);
HelixScheduleSegment = __decorate([rtfm("api", "HelixScheduleSegment", "id")], HelixScheduleSegment);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/schedule/HelixPaginatedScheduleSegmentRequest.js
/**
* A paginator specifically for schedule segments.
*/
let HelixPaginatedScheduleSegmentRequest = class HelixPaginatedScheduleSegmentRequest extends HelixPaginatedRequest {
	/** @internal */
	constructor(broadcaster, client, filter) {
		super({
			url: "schedule",
			query: createScheduleQuery(broadcaster, filter)
		}, client, (data) => new HelixScheduleSegment(data, client), 25);
	}
	/** @internal */
	async _fetchData(additionalOptions = {}) {
		const origData = await super._fetchData(additionalOptions);
		return {
			data: origData.data.segments ?? [],
			pagination: origData.pagination
		};
	}
};
HelixPaginatedScheduleSegmentRequest = __decorate([rtfm("api", "HelixPaginatedScheduleSegmentRequest")], HelixPaginatedScheduleSegmentRequest);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/schedule/HelixSchedule.js
/**
* A schedule of a channel.
*/
let HelixSchedule = class HelixSchedule extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The segments of the schedule.
	*/
	get segments() {
		return this[rawDataSymbol].segments?.map((data) => new HelixScheduleSegment(data, this._client)) ?? [];
	}
	/**
	* The ID of the broadcaster.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the broadcaster.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The date when the current vacation started, or null if the schedule is not in vacation mode.
	*/
	get vacationStartDate() {
		const timestamp = this[rawDataSymbol].vacation?.start_time;
		return timestamp ? new Date(timestamp) : null;
	}
	/**
	* The date when the current vacation ends, or null if the schedule is not in vacation mode.
	*/
	get vacationEndDate() {
		const timestamp = this[rawDataSymbol].vacation?.end_time;
		return timestamp ? new Date(timestamp) : null;
	}
};
__decorate([Enumerable(false)], HelixSchedule.prototype, "_client", void 0);
HelixSchedule = __decorate([rtfm("api", "HelixSchedule", "broadcasterId")], HelixSchedule);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/schedule/HelixScheduleApi.js
/**
* The Helix API methods that deal with schedules.
*
* Can be accessed using `client.schedule` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const { data: schedule } = await api.helix.schedule.getSchedule('61369223');
* ```
*
* @meta category helix
* @meta categorizedTitle Schedule
*/
var HelixScheduleApi = class extends BaseApi {
	/**
	* Gets the schedule for a given broadcaster.
	*
	* @param broadcaster The broadcaster to get the schedule of.
	* @param filter
	*
	* @expandParams
	*/
	async getSchedule(broadcaster, filter) {
		const result = await this._client.callApi({
			type: "helix",
			url: "schedule",
			userId: extractUserId(broadcaster),
			query: {
				...createScheduleQuery(broadcaster, filter),
				...createPaginationQuery(filter)
			}
		});
		return {
			data: new HelixSchedule(result.data, this._client),
			cursor: result.pagination.cursor
		};
	}
	/**
	* Creates a paginator for schedule segments for a given broadcaster.
	*
	* @param broadcaster The broadcaster to get the schedule segments of.
	* @param filter
	*
	* @expandParams
	*/
	getScheduleSegmentsPaginated(broadcaster, filter) {
		return new HelixPaginatedScheduleSegmentRequest(broadcaster, this._client, filter);
	}
	/**
	* Gets a set of schedule segments by IDs.
	*
	* @param broadcaster The broadcaster to get schedule segments of.
	* @param ids The IDs of the schedule segments.
	*/
	async getScheduleSegmentsByIds(broadcaster, ids) {
		return (await this._client.callApi({
			type: "helix",
			url: "schedule",
			userId: extractUserId(broadcaster),
			query: createGetByIdsQuery(broadcaster, ids)
		})).data.segments?.map((data) => new HelixScheduleSegment(data, this._client)) ?? [];
	}
	/**
	* Gets a single schedule segment by ID.
	*
	* @param broadcaster The broadcaster to get a schedule segment of.
	* @param id The ID of the schedule segment.
	*/
	async getScheduleSegmentById(broadcaster, id) {
		const segments = await this.getScheduleSegmentsByIds(broadcaster, [id]);
		return segments.length ? segments[0] : null;
	}
	/**
	* Gets the schedule for a given broadcaster in iCal format.
	*
	* @param broadcaster The broadcaster to get the schedule for.
	*/
	async getScheduleAsIcal(broadcaster) {
		return await this._client.callApi({
			type: "helix",
			url: "schedule/icalendar",
			query: createBroadcasterQuery(broadcaster)
		});
	}
	/**
	* Updates the schedule settings of a given broadcaster.
	*
	* @param broadcaster The broadcaster to update the schedule settings for.
	* @param settings
	*
	* @expandParams
	*/
	async updateScheduleSettings(broadcaster, settings) {
		await this._client.callApi({
			type: "helix",
			url: "schedule/settings",
			method: "PATCH",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:schedule"],
			query: createScheduleSettingsUpdateQuery(broadcaster, settings)
		});
	}
	/**
	* Creates a new segment in a given broadcaster's schedule.
	*
	* @param broadcaster The broadcaster to create a new schedule segment for.
	* @param data
	*
	* @expandParams
	*/
	async createScheduleSegment(broadcaster, data) {
		return new HelixScheduleSegment((await this._client.callApi({
			type: "helix",
			url: "schedule/segment",
			method: "POST",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:schedule"],
			query: createBroadcasterQuery(broadcaster),
			jsonBody: createScheduleSegmentBody(data)
		})).data.segments[0], this._client);
	}
	/**
	* Updates a segment in a given broadcaster's schedule.
	*
	* @param broadcaster The broadcaster to create a new schedule segment for.
	* @param segmentId The ID of the segment to update.
	* @param data
	*
	* @expandParams
	*/
	async updateScheduleSegment(broadcaster, segmentId, data) {
		return new HelixScheduleSegment((await this._client.callApi({
			type: "helix",
			url: "schedule/segment",
			method: "PATCH",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:schedule"],
			query: createScheduleSegmentModifyQuery(broadcaster, segmentId),
			jsonBody: createScheduleSegmentUpdateBody(data)
		})).data.segments[0], this._client);
	}
	/**
	* Deletes a segment in a given broadcaster's schedule.
	*
	* @param broadcaster The broadcaster to create a new schedule segment for.
	* @param segmentId The ID of the segment to update.
	*/
	async deleteScheduleSegment(broadcaster, segmentId) {
		await this._client.callApi({
			type: "helix",
			url: "schedule/segment",
			method: "DELETE",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:schedule"],
			query: createScheduleSegmentModifyQuery(broadcaster, segmentId)
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/search.external.js
/** @internal */
function createSearchChannelsQuery(query, filter) {
	return {
		query,
		live_only: filter.liveOnly?.toString()
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/search/HelixChannelSearchResult.js
/**
* The result of a channel search.
*/
let HelixChannelSearchResult = class HelixChannelSearchResult extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The language of the channel.
	*/
	get language() {
		return this[rawDataSymbol].broadcaster_language;
	}
	/**
	* The ID of the channel.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The name of the channel.
	*/
	get name() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the channel.
	*/
	get displayName() {
		return this[rawDataSymbol].display_name;
	}
	/**
	* Gets additional information about the owner of the channel.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].id));
	}
	/**
	* The ID of the game currently played on the channel.
	*/
	get gameId() {
		return this[rawDataSymbol].game_id;
	}
	/**
	* The name of the game currently played on the channel.
	*/
	get gameName() {
		return this[rawDataSymbol].game_name;
	}
	/**
	* Gets information about the game that is being played on the stream.
	*/
	async getGame() {
		return this[rawDataSymbol].game_id ? checkRelationAssertion(await this._client.games.getGameById(this[rawDataSymbol].game_id)) : null;
	}
	/**
	* Whether the channel is currently live.
	*/
	get isLive() {
		return this[rawDataSymbol].is_live;
	}
	/**
	* The tags applied to the channel.
	*/
	get tags() {
		return this[rawDataSymbol].tags;
	}
	/**
	* The thumbnail URL of the stream.
	*/
	get thumbnailUrl() {
		return this[rawDataSymbol].thumbnail_url;
	}
	/**
	* The start date of the stream. Returns `null` if the stream is not live.
	*/
	get startDate() {
		return this[rawDataSymbol].is_live ? new Date(this[rawDataSymbol].started_at) : null;
	}
};
__decorate([Enumerable(false)], HelixChannelSearchResult.prototype, "_client", void 0);
HelixChannelSearchResult = __decorate([rtfm("api", "HelixChannelSearchResult", "id")], HelixChannelSearchResult);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/search/HelixSearchApi.js
/**
* The Helix API methods that run searches.
*
* Can be accessed using `client.search` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const channels = await api.search.searchChannels('pear');
* ```
*
* @meta category helix
* @meta categorizedTitle Search
*/
let HelixSearchApi = class HelixSearchApi extends BaseApi {
	/**
	* Search categories/games for an exact or partial match.
	*
	* @param query The search term.
	* @param pagination
	*
	* @expandParams
	*/
	async searchCategories(query, pagination) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "search/categories",
			query: {
				query,
				...createPaginationQuery(pagination)
			}
		}), HelixGame, this._client);
	}
	/**
	* Creates a paginator for a category/game search.
	*
	* @param query The search term.
	*/
	searchCategoriesPaginated(query) {
		return new HelixPaginatedRequest({
			url: "search/categories",
			query: { query }
		}, this._client, (data) => new HelixGame(data, this._client));
	}
	/**
	* Search channels for an exact or partial match.
	*
	* @param query The search term.
	* @param filter
	*
	* @expandParams
	*/
	async searchChannels(query, filter = {}) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "search/channels",
			query: {
				...createSearchChannelsQuery(query, filter),
				...createPaginationQuery(filter)
			}
		}), HelixChannelSearchResult, this._client);
	}
	/**
	* Creates a paginator for a channel search.
	*
	* @param query The search term.
	* @param filter
	*
	* @expandParams
	*/
	searchChannelsPaginated(query, filter = {}) {
		return new HelixPaginatedRequest({
			url: "search/channels",
			query: createSearchChannelsQuery(query, filter)
		}, this._client, (data) => new HelixChannelSearchResult(data, this._client));
	}
};
HelixSearchApi = __decorate([rtfm("api", "HelixSearchApi")], HelixSearchApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/errors/StreamNotLiveError.js
/**
* Thrown whenever you try something that requires your own stream to be live.
*/
var StreamNotLiveError = class extends CustomError {
	/** @private */
	constructor(options) {
		super("Your stream needs to be live to do this", options);
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/stream.external.js
/** @internal */
function createStreamQuery(filter) {
	return {
		game_id: filter.game,
		language: filter.language,
		type: filter.type,
		user_id: filter.userId,
		user_login: filter.userName
	};
}
/** @internal */
function createStreamMarkerBody(broadcaster, description) {
	return {
		user_id: extractUserId(broadcaster),
		description
	};
}
/** @internal */
function createVideoQuery(id) {
	return { video_id: id };
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/stream/HelixStream.js
/**
* A Twitch stream.
*/
let HelixStream = class HelixStream extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The stream ID.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The user ID.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The user's name.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The user's display name.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets information about the user broadcasting the stream.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* The game ID, or an empty string if the stream doesn't currently have a game.
	*/
	get gameId() {
		return this[rawDataSymbol].game_id;
	}
	/**
	* The game name, or an empty string if the stream doesn't currently have a game.
	*/
	get gameName() {
		return this[rawDataSymbol].game_name;
	}
	/**
	* Gets information about the game that is being played on the stream.
	*
	* Returns null if the stream doesn't currently have a game.
	*/
	async getGame() {
		return this[rawDataSymbol].game_id ? checkRelationAssertion(await this._client.games.getGameById(this[rawDataSymbol].game_id)) : null;
	}
	/**
	* The type of the stream.
	*/
	get type() {
		return this[rawDataSymbol].type;
	}
	/**
	* The title of the stream.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* The number of viewers the stream currently has.
	*/
	get viewers() {
		return this[rawDataSymbol].viewer_count;
	}
	/**
	* The time when the stream started.
	*/
	get startDate() {
		return new Date(this[rawDataSymbol].started_at);
	}
	/**
	* The language of the stream.
	*/
	get language() {
		return this[rawDataSymbol].language;
	}
	/**
	* The URL of the thumbnail of the stream.
	*
	* This URL includes the placeholders `{width}` and `{height}`
	* which you must replace with the desired dimensions of the thumbnail (in pixels).
	*
	* You can also use {@link HelixStream#getThumbnailUrl} to do this replacement.
	*/
	get thumbnailUrl() {
		return this[rawDataSymbol].thumbnail_url;
	}
	/**
	* Builds the thumbnail URL of the stream using the given dimensions.
	*
	* @param width The width of the thumbnail.
	* @param height The height of the thumbnail.
	*/
	getThumbnailUrl(width, height) {
		return this[rawDataSymbol].thumbnail_url.replace("{width}", width.toString()).replace("{height}", height.toString());
	}
	/**
	* The tags applied to the stream.
	*/
	get tags() {
		return this[rawDataSymbol].tags;
	}
	/**
	* Whether the stream is set to be targeted to mature audiences only.
	*/
	get isMature() {
		return this[rawDataSymbol].is_mature;
	}
};
__decorate([Enumerable(false)], HelixStream.prototype, "_client", void 0);
HelixStream = __decorate([rtfm("api", "HelixStream", "id")], HelixStream);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/stream/HelixStreamMarker.js
/**
* A stream marker.
*/
let HelixStreamMarker = class HelixStreamMarker extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the marker.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The date and time when the marker was created.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* The description of the marker.
	*/
	get description() {
		return this[rawDataSymbol].description;
	}
	/**
	* The position in the stream when the marker was created, in seconds.
	*/
	get positionInSeconds() {
		return this[rawDataSymbol].position_seconds;
	}
};
__decorate([Enumerable(false)], HelixStreamMarker.prototype, "_client", void 0);
HelixStreamMarker = __decorate([rtfm("api", "HelixStreamMarker", "id")], HelixStreamMarker);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/stream/HelixStreamMarkerWithVideo.js
/**
* A stream marker, also containing some video data.
*
* @inheritDoc
*/
let HelixStreamMarkerWithVideo = class HelixStreamMarkerWithVideo extends HelixStreamMarker {
	_videoId;
	/** @internal */
	constructor(data, _videoId, client) {
		super(data, client);
		this._videoId = _videoId;
	}
	/**
	* The URL of the video, which will start playing at the position of the stream marker.
	*/
	get url() {
		return this[rawDataSymbol].URL;
	}
	/**
	* The ID of the video.
	*/
	get videoId() {
		return this._videoId;
	}
	/**
	* Gets the video data of the video the marker was set in.
	*/
	async getVideo() {
		return checkRelationAssertion(await this._client.videos.getVideoById(this._videoId));
	}
};
HelixStreamMarkerWithVideo = __decorate([rtfm("api", "HelixStreamMarkerWithVideo", "id")], HelixStreamMarkerWithVideo);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/stream/HelixStreamApi.js
var HelixStreamApi_1;
/**
* The Helix API methods that deal with streams.
*
* Can be accessed using `client.streams` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const stream = await api.streams.getStreamByUserId('125328655');
* ```
*
* @meta category helix
* @meta categorizedTitle Streams
*/
let HelixStreamApi = HelixStreamApi_1 = class HelixStreamApi extends BaseApi {
	/** @internal */
	_getStreamByUserIdBatcher = new HelixRequestBatcher({ url: "streams" }, "user_id", "user_id", this._client, (data) => new HelixStream(data, this._client));
	/** @internal */
	_getStreamByUserNameBatcher = new HelixRequestBatcher({ url: "streams" }, "user_login", "user_login", this._client, (data) => new HelixStream(data, this._client));
	/**
	* Gets a list of streams.
	*
	* @param filter
	* @expandParams
	*/
	async getStreams(filter = {}) {
		return createPaginatedResult(await this._client.callApi({
			url: "streams",
			type: "helix",
			query: {
				...createStreamQuery(filter),
				...createPaginationQuery(filter)
			}
		}), HelixStream, this._client);
	}
	/**
	* Creates a paginator for streams.
	*
	* @param filter
	* @expandParams
	*/
	getStreamsPaginated(filter = {}) {
		return new HelixPaginatedRequest({
			url: "streams",
			query: createStreamQuery(filter)
		}, this._client, (data) => new HelixStream(data, this._client));
	}
	/**
	* Gets the current streams for the given usernames.
	*
	* @param users The username to get the streams for.
	*/
	async getStreamsByUserNames(users) {
		return (await this.getStreams({ userName: users.map(extractUserName) })).data;
	}
	/**
	* Gets the current stream for the given username.
	*
	* @param user The username to get the stream for.
	*/
	async getStreamByUserName(user) {
		return (await this.getStreamsByUserNames([user]))[0] ?? null;
	}
	/**
	* Gets the current stream for the given username, batching multiple calls into fewer requests as the API allows.
	*
	* @param user The username to get the stream for.
	*/
	async getStreamByUserNameBatched(user) {
		return await this._getStreamByUserNameBatcher.request(extractUserName(user));
	}
	/**
	* Gets the current streams for the given user IDs.
	*
	* @param users The user IDs to get the streams for.
	*/
	async getStreamsByUserIds(users) {
		return (await this.getStreams({ userId: users.map(extractUserId) })).data;
	}
	/**
	* Gets the current stream for the given user ID.
	*
	* @param user The user ID to get the stream for.
	*/
	async getStreamByUserId(user) {
		const userId = extractUserId(user);
		return mapNullable((await this._client.callApi({
			url: "streams",
			type: "helix",
			userId,
			query: createStreamQuery({ userId })
		})).data[0], (data) => new HelixStream(data, this._client));
	}
	/**
	* Gets the current stream for the given user ID, batching multiple calls into fewer requests as the API allows.
	*
	* @param user The user ID to get the stream for.
	*/
	async getStreamByUserIdBatched(user) {
		return await this._getStreamByUserIdBatcher.request(extractUserId(user));
	}
	/**
	* Gets a list of all stream markers for a user.
	*
	* @param user The user to list the stream markers for.
	* @param pagination
	*
	* @expandParams
	*/
	async getStreamMarkersForUser(user, pagination) {
		const result = await this._client.callApi({
			url: "streams/markers",
			type: "helix",
			query: {
				...createUserQuery(user),
				...createPaginationQuery(pagination)
			},
			userId: extractUserId(user),
			scopes: ["user:read:broadcast"],
			canOverrideScopedUserContext: true
		});
		return {
			data: flatten(result.data.map((data) => HelixStreamApi_1._mapGetStreamMarkersResult(data, this._client))),
			cursor: result.pagination?.cursor
		};
	}
	/**
	* Creates a paginator for all stream markers for a user.
	*
	* @param user The user to list the stream markers for.
	*/
	getStreamMarkersForUserPaginated(user) {
		return new HelixPaginatedRequest({
			url: "streams/markers",
			query: createUserQuery(user),
			userId: extractUserId(user),
			scopes: ["user:read:broadcast"],
			canOverrideScopedUserContext: true
		}, this._client, (data) => HelixStreamApi_1._mapGetStreamMarkersResult(data, this._client));
	}
	/**
	* Gets a list of all stream markers for a video.
	*
	* @param user The user the video belongs to.
	* @param videoId The video to list the stream markers for.
	* @param pagination
	*
	* @expandParams
	*/
	async getStreamMarkersForVideo(user, videoId, pagination) {
		const result = await this._client.callApi({
			url: "streams/markers",
			type: "helix",
			query: {
				...createVideoQuery(videoId),
				...createPaginationQuery(pagination)
			},
			userId: extractUserId(user),
			scopes: ["user:read:broadcast"],
			canOverrideScopedUserContext: true
		});
		return {
			data: flatten(result.data.map((data) => HelixStreamApi_1._mapGetStreamMarkersResult(data, this._client))),
			cursor: result.pagination?.cursor
		};
	}
	/**
	* Creates a paginator for all stream markers for a video.
	*
	* @param user The user the video belongs to.
	* @param videoId The video to list the stream markers for.
	*/
	getStreamMarkersForVideoPaginated(user, videoId) {
		return new HelixPaginatedRequest({
			url: "streams/markers",
			query: createVideoQuery(videoId),
			userId: extractUserId(user),
			scopes: ["user:read:broadcast"],
			canOverrideScopedUserContext: true
		}, this._client, (data) => HelixStreamApi_1._mapGetStreamMarkersResult(data, this._client));
	}
	/**
	* Creates a new stream marker.
	*
	* Only works while the specified user's stream is live.
	*
	* @param broadcaster The broadcaster to create a stream marker for.
	* @param description The description of the marker.
	*/
	async createStreamMarker(broadcaster, description) {
		try {
			return new HelixStreamMarker((await this._client.callApi({
				url: "streams/markers",
				method: "POST",
				type: "helix",
				userId: extractUserId(broadcaster),
				scopes: ["channel:manage:broadcast"],
				canOverrideScopedUserContext: true,
				jsonBody: createStreamMarkerBody(broadcaster, description)
			})).data[0], this._client);
		} catch (e) {
			if (e instanceof HttpStatusCodeError && e.statusCode === 404) throw new StreamNotLiveError({ cause: e });
			throw e;
		}
	}
	/**
	* Gets the stream key of a stream.
	*
	* @param broadcaster The broadcaster to get the stream key for.
	*/
	async getStreamKey(broadcaster) {
		const userId = extractUserId(broadcaster);
		return (await this._client.callApi({
			type: "helix",
			url: "streams/key",
			userId,
			scopes: ["channel:read:stream_key"],
			query: createBroadcasterQuery(broadcaster)
		})).data[0].stream_key;
	}
	/**
	* Gets the streams that are currently live and are followed by the given user.
	*
	* @param user The user to check followed streams for.
	* @param pagination
	*
	* @expandParams
	*/
	async getFollowedStreams(user, pagination) {
		const userId = extractUserId(user);
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "streams/followed",
			userId,
			scopes: ["user:read:follows"],
			query: {
				...createSingleKeyQuery("user_id", userId),
				...createPaginationQuery(pagination)
			}
		}), HelixStream, this._client);
	}
	/**
	* Creates a paginator for the streams that are currently live and are followed by the given user.
	*
	* @param user The user to check followed streams for.
	*/
	getFollowedStreamsPaginated(user) {
		const userId = extractUserId(user);
		return new HelixPaginatedRequest({
			url: "streams/followed",
			userId,
			scopes: ["user:read:follows"],
			query: createSingleKeyQuery("user_id", userId)
		}, this._client, (data) => new HelixStream(data, this._client));
	}
	static _mapGetStreamMarkersResult(data, client) {
		return data.videos.reduce((result, video) => [...result, ...video.markers.map((marker) => new HelixStreamMarkerWithVideo(marker, video.video_id, client))], []);
	}
};
__decorate([Enumerable(false)], HelixStreamApi.prototype, "_getStreamByUserIdBatcher", void 0);
__decorate([Enumerable(false)], HelixStreamApi.prototype, "_getStreamByUserNameBatcher", void 0);
HelixStreamApi = HelixStreamApi_1 = __decorate([rtfm("api", "HelixStreamApi")], HelixStreamApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/subscription.external.js
/** @internal */
function createSubscriptionCheckQuery(broadcaster, user) {
	return {
		broadcaster_id: extractUserId(broadcaster),
		user_id: extractUserId(user)
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/subscriptions/HelixUserSubscription.js
/**
* The user info about a (paid) subscription to a broadcaster.
*/
let HelixUserSubscription = class HelixUserSubscription extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The user ID of the broadcaster.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the broadcaster.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the broadcaster.
	*/
	async getBroadcaster() {
		return await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id);
	}
	/**
	* Whether the subscription has been gifted by another user.
	*/
	get isGift() {
		return this[rawDataSymbol].is_gift;
	}
	/**
	* The tier of the subscription.
	*/
	get tier() {
		return this[rawDataSymbol].tier;
	}
};
__decorate([Enumerable(false)], HelixUserSubscription.prototype, "_client", void 0);
HelixUserSubscription = __decorate([rtfm("api", "HelixUserSubscription", "broadcasterId")], HelixUserSubscription);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/subscriptions/HelixSubscription.js
/**
* A (paid) subscription of a user to a broadcaster.
*
* @inheritDoc
*/
let HelixSubscription = class HelixSubscription extends HelixUserSubscription {
	/**
	* The user ID of the broadcaster.
	*/
	get broadcasterId() {
		return this[rawDataSymbol].broadcaster_id;
	}
	/**
	* The name of the broadcaster.
	*/
	get broadcasterName() {
		return this[rawDataSymbol].broadcaster_login;
	}
	/**
	* The display name of the broadcaster.
	*/
	get broadcasterDisplayName() {
		return this[rawDataSymbol].broadcaster_name;
	}
	/**
	* Gets more information about the broadcaster.
	*/
	async getBroadcaster() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].broadcaster_id));
	}
	/**
	* The user ID of the gifter.
	*/
	get gifterId() {
		return this[rawDataSymbol].is_gift ? this[rawDataSymbol].gifter_id : null;
	}
	/**
	* The name of the gifter.
	*/
	get gifterName() {
		return this[rawDataSymbol].is_gift ? this[rawDataSymbol].gifter_login : null;
	}
	/**
	* The display name of the gifter.
	*/
	get gifterDisplayName() {
		return this[rawDataSymbol].is_gift ? this[rawDataSymbol].gifter_name : null;
	}
	/**
	* Gets more information about the gifter.
	*/
	async getGifter() {
		return this[rawDataSymbol].is_gift ? checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].gifter_id)) : null;
	}
	/**
	* The user ID of the subscribed user.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the subscribed user.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the subscribed user.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets more information about the subscribed user.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
};
HelixSubscription = __decorate([rtfm("api", "HelixSubscription", "userId")], HelixSubscription);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/subscriptions/HelixPaginatedSubscriptionsRequest.js
/**
* A special case of {@link HelixPaginatedRequestWithTotal}
* with support for fetching the total sub points of a broadcaster.
*
* @inheritDoc
*/
let HelixPaginatedSubscriptionsRequest = class HelixPaginatedSubscriptionsRequest extends HelixPaginatedRequestWithTotal {
	/** @internal */
	constructor(broadcaster, client) {
		super({
			url: "subscriptions",
			scopes: ["channel:read:subscriptions"],
			userId: extractUserId(broadcaster),
			query: createBroadcasterQuery(broadcaster)
		}, client, (data) => new HelixSubscription(data, client));
	}
	/**
	* Gets the total sub points of the broadcaster.
	*/
	async getPoints() {
		return (this._currentData ?? await this._fetchData({ query: { after: void 0 } })).points;
	}
};
HelixPaginatedSubscriptionsRequest = __decorate([rtfm("api", "HelixPaginatedSubscriptionsRequest")], HelixPaginatedSubscriptionsRequest);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/subscriptions/HelixSubscriptionApi.js
/**
* The Helix API methods that deal with subscriptions.
*
* Can be accessed using `client.subscriptions` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const subscription = await api.subscriptions.getSubscriptionForUser('61369223', '125328655');
* ```
*
* @meta category helix
* @meta categorizedTitle Subscriptions
*/
let HelixSubscriptionApi = class HelixSubscriptionApi extends BaseApi {
	/**
	* Gets a list of all subscriptions to a given broadcaster.
	*
	* @param broadcaster The broadcaster to list subscriptions to.
	* @param pagination
	*
	* @expandParams
	*/
	async getSubscriptions(broadcaster, pagination) {
		const result = await this._client.callApi({
			url: "subscriptions",
			scopes: ["channel:read:subscriptions"],
			type: "helix",
			userId: extractUserId(broadcaster),
			query: {
				...createBroadcasterQuery(broadcaster),
				...createPaginationQuery(pagination)
			}
		});
		return {
			...createPaginatedResultWithTotal(result, HelixSubscription, this._client),
			points: result.points
		};
	}
	/**
	* Creates a paginator for all subscriptions to a given broadcaster.
	*
	* @param broadcaster The broadcaster to list subscriptions to.
	*/
	getSubscriptionsPaginated(broadcaster) {
		return new HelixPaginatedSubscriptionsRequest(broadcaster, this._client);
	}
	/**
	* Gets the subset of the given user list that is subscribed to the given broadcaster.
	*
	* @param broadcaster The broadcaster to find subscriptions to.
	* @param users The users that should be checked for subscriptions.
	*/
	async getSubscriptionsForUsers(broadcaster, users) {
		return (await this._client.callApi({
			type: "helix",
			url: "subscriptions",
			userId: extractUserId(broadcaster),
			scopes: ["channel:read:subscriptions"],
			query: createChannelUsersCheckQuery(broadcaster, users)
		})).data.map((data) => new HelixSubscription(data, this._client));
	}
	/**
	* Gets the subscription data for a given user to a given broadcaster.
	*
	* This checks with the authorization of a broadcaster.
	* If you only have the authorization of a user, check {@link HelixSubscriptionApi#checkUserSubscription}}.
	*
	* @param broadcaster The broadcaster to check.
	* @param user The user to check.
	*/
	async getSubscriptionForUser(broadcaster, user) {
		const list = await this.getSubscriptionsForUsers(broadcaster, [user]);
		return list.length ? list[0] : null;
	}
	/**
	* Checks if a given user is subscribed to a given broadcaster. Returns null if not subscribed.
	*
	* This checks with the authorization of a user.
	* If you only have the authorization of a broadcaster, check {@link HelixSubscriptionApi#getSubscriptionForUser}}.
	*
	* @param user The user to check.
	* @param broadcaster The broadcaster to check the user's subscription for.
	*/
	async checkUserSubscription(user, broadcaster) {
		try {
			return new HelixUserSubscription((await this._client.callApi({
				type: "helix",
				url: "subscriptions/user",
				userId: extractUserId(user),
				scopes: ["user:read:subscriptions"],
				query: createSubscriptionCheckQuery(broadcaster, user)
			})).data[0], this._client);
		} catch (e) {
			if (e instanceof HttpStatusCodeError && e.statusCode === 404) return null;
			throw e;
		}
	}
};
HelixSubscriptionApi = __decorate([rtfm("api", "HelixSubscriptionApi")], HelixSubscriptionApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/team/HelixTeam.js
/**
* A Stream Team.
*/
let HelixTeam = class HelixTeam extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the team.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The name of the team.
	*/
	get name() {
		return this[rawDataSymbol].team_name;
	}
	/**
	* The display name of the team.
	*/
	get displayName() {
		return this[rawDataSymbol].team_display_name;
	}
	/**
	* The URL of the background image of the team.
	*/
	get backgroundImageUrl() {
		return this[rawDataSymbol].background_image_url;
	}
	/**
	* The URL of the banner of the team.
	*/
	get bannerUrl() {
		return this[rawDataSymbol].banner;
	}
	/**
	* The date when the team was created.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* The date when the team was last updated.
	*/
	get updateDate() {
		return new Date(this[rawDataSymbol].updated_at);
	}
	/**
	* The info of the team.
	*
	* May contain HTML tags.
	*/
	get info() {
		return this[rawDataSymbol].info;
	}
	/**
	* The URL of the thumbnail of the team's logo.
	*/
	get logoThumbnailUrl() {
		return this[rawDataSymbol].thumbnail_url;
	}
	/**
	* Gets the relations to the members of the team.
	*/
	async getUserRelations() {
		return (await this._client.teams.getTeamById(this.id)).userRelations;
	}
};
__decorate([Enumerable(false)], HelixTeam.prototype, "_client", void 0);
HelixTeam = __decorate([rtfm("api", "HelixTeam", "id")], HelixTeam);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/team/HelixTeamWithUsers.js
/**
* A Stream Team with its member relations.
*
* @inheritDoc
*/
let HelixTeamWithUsers = class HelixTeamWithUsers extends HelixTeam {
	/**
	* The relations to the members of the team.
	*/
	get userRelations() {
		return this[rawDataSymbol].users.map((data) => new HelixUserRelation(data, this._client));
	}
};
HelixTeamWithUsers = __decorate([rtfm("api", "HelixTeamWithUsers", "id")], HelixTeamWithUsers);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/team/HelixTeamApi.js
/**
* The Helix API methods that deal with teams.
*
* Can be accessed using `client.teams` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const tags = await api.teams.getChannelTeams('125328655');
* ```
*
* @meta category helix
* @meta categorizedTitle Teams
*/
let HelixTeamApi = class HelixTeamApi extends BaseApi {
	/**
	* Gets a list of all teams a broadcaster is a member of.
	*
	* @param broadcaster The broadcaster to get the teams of.
	*/
	async getTeamsForBroadcaster(broadcaster) {
		return (await this._client.callApi({
			type: "helix",
			url: "teams/channel",
			userId: extractUserId(broadcaster),
			query: createBroadcasterQuery(broadcaster)
		})).data?.map((data) => new HelixTeam(data, this._client)) ?? [];
	}
	/**
	* Gets a team by ID.
	*
	* Returns null if there is no team with the given ID.
	*
	* @param id The ID of the team.
	*/
	async getTeamById(id) {
		try {
			return new HelixTeamWithUsers((await this._client.callApi({
				type: "helix",
				url: "teams",
				query: { id }
			})).data[0], this._client);
		} catch (e) {
			if (e instanceof HttpStatusCodeError && e.statusCode === 500) return null;
			throw e;
		}
	}
	/**
	* Gets a team by name.
	*
	* Returns null if there is no team with the given name.
	*
	* @param name The name of the team.
	*/
	async getTeamByName(name) {
		try {
			return new HelixTeamWithUsers((await this._client.callApi({
				type: "helix",
				url: "teams",
				query: { name }
			})).data[0], this._client);
		} catch (e) {
			if (e instanceof HttpStatusCodeError && e.statusCode === 404) return null;
			throw e;
		}
	}
};
HelixTeamApi = __decorate([rtfm("api", "HelixTeamApi")], HelixTeamApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/user.external.js
/** @internal */
function createUserBlockCreateQuery(target, additionalInfo) {
	return {
		target_user_id: extractUserId(target),
		source_context: additionalInfo.sourceContext,
		reason: additionalInfo.reason
	};
}
/** @internal */
function createUserBlockDeleteQuery(target) {
	return { target_user_id: extractUserId(target) };
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/user/extensions/HelixBaseExtension.js
/** @protected */
var HelixBaseExtension = class extends DataObject {
	/**
	* The ID of the extension.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The version of the extension.
	*/
	get version() {
		return this[rawDataSymbol].version;
	}
	/**
	* The name of the extension.
	*/
	get name() {
		return this[rawDataSymbol].name;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/user/extensions/HelixInstalledExtension.js
/**
* A Twitch Extension that is installed in a slot of a channel.
*
* @inheritDoc
*/
let HelixInstalledExtension = class HelixInstalledExtension extends HelixBaseExtension {
	_slotType;
	_slotId;
	/** @internal */
	constructor(slotType, slotId, data) {
		super(data);
		this._slotType = slotType;
		this._slotId = slotId;
	}
	/**
	* The type of the slot the extension is in.
	*/
	get slotType() {
		return this._slotType;
	}
	/**
	* The ID of the slot the extension is in.
	*/
	get slotId() {
		return this._slotId;
	}
};
HelixInstalledExtension = __decorate([rtfm("api", "HelixInstalledExtension", "id")], HelixInstalledExtension);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/user/extensions/HelixInstalledExtensionList.js
/**
* A list of extensions installed in a channel.
*/
let HelixInstalledExtensionList = class HelixInstalledExtensionList extends DataObject {
	getExtensionAtSlot(type, slotId) {
		const data = this[rawDataSymbol][type][slotId];
		return data.active ? new HelixInstalledExtension(type, slotId, data) : null;
	}
	getExtensionsForSlotType(type) {
		return [...Object.entries(this[rawDataSymbol][type])].filter((entry) => entry[1].active).map(([slotId, slotData]) => new HelixInstalledExtension(type, slotId, slotData));
	}
	getAllExtensions() {
		return [...Object.entries(this[rawDataSymbol])].flatMap(([type, typeEntries]) => [...Object.entries(typeEntries)].filter((entry) => entry[1].active).map(([slotId, slotData]) => new HelixInstalledExtension(type, slotId, slotData)));
	}
};
HelixInstalledExtensionList = __decorate([rtfm("api", "HelixInstalledExtensionList")], HelixInstalledExtensionList);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/user/extensions/HelixUserExtension.js
/**
* A Twitch Extension that was installed by a user.
*
* @inheritDoc
*/
let HelixUserExtension = class HelixUserExtension extends HelixBaseExtension {
	/**
	* Whether the user has configured the extension to be able to activate it.
	*/
	get canActivate() {
		return this[rawDataSymbol].can_activate;
	}
	/**
	* The available types of the extension.
	*/
	get types() {
		return this[rawDataSymbol].type;
	}
};
HelixUserExtension = __decorate([rtfm("api", "HelixUserExtension", "id")], HelixUserExtension);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/user/HelixUser.js
/**
* A Twitch user.
*/
let HelixUser = class HelixUser extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the user.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The name of the user.
	*/
	get name() {
		return this[rawDataSymbol].login;
	}
	/**
	* The display name of the user.
	*/
	get displayName() {
		return this[rawDataSymbol].display_name;
	}
	/**
	* The description of the user.
	*/
	get description() {
		return this[rawDataSymbol].description;
	}
	/**
	* The type of the user.
	*/
	get type() {
		return this[rawDataSymbol].type;
	}
	/**
	* The type of the broadcaster.
	*/
	get broadcasterType() {
		return this[rawDataSymbol].broadcaster_type;
	}
	/**
	* The URL of the profile picture of the user.
	*/
	get profilePictureUrl() {
		return this[rawDataSymbol].profile_image_url;
	}
	/**
	* The URL of the offline video placeholder of the user.
	*/
	get offlinePlaceholderUrl() {
		return this[rawDataSymbol].offline_image_url;
	}
	/**
	* The date when the user was created, i.e. when they registered on Twitch.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* Gets the channel's stream data.
	*/
	async getStream() {
		return await this._client.streams.getStreamByUserId(this);
	}
	/**
	* Gets a list of broadcasters the user follows.
	*/
	async getFollowedChannels() {
		return await this._client.channels.getFollowedChannels(this);
	}
	/**
	* Gets the follow data of the user to the given broadcaster, or `null` if the user doesn't follow the broadcaster.
	*
	* This requires user authentication.
	* For broadcaster authentication, you can use `getChannelFollower` while switching `this` and the parameter.
	*
	* @param broadcaster The broadcaster to check the follow to.
	*/
	async getFollowedChannel(broadcaster) {
		return (await this._client.channels.getFollowedChannels(this, broadcaster)).data[0] ?? null;
	}
	/**
	* Checks whether the user is following the given broadcaster.
	*
	* This requires user authentication.
	* For broadcaster authentication, you can use `isFollowedBy` while switching `this` and the parameter.
	*
	* @param broadcaster The broadcaster to check the user's follow to.
	*/
	async follows(broadcaster) {
		return await this.getFollowedChannel(broadcaster) !== null;
	}
	/**
	* Gets a list of users that follow the broadcaster.
	*/
	async getChannelFollowers() {
		return await this._client.channels.getChannelFollowers(this);
	}
	/**
	* Gets the follow data of the given user to the broadcaster, or `null` if the user doesn't follow the broadcaster.
	*
	* This requires broadcaster authentication.
	* For user authentication, you can use `getFollowedChannel` while switching `this` and the parameter.
	*
	* @param user The user to check the follow from.
	*/
	async getChannelFollower(user) {
		return (await this._client.channels.getChannelFollowers(this, user)).data[0] ?? null;
	}
	/**
	* Checks whether the given user is following the broadcaster.
	*
	* This requires broadcaster authentication.
	* For user authentication, you can use `follows` while switching `this` and the parameter.
	*
	* @param user The user to check the broadcaster's follow from.
	*/
	async isFollowedBy(user) {
		return await this.getChannelFollower(user) !== null;
	}
	/**
	* Gets the subscription data for the user to the given broadcaster, or `null` if the user is not subscribed.
	*
	* This requires user authentication.
	* For broadcaster authentication, you can use `getSubscriber` while switching `this` and the parameter.
	*
	* @param broadcaster The broadcaster you want to get the subscription data for.
	*/
	async getSubscriptionTo(broadcaster) {
		return await this._client.subscriptions.checkUserSubscription(this, broadcaster);
	}
	/**
	* Checks whether the user is subscribed to the given broadcaster.
	*
	* This requires user authentication.
	* For broadcaster authentication, you can use `hasSubscriber` while switching `this` and the parameter.
	*
	* @param broadcaster The broadcaster you want to check the subscription for.
	*/
	async isSubscribedTo(broadcaster) {
		return await this.getSubscriptionTo(broadcaster) !== null;
	}
	/**
	* Gets the subscription data for the given user to the broadcaster, or `null` if the user is not subscribed.
	*
	* This requires broadcaster authentication.
	* For user authentication, you can use `getSubscriptionTo` while switching `this` and the parameter.
	*
	* @param user The user you want to get the subscription data for.
	*/
	async getSubscriber(user) {
		return await this._client.subscriptions.getSubscriptionForUser(this, user);
	}
	/**
	* Checks whether the given user is subscribed to the broadcaster.
	*
	* This requires broadcaster authentication.
	* For user authentication, you can use `isSubscribedTo` while switching `this` and the parameter.
	*
	* @param user The user you want to check the subscription for.
	*/
	async hasSubscriber(user) {
		return await this.getSubscriber(user) !== null;
	}
};
__decorate([Enumerable(false)], HelixUser.prototype, "_client", void 0);
HelixUser = __decorate([rtfm("api", "HelixUser", "id")], HelixUser);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/user/HelixPrivilegedUser.js
/**
* A user you have extended privilges for, i.e. yourself.
*
* @inheritDoc
*/
let HelixPrivilegedUser = class HelixPrivilegedUser extends HelixUser {
	/**
	* The email address of the user.
	*/
	get email() {
		return this[rawDataSymbol].email;
	}
	/**
	* Changes the description of the user.
	*
	* @param description The new description.
	*/
	async setDescription(description) {
		return await this._client.users.updateAuthenticatedUser(this, { description });
	}
};
HelixPrivilegedUser = __decorate([rtfm("api", "HelixPrivilegedUser", "id")], HelixPrivilegedUser);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/user/HelixUserBlock.js
/**
* An user blocked by a previously given user.
*/
let HelixUserBlock = class HelixUserBlock extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the blocked user.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the blocked user.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the blocked user.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].display_name;
	}
	/**
	* Gets additional information about the blocked user.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
};
__decorate([Enumerable(false)], HelixUserBlock.prototype, "_client", void 0);
HelixUserBlock = __decorate([rtfm("api", "HelixUserBlock", "userId")], HelixUserBlock);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/user/HelixUserApi.js
/**
* The Helix API methods that deal with users.
*
* Can be accessed using `client.users` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const user = await api.users.getUserById('125328655');
* ```
*
* @meta category helix
* @meta categorizedTitle Users
*/
let HelixUserApi = class HelixUserApi extends BaseApi {
	/** @internal */
	_getUserByIdBatcher = new HelixRequestBatcher({ url: "users" }, "id", "id", this._client, (data) => new HelixUser(data, this._client));
	/** @internal */
	_getUserByNameBatcher = new HelixRequestBatcher({ url: "users" }, "login", "login", this._client, (data) => new HelixUser(data, this._client));
	/**
	* Gets the user data for the given list of user IDs.
	*
	* @param userIds The user IDs you want to look up.
	*/
	async getUsersByIds(userIds) {
		return await this._getUsers("id", userIds.map(extractUserId));
	}
	/**
	* Gets the user data for the given list of usernames.
	*
	* @param userNames The usernames you want to look up.
	*/
	async getUsersByNames(userNames) {
		return await this._getUsers("login", userNames.map(extractUserName));
	}
	/**
	* Gets the user data for the given user ID.
	*
	* @param user The user ID you want to look up.
	*/
	async getUserById(user) {
		const userId = extractUserId(user);
		return mapNullable((await this._client.callApi({
			type: "helix",
			url: "users",
			userId,
			query: { id: userId }
		})).data[0], (data) => new HelixUser(data, this._client));
	}
	/**
	* Gets the user data for the given user ID, batching multiple calls into fewer requests as the API allows.
	*
	* @param user The user ID you want to look up.
	*/
	async getUserByIdBatched(user) {
		return await this._getUserByIdBatcher.request(extractUserId(user));
	}
	/**
	* Gets the user data for the given username.
	*
	* @param userName The username you want to look up.
	*/
	async getUserByName(userName) {
		const users = await this._getUsers("login", [extractUserName(userName)]);
		return users.length ? users[0] : null;
	}
	/**
	* Gets the user data for the given username, batching multiple calls into fewer requests as the API allows.
	*
	* @param user The username you want to look up.
	*/
	async getUserByNameBatched(user) {
		return await this._getUserByNameBatcher.request(extractUserName(user));
	}
	/**
	* Gets the user data of the given authenticated user.
	*
	* @param user The user to get data for.
	* @param withEmail Whether you need the user's email address.
	*/
	async getAuthenticatedUser(user, withEmail = false) {
		const result = await this._client.callApi({
			type: "helix",
			url: "users",
			forceType: "user",
			userId: extractUserId(user),
			scopes: withEmail ? ["user:read:email"] : void 0
		});
		if (!result.data?.length) throw new HellFreezesOverError("Could not get authenticated user");
		return new HelixPrivilegedUser(result.data[0], this._client);
	}
	/**
	* Updates the given authenticated user's data.
	*
	* @param user The user to update.
	* @param data The data to update.
	*/
	async updateAuthenticatedUser(user, data) {
		return new HelixPrivilegedUser((await this._client.callApi({
			type: "helix",
			url: "users",
			method: "PUT",
			userId: extractUserId(user),
			scopes: ["user:edit"],
			query: { description: data.description }
		})).data[0], this._client);
	}
	/**
	* Gets a list of users blocked by the given user.
	*
	* @param user The user to get blocks for.
	* @param pagination
	*
	* @expandParams
	*/
	async getBlocks(user, pagination) {
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "users/blocks",
			userId: extractUserId(user),
			scopes: ["user:read:blocked_users"],
			query: {
				...createBroadcasterQuery(user),
				...createPaginationQuery(pagination)
			}
		}), HelixUserBlock, this._client);
	}
	/**
	* Creates a paginator for users blocked by the given user.
	*
	* @param user The user to get blocks for.
	*/
	getBlocksPaginated(user) {
		return new HelixPaginatedRequest({
			url: "users/blocks",
			userId: extractUserId(user),
			scopes: ["user:read:blocked_users"],
			query: createBroadcasterQuery(user)
		}, this._client, (data) => new HelixUserBlock(data, this._client));
	}
	/**
	* Blocks the given user.
	*
	* @param broadcaster The user to add the block to.
	* @param target The user to block.
	* @param additionalInfo Additional info to give context to the block.
	*
	* @expandParams
	*/
	async createBlock(broadcaster, target, additionalInfo = {}) {
		await this._client.callApi({
			type: "helix",
			url: "users/blocks",
			method: "PUT",
			userId: extractUserId(broadcaster),
			scopes: ["user:manage:blocked_users"],
			query: createUserBlockCreateQuery(target, additionalInfo)
		});
	}
	/**
	* Unblocks the given user.
	*
	* @param broadcaster The user to remove the block from.
	* @param target The user to unblock.
	*/
	async deleteBlock(broadcaster, target) {
		await this._client.callApi({
			type: "helix",
			url: "users/blocks",
			method: "DELETE",
			userId: extractUserId(broadcaster),
			scopes: ["user:manage:blocked_users"],
			query: createUserBlockDeleteQuery(target)
		});
	}
	/**
	* Gets a list of all extensions for the given authenticated user.
	*
	* @param broadcaster The broadcaster to get the list of extensions for.
	* @param withInactive Whether to include inactive extensions.
	*/
	async getExtensionsForAuthenticatedUser(broadcaster, withInactive = false) {
		return (await this._client.callApi({
			type: "helix",
			url: "users/extensions/list",
			userId: extractUserId(broadcaster),
			scopes: withInactive ? ["channel:manage:extensions"] : ["user:read:broadcast", "channel:manage:extensions"]
		})).data.map((data) => new HelixUserExtension(data));
	}
	/**
	* Gets a list of all installed extensions for the given user.
	*
	* @param user The user to get the installed extensions for.
	* @param withDev Whether to include extensions that are in development.
	*/
	async getActiveExtensions(user, withDev = false) {
		const userId = extractUserId(user);
		return new HelixInstalledExtensionList((await this._client.callApi({
			type: "helix",
			url: "users/extensions",
			userId,
			scopes: withDev ? ["user:read:broadcast", "channel:manage:extensions"] : void 0,
			query: createSingleKeyQuery("user_id", userId)
		})).data);
	}
	/**
	* Updates the installed extensions for the given authenticated user.
	*
	* @param broadcaster The user to update the installed extensions for.
	* @param data The extension installation payload.
	*
	* The format is shown on the [Twitch documentation](https://dev.twitch.tv/docs/api/reference#update-user-extensions).
	* Don't use the "data" wrapper though.
	*/
	async updateActiveExtensionsForAuthenticatedUser(broadcaster, data) {
		return new HelixInstalledExtensionList((await this._client.callApi({
			type: "helix",
			url: "users/extensions",
			method: "PUT",
			userId: extractUserId(broadcaster),
			scopes: ["channel:manage:extensions"],
			jsonBody: { data }
		})).data);
	}
	async _getUsers(lookupType, param) {
		if (param.length === 0) return [];
		const query = { [lookupType]: param };
		return (await this._client.callApi({
			type: "helix",
			url: "users",
			query
		})).data.map((userData) => new HelixUser(userData, this._client));
	}
};
__decorate([Enumerable(false)], HelixUserApi.prototype, "_getUserByIdBatcher", void 0);
__decorate([Enumerable(false)], HelixUserApi.prototype, "_getUserByNameBatcher", void 0);
HelixUserApi = __decorate([rtfm("api", "HelixUserApi")], HelixUserApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/video/HelixVideo.js
/**
* A video on Twitch.
*/
let HelixVideo = class HelixVideo extends DataObject {
	/** @internal */ _client;
	/** @internal */
	constructor(data, client) {
		super(data);
		this._client = client;
	}
	/**
	* The ID of the video.
	*/
	get id() {
		return this[rawDataSymbol].id;
	}
	/**
	* The ID of the user who created the video.
	*/
	get userId() {
		return this[rawDataSymbol].user_id;
	}
	/**
	* The name of the user who created the video.
	*/
	get userName() {
		return this[rawDataSymbol].user_login;
	}
	/**
	* The display name of the user who created the video.
	*/
	get userDisplayName() {
		return this[rawDataSymbol].user_name;
	}
	/**
	* Gets information about the user who created the video.
	*/
	async getUser() {
		return checkRelationAssertion(await this._client.users.getUserById(this[rawDataSymbol].user_id));
	}
	/**
	* The title of the video.
	*/
	get title() {
		return this[rawDataSymbol].title;
	}
	/**
	* The description of the video.
	*/
	get description() {
		return this[rawDataSymbol].description;
	}
	/**
	* The date when the video was created.
	*/
	get creationDate() {
		return new Date(this[rawDataSymbol].created_at);
	}
	/**
	* The date when the video was published.
	*/
	get publishDate() {
		return new Date(this[rawDataSymbol].published_at);
	}
	/**
	* The URL of the video.
	*/
	get url() {
		return this[rawDataSymbol].url;
	}
	/**
	* The URL of the thumbnail of the video.
	*/
	get thumbnailUrl() {
		return this[rawDataSymbol].thumbnail_url;
	}
	/**
	* Builds the thumbnail URL of the video using the given dimensions.
	*
	* @param width The width of the thumbnail.
	* @param height The height of the thumbnail.
	*/
	getThumbnailUrl(width, height) {
		return this[rawDataSymbol].thumbnail_url.replace("%{width}", width.toString()).replace("%{height}", height.toString());
	}
	/**
	* Whether the video is public or not.
	*/
	get isPublic() {
		return this[rawDataSymbol].viewable === "public";
	}
	/**
	* The number of views of the video.
	*/
	get views() {
		return this[rawDataSymbol].view_count;
	}
	/**
	* The language of the video.
	*/
	get language() {
		return this[rawDataSymbol].language;
	}
	/**
	* The type of the video.
	*/
	get type() {
		return this[rawDataSymbol].type;
	}
	/**
	* The duration of the video, as formatted by Twitch.
	*/
	get duration() {
		return this[rawDataSymbol].duration;
	}
	/**
	* The duration of the video, in seconds.
	*/
	get durationInSeconds() {
		const parts = this[rawDataSymbol].duration.match(/\d+[hms]/g);
		if (!parts) throw new HellFreezesOverError(`Could not parse duration string: ${this[rawDataSymbol].duration}`);
		return parts.map((part) => {
			const partialMatch = /(\d+)([hms])/.exec(part);
			if (!partialMatch) throw new HellFreezesOverError(`Could not parse partial duration string: ${part}`);
			const [, num, unit] = partialMatch;
			return parseInt(num, 10) * {
				h: 3600,
				m: 60,
				s: 1
			}[unit];
		}).reduce((a, b) => a + b);
	}
	/**
	* The ID of the stream this video belongs to.
	*
	* Returns null if the video is not an archived stream.
	*/
	get streamId() {
		return this[rawDataSymbol].stream_id;
	}
	/**
	* The raw data of muted segments of the video.
	*/
	get mutedSegmentData() {
		return this[rawDataSymbol].muted_segments?.slice() ?? [];
	}
	/**
	* Checks whether the video is muted at a given offset or range.
	*
	* @param offset The start of your range, in seconds from the start of the video,
	* or if no duration is given, the exact offset that is checked.
	* @param duration The duration of your range, in seconds.
	* @param partial Whether the range check is only partial.
	*
	* By default, this function returns true only if the passed range is entirely contained in a muted segment.
	*/
	isMutedAt(offset, duration, partial = false) {
		if (this[rawDataSymbol].muted_segments === null) return false;
		if (duration == null) return this[rawDataSymbol].muted_segments.some((seg) => seg.offset <= offset && offset <= seg.offset + seg.duration);
		const end = offset + duration;
		if (partial) return this[rawDataSymbol].muted_segments.some((seg) => {
			return offset < seg.offset + seg.duration && seg.offset < end;
		});
		return this[rawDataSymbol].muted_segments.some((seg) => {
			const segEnd = seg.offset + seg.duration;
			return seg.offset <= offset && end <= segEnd;
		});
	}
};
__decorate([Enumerable(false)], HelixVideo.prototype, "_client", void 0);
__decorate([CachedGetter()], HelixVideo.prototype, "durationInSeconds", null);
HelixVideo = __decorate([Cacheable, rtfm("api", "HelixVideo", "id")], HelixVideo);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/video/HelixVideoApi.js
var HelixVideoApi_1;
/**
* The Helix API methods that deal with videos.
*
* Can be accessed using `client.videos` on an {@link ApiClient} instance.
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* const { data: videos } = await api.videos.getVideosByUser('125328655');
* ```
*
* @meta category helix
* @meta categorizedTitle Videos
*/
let HelixVideoApi = HelixVideoApi_1 = class HelixVideoApi extends BaseApi {
	/** @internal */
	_getVideoByIdBatcher = new HelixRequestBatcher({ url: "videos" }, "id", "id", this._client, (data) => new HelixVideo(data, this._client));
	/**
	* Gets the video data for the given list of video IDs.
	*
	* @param ids The video IDs you want to look up.
	*/
	async getVideosByIds(ids) {
		return (await this._getVideos("id", ids)).data;
	}
	/**
	* Gets the video data for the given video ID.
	*
	* @param id The video ID you want to look up.
	*/
	async getVideoById(id) {
		const videos = await this.getVideosByIds([id]);
		return videos.length ? videos[0] : null;
	}
	/**
	* Gets the video data for the given video ID, batching multiple calls into fewer requests as the API allows.
	*
	* @param id The video ID you want to look up.
	*/
	async getVideoByIdBatched(id) {
		return await this._getVideoByIdBatcher.request(id);
	}
	/**
	* Gets the videos of the given user.
	*
	* @param user The user you want to get videos from.
	* @param filter
	*
	* @expandParams
	*/
	async getVideosByUser(user, filter = {}) {
		const userId = extractUserId(user);
		return await this._getVideos("user_id", [userId], filter);
	}
	/**
	* Creates a paginator for videos of the given user.
	*
	* @param user The user you want to get videos from.
	* @param filter
	*
	* @expandParams
	*/
	getVideosByUserPaginated(user, filter = {}) {
		const userId = extractUserId(user);
		return this._getVideosPaginated("user_id", [userId], filter);
	}
	/**
	* Gets the videos of the given game.
	*
	* @param gameId The game you want to get videos from.
	* @param filter
	*
	* @expandParams
	*/
	async getVideosByGame(gameId, filter = {}) {
		return await this._getVideos("game_id", [gameId], filter);
	}
	/**
	* Creates a paginator for videos of the given game.
	*
	* @param gameId The game you want to get videos from.
	* @param filter
	*
	* @expandParams
	*/
	getVideosByGamePaginated(gameId, filter = {}) {
		return this._getVideosPaginated("game_id", [gameId], filter);
	}
	/**
	* Deletes videos by its IDs.
	*
	* @param broadcaster The broadcaster to delete the videos for.
	* @param ids The IDs of the videos to delete.
	*/
	async deleteVideosByIds(broadcaster, ids) {
		await this._client.callApi({
			type: "helix",
			url: "videos",
			method: "DELETE",
			scopes: ["channel:manage:videos"],
			userId: extractUserId(broadcaster),
			query: { id: ids }
		});
	}
	/** @internal */
	async _getVideos(filterType, filterValues, filter = {}) {
		if (!filterValues.length) return { data: [] };
		return createPaginatedResult(await this._client.callApi({
			type: "helix",
			url: "videos",
			userId: filterType === "user_id" ? filterValues[0] : void 0,
			query: {
				...HelixVideoApi_1._makeVideosQuery(filterType, filterValues, filter),
				...createPaginationQuery(filter)
			}
		}), HelixVideo, this._client);
	}
	/** @internal */
	_getVideosPaginated(filterType, filterValues, filter = {}) {
		return new HelixPaginatedRequest({
			url: "videos",
			userId: filterType === "user_id" ? filterValues[0] : void 0,
			query: HelixVideoApi_1._makeVideosQuery(filterType, filterValues, filter)
		}, this._client, (data) => new HelixVideo(data, this._client));
	}
	/** @internal */
	static _makeVideosQuery(filterType, filterValues, filter = {}) {
		const { language, period, orderBy, type } = filter;
		return {
			[filterType]: filterValues,
			language,
			period,
			sort: orderBy,
			type
		};
	}
};
__decorate([Enumerable(false)], HelixVideoApi.prototype, "_getVideoByIdBatcher", void 0);
HelixVideoApi = HelixVideoApi_1 = __decorate([rtfm("api", "HelixVideoApi")], HelixVideoApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/interfaces/endpoints/whisper.external.js
/** @internal */
function createWhisperQuery(from, to) {
	return {
		from_user_id: extractUserId(from),
		to_user_id: extractUserId(to)
	};
}
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/endpoints/whisper/HelixWhisperApi.js
/**
* The API methods that deal with whispers.
*
* Can be accessed using 'client.whispers' on an {@link ApiClient} instance
*
* ## Example
* ```ts
* const api = new ApiClient({ authProvider });
* await api.whispers.sendWhisper('61369223', '86753099', 'Howdy, partner!');
* ```
*
* @meta category helix
* @meta categorizedTitle Whispers
*/
let HelixWhisperApi = class HelixWhisperApi extends BaseApi {
	/**
	* Sends a whisper message to the specified user.
	*
	* NOTE: The API may silently drop whispers that it suspects of violating Twitch policies. (The API does not indicate that it dropped the whisper; it returns a 204 status code as if it succeeded).
	*
	* @param from The user sending the whisper. This user must have a verified phone number and must match the user in the access token.
	* @param to The user to receive the whisper.
	* @param message The whisper message to send. The message must not be empty.
	*
	* The maximum message lengths are:
	*
	* 500 characters if the user you're sending the message to hasn't whispered you before.
	* 10,000 characters if the user you're sending the message to has whispered you before.
	*
	* Messages that exceed the maximum length are truncated.
	*/
	async sendWhisper(from, to, message) {
		await this._client.callApi({
			type: "helix",
			url: "whispers",
			method: "POST",
			userId: extractUserId(from),
			scopes: ["user:manage:whispers"],
			query: createWhisperQuery(from, to),
			jsonBody: { message }
		});
	}
};
HelixWhisperApi = __decorate([rtfm("api", "HelixWhisperApi")], HelixWhisperApi);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/reporting/ApiReportedRequest.js
/**
* Reporting details for an API request.
*/
var ApiReportedRequest = class {
	_options;
	_httpStatus;
	_resolvedUserId;
	/** @internal */
	constructor(_options, _httpStatus, _resolvedUserId) {
		this._options = _options;
		this._httpStatus = _httpStatus;
		this._resolvedUserId = _resolvedUserId;
	}
	/**
	* The options used to call the API.
	*/
	get options() {
		return this._options;
	}
	/**
	* The HTTP status code returned by Twitch for the request.
	*/
	get httpStatus() {
		return this._httpStatus;
	}
	/**
	* The ID of the user that was used for authentication, or `null` if an app access token was used.
	*/
	get resolvedUserId() {
		return this._resolvedUserId;
	}
};
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/client/BaseApiClient.js
var import_retry = /* @__PURE__ */ __toESM(require_retry(), 1);
/** @private */
let BaseApiClient = class BaseApiClient extends EventEmitter {
	_config;
	_logger;
	_rateLimiter;
	onRequest = this.registerEvent();
	/** @internal */
	constructor(config, logger, rateLimiter) {
		super();
		this._config = config;
		this._logger = logger;
		this._rateLimiter = rateLimiter;
	}
	/**
	* Requests scopes from the auth provider for the given user.
	*
	* @param user The user to request scopes for.
	* @param scopes The scopes to request.
	*/
	async requestScopesForUser(user, scopes) {
		await this._config.authProvider.getAccessTokenForUser(user, ...scopes.map((scope) => [scope]));
	}
	/**
	* Gets information about your access token.
	*/
	async getTokenInfo() {
		try {
			return new TokenInfo(await this.callApi({
				type: "auth",
				url: "validate"
			}));
		} catch (e) {
			if (e instanceof HttpStatusCodeError && e.statusCode === 401) throw new InvalidTokenError({ cause: e });
			throw e;
		}
	}
	/**
	* Makes a call to the Twitch API using your access token.
	*
	* @param options The configuration of the call.
	*/
	async callApi(options) {
		const { authProvider } = this._config;
		if (!(options.auth ?? true)) return await callTwitchApi(options, authProvider.clientId, void 0, void 0, this._config.fetchOptions);
		let forceUser = false;
		if (options.forceType) switch (options.forceType) {
			case "app": {
				if (!authProvider.getAppAccessToken) throw new Error("Tried to make an API call that requires an app access token but your auth provider does not support that");
				const accessToken = await authProvider.getAppAccessToken();
				return await this._callApiUsingInitialToken(options, accessToken);
			}
			case "user":
				forceUser = true;
				break;
			default: throw new HellFreezesOverError(`Unknown forced token type: ${options.forceType}`);
		}
		if (options.scopes) forceUser = true;
		if (forceUser) {
			const contextUserId = options.canOverrideScopedUserContext ? this._getUserIdFromRequestContext(options.userId) : options.userId;
			if (!contextUserId) throw new Error("Tried to make an API call with a user context but no context user ID");
			const accessToken = await authProvider.getAccessTokenForUser(contextUserId, options.scopes);
			if (!accessToken) throw new Error(`Tried to make an API call with a user context for user ID ${contextUserId} but no token was found`);
			if (accessTokenIsExpired(accessToken) && authProvider.refreshAccessTokenForUser) {
				const newAccessToken = await authProvider.refreshAccessTokenForUser(contextUserId);
				return await this._callApiUsingInitialToken(options, newAccessToken, true);
			}
			return await this._callApiUsingInitialToken(options, accessToken);
		}
		const requestContextUserId = this._getUserIdFromRequestContext(options.userId);
		const accessToken = requestContextUserId === null ? await authProvider.getAnyAccessToken() : await authProvider.getAnyAccessToken(requestContextUserId ?? options.userId);
		if (accessTokenIsExpired(accessToken) && accessToken.userId && authProvider.refreshAccessTokenForUser) {
			const newAccessToken = await authProvider.refreshAccessTokenForUser(accessToken.userId);
			return await this._callApiUsingInitialToken(options, newAccessToken, true);
		}
		return await this._callApiUsingInitialToken(options, accessToken);
	}
	/**
	* The Helix bits API methods.
	*/
	get bits() {
		return new HelixBitsApi(this);
	}
	/**
	* The Helix channels API methods.
	*/
	get channels() {
		return new HelixChannelApi(this);
	}
	/**
	* The Helix channel points API methods.
	*/
	get channelPoints() {
		return new HelixChannelPointsApi(this);
	}
	/**
	* The Helix charity API methods.
	*/
	get charity() {
		return new HelixCharityApi(this);
	}
	/**
	* The Helix chat API methods.
	*/
	get chat() {
		return new HelixChatApi(this);
	}
	/**
	* The Helix clips API methods.
	*/
	get clips() {
		return new HelixClipApi(this);
	}
	/**
	* The Helix content classification label API methods.
	*/
	get contentClassificationLabels() {
		return new HelixContentClassificationLabelApi(this);
	}
	/**
	* The Helix entitlement API methods.
	*/
	get entitlements() {
		return new HelixEntitlementApi(this);
	}
	/**
	* The Helix EventSub API methods.
	*/
	get eventSub() {
		return new HelixEventSubApi(this);
	}
	/**
	* The Helix extensions API methods.
	*/
	get extensions() {
		return new HelixExtensionsApi(this);
	}
	/**
	* The Helix game API methods.
	*/
	get games() {
		return new HelixGameApi(this);
	}
	/**
	* The Helix Hype Train API methods.
	*/
	get hypeTrain() {
		return new HelixHypeTrainApi(this);
	}
	/**
	* The Helix goal API methods.
	*/
	get goals() {
		return new HelixGoalApi(this);
	}
	/**
	* The Helix moderation API methods.
	*/
	get moderation() {
		return new HelixModerationApi(this);
	}
	/**
	* The Helix poll API methods.
	*/
	get polls() {
		return new HelixPollApi(this);
	}
	/**
	* The Helix prediction API methods.
	*/
	get predictions() {
		return new HelixPredictionApi(this);
	}
	/**
	* The Helix raid API methods.
	*/
	get raids() {
		return new HelixRaidApi(this);
	}
	/**
	* The Helix schedule API methods.
	*/
	get schedule() {
		return new HelixScheduleApi(this);
	}
	/**
	* The Helix search API methods.
	*/
	get search() {
		return new HelixSearchApi(this);
	}
	/**
	* The Helix stream API methods.
	*/
	get streams() {
		return new HelixStreamApi(this);
	}
	/**
	* The Helix subscription API methods.
	*/
	get subscriptions() {
		return new HelixSubscriptionApi(this);
	}
	/**
	* The Helix team API methods.
	*/
	get teams() {
		return new HelixTeamApi(this);
	}
	/**
	* The Helix user API methods.
	*/
	get users() {
		return new HelixUserApi(this);
	}
	/**
	* The Helix video API methods.
	*/
	get videos() {
		return new HelixVideoApi(this);
	}
	/**
	* The API methods that deal with whispers.
	*/
	get whispers() {
		return new HelixWhisperApi(this);
	}
	/**
	* Statistics on the rate limiter for the Helix API.
	*/
	get rateLimiterStats() {
		if (this._rateLimiter instanceof ResponseBasedRateLimiter) return this._rateLimiter.stats;
		return null;
	}
	/** @private */
	get _authProvider() {
		return this._config.authProvider;
	}
	/** @internal */
	get _batchDelay() {
		return this._config.batchDelay ?? 0;
	}
	/** @internal */
	_getUserIdFromRequestContext(contextUserId) {
		return contextUserId;
	}
	async _callApiUsingInitialToken(options, accessToken, wasRefreshed = false) {
		const { authProvider } = this._config;
		const { authorizationType } = authProvider;
		let response = await this._callApiInternal(options, authProvider.clientId, accessToken.accessToken, authorizationType);
		if (response.status === 401 && !wasRefreshed) {
			if (accessToken.userId) {
				if (authProvider.refreshAccessTokenForUser) {
					const token = await authProvider.refreshAccessTokenForUser(accessToken.userId);
					response = await this._callApiInternal(options, authProvider.clientId, token.accessToken, authorizationType);
				}
			} else if (authProvider.getAppAccessToken) {
				const token = await authProvider.getAppAccessToken(true);
				response = await this._callApiInternal(options, authProvider.clientId, token.accessToken, authorizationType);
			}
		}
		this.emit(this.onRequest, new ApiReportedRequest(options, response.status, accessToken.userId ?? null));
		await handleTwitchApiResponseError(response, options);
		return await transformTwitchApiResponse(response);
	}
	async _callApiInternal(options, clientId, accessToken, authorizationType) {
		const { fetchOptions } = this._config;
		const type = options.type ?? "helix";
		this._logger.debug(`Calling ${type} API: ${options.method ?? "GET"} ${options.url}`);
		this._logger.trace(`Query: ${JSON.stringify(options.query)}`);
		if (options.jsonBody) this._logger.trace(`Request body: ${JSON.stringify(options.jsonBody)}`);
		const op = import_retry.operation({
			retries: 3,
			minTimeout: 500,
			factor: 2
		});
		const { promise, resolve, reject } = promiseWithResolvers();
		op.attempt(async () => {
			try {
				const response = type === "helix" ? await this._rateLimiter.request({
					options,
					clientId,
					accessToken,
					authorizationType,
					fetchOptions
				}) : await callTwitchApiRaw(options, clientId, accessToken, authorizationType, fetchOptions);
				if (!response.ok && response.status >= 500 && response.status < 600) await handleTwitchApiResponseError(response, options);
				resolve(response);
			} catch (e) {
				if (op.retry(e)) return;
				reject(op.mainError());
			}
		});
		const result = await promise;
		this._logger.debug(`Called ${type} API: ${options.method ?? "GET"} ${options.url} - result: ${result.status}`);
		return result;
	}
};
__decorate([CachedGetter()], BaseApiClient.prototype, "bits", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "channels", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "channelPoints", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "charity", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "chat", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "clips", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "contentClassificationLabels", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "entitlements", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "eventSub", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "extensions", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "games", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "hypeTrain", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "goals", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "moderation", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "polls", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "predictions", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "raids", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "schedule", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "search", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "streams", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "subscriptions", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "teams", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "users", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "videos", null);
__decorate([CachedGetter()], BaseApiClient.prototype, "whispers", null);
BaseApiClient = __decorate([Cacheable, rtfm("api", "ApiClient")], BaseApiClient);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/client/NoContextApiClient.js
/** @private */
let NoContextApiClient = class NoContextApiClient extends BaseApiClient {
	/** @internal */
	_getUserIdFromRequestContext() {
		return null;
	}
};
NoContextApiClient = __decorate([rtfm("api", "ApiClient")], NoContextApiClient);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/client/UserContextApiClient.js
/** @private */
let UserContextApiClient = class UserContextApiClient extends BaseApiClient {
	_userId;
	/** @internal */
	constructor(config, logger, rateLimiter, _userId) {
		super(config, logger, rateLimiter);
		this._userId = _userId;
	}
	/** @internal */
	_getUserIdFromRequestContext() {
		return this._userId;
	}
};
UserContextApiClient = __decorate([rtfm("api", "ApiClient")], UserContextApiClient);
//#endregion
//#region node_modules/.pnpm/@twurple+api@8.0.3_@twurple+auth@8.0.3/node_modules/@twurple/api/lib/client/ApiClient.js
var import_detect_node = require_detect_node();
/**
* An API client for the Twitch Helix API and other miscellaneous endpoints.
*
* @meta category main
* @hideProtected
*/
let ApiClient = class ApiClient extends BaseApiClient {
	/**
	* Creates a new API client instance.
	*
	* @param config Configuration for the client instance.
	*/
	constructor(config) {
		if (!config.authProvider) throw new ConfigError("No auth provider given. Please supply the `authProvider` option.");
		const rateLimitLoggerOptions = {
			name: "twurple:api:rate-limiter",
			...config.logger
		};
		super(config, createLogger$1({
			name: "twurple:api:client",
			...config.logger
		}), import_detect_node.isNode ? new PartitionedRateLimiter({
			getPartitionKey: (req) => req.userId ?? null,
			createChild: () => new HelixRateLimiter({ logger: rateLimitLoggerOptions })
		}) : new PartitionedTimeBasedRateLimiter({
			logger: rateLimitLoggerOptions,
			bucketSize: 800,
			timeFrame: 64e3,
			doRequest: async ({ options, clientId, accessToken, authorizationType, fetchOptions }) => await callTwitchApiRaw(options, clientId, accessToken, authorizationType, fetchOptions),
			getPartitionKey: (req) => req.userId ?? null
		}));
	}
	/**
	* Creates a contextualized ApiClient that can be used to call the API in the context of a given user.
	*
	* @param user The user to use as context.
	* @param runner The callback to execute.
	*
	* A parameter is passed that should be used in place of the normal `ApiClient`
	* to ensure that all requests are executed in the given user's context.
	*
	* Please note that requests which require scope authorization ignore this context.
	*
	* The return value of your callback will be propagated to the return value of this method.
	*/
	async asUser(user, runner) {
		return await runner(new UserContextApiClient(this._config, this._logger, this._rateLimiter, extractUserId(user)));
	}
	/**
	* Creates a contextualized ApiClient that can be used to call the API in the context of a given intent.
	*
	* @param intents A list of intents. The first one that is found in your auth provider will be used.
	* @param runner The callback to execute.
	*
	* A parameter is passed that should be used in place of the normal `ApiClient`
	* to ensure that all requests are executed in the given user's context.
	*
	* Please note that requests which require scope authorization ignore this context.
	*
	* The return value of your callback will be propagated to the return value of this method.
	*/
	async asIntent(intents, runner) {
		if (!this._authProvider.getAccessTokenForIntent) throw new Error("Trying to use intents with an auth provider that does not support them");
		for (const intent of intents) {
			const user = await this._authProvider.getAccessTokenForIntent(intent);
			if (user) return await runner(new UserContextApiClient(this._config, this._logger, this._rateLimiter, user.userId));
		}
		throw new Error(`Intents [${intents.join(", ")}] not found in auth provider`);
	}
	/**
	* Creates a contextualized ApiClient that can be used to call the API without the context of any user.
	*
	* This usually means that an app access token is used.
	*
	* @param runner The callback to execute.
	*
	* A parameter is passed that should be used in place of the normal `ApiClient`
	* to ensure that all requests are executed without user context.
	*
	* Please note that requests which require scope authorization ignore this context erasure.
	*
	* The return value of your callback will be propagated to the return value of this method.
	*/
	async withoutUser(runner) {
		return await runner(new NoContextApiClient(this._config, this._logger, this._rateLimiter));
	}
};
ApiClient = __decorate([rtfm("api", "ApiClient")], ApiClient);
//#endregion
//#region extensions/twitch/src/resolver.ts
/**
* Twitch resolver adapter for channel/user name resolution.
*
* This module implements the ChannelResolverAdapter interface to resolve
* Twitch usernames to user IDs via the Twitch Helix API.
*/
/**
* Normalize a Twitch username - strip @ prefix and convert to lowercase
*/
function normalizeUsername(input) {
	const trimmed = input.trim();
	if (trimmed.startsWith("@")) return trimmed.slice(1).toLowerCase();
	return trimmed.toLowerCase();
}
/**
* Create a logger that includes the Twitch prefix
*/
function createLogger(logger) {
	return {
		info: (msg) => logger?.info(msg),
		warn: (msg) => logger?.warn(msg),
		error: (msg) => logger?.error(msg),
		debug: (msg) => logger?.debug?.(msg) ?? (() => {})
	};
}
/**
* Resolve Twitch usernames to user IDs via the Helix API
*
* @param inputs - Array of usernames or user IDs to resolve
* @param account - Twitch account configuration with auth credentials
* @param kind - Type of target to resolve ("user" or "group")
* @param logger - Optional logger
* @returns Promise resolving to array of ChannelResolveResult
*/
async function resolveTwitchTargets(inputs, account, kind, logger) {
	const log = createLogger(logger);
	if (!account.clientId || !account.accessToken) {
		log.error("Missing Twitch client ID or accessToken");
		return inputs.map((input) => ({
			input,
			resolved: false,
			note: "missing Twitch credentials"
		}));
	}
	const normalizedToken = normalizeToken(account.accessToken);
	const apiClient = new ApiClient({ authProvider: new StaticAuthProvider(account.clientId, normalizedToken) });
	const results = [];
	for (const input of inputs) {
		const normalized = normalizeUsername(input);
		if (!normalized) {
			results.push({
				input,
				resolved: false,
				note: "empty input"
			});
			continue;
		}
		const looksLikeUserId = /^\d+$/.test(normalized);
		try {
			if (looksLikeUserId) {
				const user = await apiClient.users.getUserById(normalized);
				if (user) {
					results.push({
						input,
						resolved: true,
						id: user.id,
						name: user.name
					});
					log.debug?.(`Resolved user ID ${normalized} -> ${user.name}`);
				} else {
					results.push({
						input,
						resolved: false,
						note: "user ID not found"
					});
					log.warn(`User ID ${normalized} not found`);
				}
			} else {
				const user = await apiClient.users.getUserByName(normalized);
				if (user) {
					results.push({
						input,
						resolved: true,
						id: user.id,
						name: user.name,
						note: user.displayName !== user.name ? `display: ${user.displayName}` : void 0
					});
					log.debug?.(`Resolved username ${normalized} -> ${user.id} (${user.name})`);
				} else {
					results.push({
						input,
						resolved: false,
						note: "username not found"
					});
					log.warn(`Username ${normalized} not found`);
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			results.push({
				input,
				resolved: false,
				note: `API error: ${errorMessage}`
			});
			log.error(`Failed to resolve ${input}: ${errorMessage}`);
		}
	}
	return results;
}
//#endregion
//#region extensions/twitch/src/status.ts
/**
* Collect status issues for Twitch accounts.
*
* Analyzes account snapshots and detects configuration problems,
* authentication issues, and other potential problems.
*
* @param accounts - Array of account snapshots to analyze
* @param getCfg - Optional function to get full config for additional checks
* @returns Array of detected status issues
*
* @example
* const issues = collectTwitchStatusIssues(accountSnapshots);
* if (issues.length > 0) {
*   console.warn("Twitch configuration issues detected:");
*   issues.forEach(issue => console.warn(`- ${issue.message}`));
* }
*/
function collectTwitchStatusIssues(accounts, getCfg) {
	const issues = [];
	for (const entry of accounts) {
		const accountId = entry.accountId;
		if (!accountId) continue;
		let account = null;
		let cfg;
		if (getCfg) try {
			cfg = getCfg();
			account = getAccountConfig(cfg, accountId);
		} catch {}
		if (!entry.configured) {
			issues.push({
				channel: "twitch",
				accountId,
				kind: "config",
				message: "Twitch account is not properly configured",
				fix: "Add required fields: username, accessToken, and clientId to your account configuration"
			});
			continue;
		}
		if (entry.enabled === false) {
			issues.push({
				channel: "twitch",
				accountId,
				kind: "config",
				message: "Twitch account is disabled",
				fix: "Set enabled: true in your account configuration to enable this account"
			});
			continue;
		}
		if (account && account.username && account.accessToken && !account.clientId) issues.push({
			channel: "twitch",
			accountId,
			kind: "config",
			message: "Twitch client ID is required",
			fix: "Add clientId to your Twitch account configuration (from Twitch Developer Portal)"
		});
		const tokenResolution = cfg ? resolveTwitchToken(cfg, { accountId }) : {
			token: "",
			source: "none"
		};
		if (account && isAccountConfigured(account, tokenResolution.token)) {
			if (account.accessToken?.startsWith("oauth:")) issues.push({
				channel: "twitch",
				accountId,
				kind: "config",
				message: "Token contains 'oauth:' prefix (will be stripped)",
				fix: "The 'oauth:' prefix is optional. You can use just the token value, or keep it as-is (it will be normalized automatically)."
			});
			if (account.clientSecret && !account.refreshToken) issues.push({
				channel: "twitch",
				accountId,
				kind: "config",
				message: "clientSecret provided without refreshToken",
				fix: "For automatic token refresh, provide both clientSecret and refreshToken. Otherwise, clientSecret is not needed."
			});
			if (account.allowFrom && account.allowFrom.length === 0) issues.push({
				channel: "twitch",
				accountId,
				kind: "config",
				message: "allowFrom is configured but empty",
				fix: "Either add user IDs to allowFrom, remove the allowFrom field, or use allowedRoles instead."
			});
			if (account.allowedRoles?.includes("all") && account.allowFrom && account.allowFrom.length > 0) issues.push({
				channel: "twitch",
				accountId,
				kind: "intent",
				message: "allowedRoles is set to 'all' but allowFrom is also configured",
				fix: "When allowedRoles is 'all', the allowFrom list is not needed. Remove allowFrom or set allowedRoles to specific roles."
			});
		}
		if (entry.lastError) issues.push({
			channel: "twitch",
			accountId,
			kind: "runtime",
			message: `Last error: ${entry.lastError}`,
			fix: "Check your token validity and network connection. Ensure the bot has the required OAuth scopes."
		});
		if (entry.configured && !entry.running && !entry.lastStartAt && !entry.lastInboundAt && !entry.lastOutboundAt) issues.push({
			channel: "twitch",
			accountId,
			kind: "runtime",
			message: "Account has never connected successfully",
			fix: "Start the Twitch gateway to begin receiving messages. Check logs for connection errors."
		});
		if (entry.running && entry.lastStartAt) {
			const daysSinceStart = (Date.now() - entry.lastStartAt) / (1e3 * 60 * 60 * 24);
			if (daysSinceStart > 7) issues.push({
				channel: "twitch",
				accountId,
				kind: "runtime",
				message: `Connection has been running for ${Math.floor(daysSinceStart)} days`,
				fix: "Consider restarting the connection periodically to refresh the connection. Twitch tokens may expire after long periods."
			});
		}
	}
	return issues;
}
//#endregion
//#region extensions/twitch/src/plugin.ts
/**
* Twitch channel plugin.
*
* Implements the ChannelPlugin interface to provide Twitch chat integration
* for OpenClaw. Supports message sending, receiving, access control, and
* status monitoring.
*/
const twitchPlugin = {
	id: "twitch",
	meta: {
		id: "twitch",
		label: "Twitch",
		selectionLabel: "Twitch (Chat)",
		docsPath: "/channels/twitch",
		blurb: "Twitch chat integration",
		aliases: ["twitch-chat"]
	},
	setup: twitchSetupAdapter,
	setupWizard: twitchSetupWizard,
	pairing: {
		idLabel: "twitchUserId",
		normalizeAllowEntry: (entry) => entry.replace(/^(twitch:)?user:?/i, ""),
		notifyApproval: async ({ id }) => {
			console.warn(`Pairing approved for user ${id} (notification sent via chat if possible)`);
		}
	},
	capabilities: { chatTypes: ["group"] },
	configSchema: buildChannelConfigSchema(TwitchConfigSchema),
	config: {
		listAccountIds: (cfg) => listAccountIds(cfg),
		resolveAccount: (cfg, accountId) => {
			const account = getAccountConfig(cfg, accountId ?? "default");
			if (!account) return {
				username: "",
				accessToken: "",
				clientId: "",
				enabled: false
			};
			return account;
		},
		defaultAccountId: () => DEFAULT_ACCOUNT_ID,
		isConfigured: (_account, cfg) => {
			const account = getAccountConfig(cfg, DEFAULT_ACCOUNT_ID);
			const tokenResolution = resolveTwitchToken(cfg, { accountId: DEFAULT_ACCOUNT_ID });
			return account ? isAccountConfigured(account, tokenResolution.token) : false;
		},
		isEnabled: (account) => account?.enabled !== false,
		describeAccount: (account) => {
			return {
				accountId: DEFAULT_ACCOUNT_ID,
				enabled: account?.enabled !== false,
				configured: account ? isAccountConfigured(account, account?.accessToken) : false
			};
		}
	},
	outbound: twitchOutbound,
	actions: twitchMessageActions,
	resolver: { resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) => {
		const account = getAccountConfig(cfg, accountId ?? "default");
		if (!account) return inputs.map((input) => ({
			input,
			resolved: false,
			note: "account not configured"
		}));
		return await resolveTwitchTargets(inputs, account, kind, {
			info: (msg) => runtime.log(msg),
			warn: (msg) => runtime.log(msg),
			error: (msg) => runtime.error(msg),
			debug: (msg) => runtime.log(msg)
		});
	} },
	status: {
		defaultRuntime: {
			accountId: DEFAULT_ACCOUNT_ID,
			running: false,
			lastStartAt: null,
			lastStopAt: null,
			lastError: null
		},
		buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot),
		probeAccount: async ({ account, timeoutMs }) => {
			return await probeTwitch(account, timeoutMs);
		},
		buildAccountSnapshot: ({ account, cfg, runtime, probe }) => {
			const accountMap = (cfg.channels?.twitch)?.accounts ?? {};
			const resolvedAccountId = Object.entries(accountMap).find(([, value]) => value === account)?.[0] ?? "default";
			const tokenResolution = resolveTwitchToken(cfg, { accountId: resolvedAccountId });
			return {
				accountId: resolvedAccountId,
				enabled: account?.enabled !== false,
				configured: isAccountConfigured(account, tokenResolution.token),
				running: runtime?.running ?? false,
				lastStartAt: runtime?.lastStartAt ?? null,
				lastStopAt: runtime?.lastStopAt ?? null,
				lastError: runtime?.lastError ?? null,
				probe
			};
		},
		collectStatusIssues: collectTwitchStatusIssues
	},
	gateway: {
		startAccount: async (ctx) => {
			const account = ctx.account;
			const accountId = ctx.accountId;
			ctx.setStatus?.({
				accountId,
				running: true,
				lastStartAt: Date.now(),
				lastError: null
			});
			ctx.log?.info(`Starting Twitch connection for ${account.username}`);
			const { monitorTwitchProvider } = await import("../../monitor-B-xKvpHN.js");
			await monitorTwitchProvider({
				account,
				accountId,
				config: ctx.cfg,
				runtime: ctx.runtime,
				abortSignal: ctx.abortSignal
			});
		},
		stopAccount: async (ctx) => {
			const account = ctx.account;
			const accountId = ctx.accountId;
			await removeClientManager(accountId);
			ctx.setStatus?.({
				accountId,
				running: false,
				lastStopAt: Date.now()
			});
			ctx.log?.info(`Stopped Twitch connection for ${account.username}`);
		}
	}
};
//#endregion
//#region extensions/twitch/index.ts
const plugin = {
	id: "twitch",
	name: "Twitch",
	description: "Twitch channel plugin",
	configSchema: emptyPluginConfigSchema(),
	register(api) {
		setTwitchRuntime(api.runtime);
		api.registerChannel({ plugin: twitchPlugin });
	}
};
//#endregion
export { plugin as default, monitorTwitchProvider };
