import "./provider-env-vars-BfZUtZAn.js";
import { h as DEFAULT_ACCOUNT_ID } from "./session-key-BfFG0xOA.js";
import { Mt as resolveDefaultGroupPolicy, Ot as evaluateSenderGroupAccessForPolicy, kt as resolveSenderScopedGroupPolicy } from "./resolve-route-BZ4hHpx2.js";
import "./logger-CRwcgB9y.js";
import "./tmp-openclaw-dir-Bz3ouN_i.js";
import "./paths-Byjx7_T6.js";
import "./subsystem-CsP80x3t.js";
import "./utils-o1tyfnZ_.js";
import "./fetch-Dx857jUp.js";
import "./retry-BY_ggjbn.js";
import "./agent-scope-DV_aCIyi.js";
import "./exec-BLi45_38.js";
import "./logger-Bsnck4bK.js";
import { n as keepHttpServerTaskAlive } from "./channel-lifecycle-h2DwjEdV.js";
import "./paths-OqPpu-UR.js";
import { Ao as createTypingCallbacks, At as resolveDmGroupAccessWithLists, Co as DEFAULT_WEBHOOK_MAX_BODY_BYTES, Gt as resolveDualTextControlCommandGate, Io as logInboundDrop, Lo as logTypingFailure, Mo as createReplyPrefixOptions, Na as resolveChannelMediaMaxBytes, Nt as resolveInboundSessionEnvelopeContext, Ot as readStoreAllowFromForDmPolicy, Pt as resolveMentionGating, Ro as buildPendingHistoryContextFromMap, Vo as recordPendingHistoryEntryIfEnabled, ao as createScopedPairingAccess, jt as resolveEffectiveAllowFromLists, zo as clearHistoryEntriesIfEnabled } from "./auth-profiles-CuJtivJK.js";
import "./profiles-CV7WLKIX.js";
import "./fetch-D2ZOzaXt.js";
import { f as fetchWithSsrFGuard } from "./external-content-vZzOHxnd.js";
import "./kilocode-shared-Ci8SRxXc.js";
import "./models-config.providers.static-DRBnLpDj.js";
import "./models-config.providers.discovery-l-LpSxGW.js";
import "./pairing-token-DKpN4qO0.js";
import "./query-expansion-txqQdNIf.js";
import "./redact-BefI-5cC.js";
import "./mime-33LCeGh-.js";
import { i as mergeAllowlist, l as formatAllowlistMatchMeta, o as summarizeMapping } from "./resolve-utils-BpDGEQsl.js";
import "./typebox-BmZP6XXv.js";
import "./web-search-plugin-factory-DStYVW2B.js";
import { s as dispatchReplyFromConfigWithSettledDispatcher } from "./compat-DDXNEdAm.js";
import "./inbound-envelope-DsNRW6ln.js";
import { t as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-CHxlFG8H.js";
import { t as buildMediaPayload } from "./media-payload-jgVLn5A7.js";
import "./run-command-Psw08BkS.js";
import "./device-pairing-DYWF-CWB.js";
import "./line-iO245OTq.js";
import "./upsert-with-lock-CLs2bE4R.js";
import "./self-hosted-provider-setup-C4OZCxyb.js";
import "./ollama-setup-BM-G12b6.js";
import { A as isUrlAllowed, C as applyAuthorizationHeaderForUrl, D as isDownloadableAttachment, E as inferPlaceholder, F as safeFetchWithPolicy, I as safeHostForUrl, M as resolveAttachmentFetchPolicy, N as resolveMediaSsrfPolicy, O as isLikelyImageAttachment, P as resolveRequestUrl, S as IMG_SRC_RE, T as extractInlineImageCandidates, b as ATTACHMENT_TAG_RE, g as resolveMSTeamsCredentials, j as normalizeContentType, k as isRecord, l as resolveMSTeamsChannelAllowlist, t as getMSTeamsRuntime, u as resolveMSTeamsUserAllowlist, v as createMSTeamsAdapter, w as extractHtmlFromAttachment, x as GRAPH_ROOT, y as loadMSTeamsSdkWithAuth } from "./runtime-lVaFT2UB.js";
import { a as resolveMSTeamsRouteConfig, i as resolveMSTeamsReplyPolicy, n as resolveMSTeamsAllowlistMatch, t as isMSTeamsGroupAllowed } from "./policy-DwUgDkFA.js";
import { _ as createMSTeamsConversationStoreFs, a as buildConversationReference, c as withRevokedProxyFallback, d as buildFileInfoCard, f as parseFileConsentInvoke, g as formatUnknownError, h as formatMSTeamsSendErrorHint, l as getPendingUpload, m as classifyMSTeamsSendError, o as renderReplyPayloadsToMessages, p as uploadToConsentUrl, s as sendMSTeamsMessages, u as removePendingUpload, v as createMSTeamsPollStoreFs, y as extractMSTeamsPollVote } from "./probe-s38GsuRl.js";
//#region extensions/msteams/src/inbound.ts
function normalizeMSTeamsConversationId(raw) {
	return raw.split(";")[0] ?? raw;
}
function extractMSTeamsConversationMessageId(raw) {
	if (!raw) {return;}
	return (/(?:^|;)messageid=([^;]+)/i.exec(raw)?.[1]?.trim() ?? "") || void 0;
}
function parseMSTeamsActivityTimestamp(value) {
	if (!value) {return;}
	if (value instanceof Date) {return value;}
	if (typeof value !== "string") {return;}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? void 0 : date;
}
function stripMSTeamsMentionTags(text) {
	return text.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
}
function wasMSTeamsBotMentioned(activity) {
	const botId = activity.recipient?.id;
	if (!botId) {return false;}
	return (activity.entities ?? []).some((e) => e.type === "mention" && e.mentioned?.id === botId);
}
//#endregion
//#region extensions/msteams/src/attachments/remote-media.ts
async function downloadAndStoreMSTeamsRemoteMedia(params) {
	const fetched = await getMSTeamsRuntime().channel.media.fetchRemoteMedia({
		url: params.url,
		fetchImpl: params.fetchImpl,
		filePathHint: params.filePathHint,
		maxBytes: params.maxBytes,
		ssrfPolicy: params.ssrfPolicy
	});
	const mime = await getMSTeamsRuntime().media.detectMime({
		buffer: fetched.buffer,
		headerMime: fetched.contentType ?? params.contentTypeHint,
		filePath: params.filePathHint
	});
	const originalFilename = params.preserveFilenames ? params.filePathHint : void 0;
	const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(fetched.buffer, mime ?? params.contentTypeHint, "inbound", params.maxBytes, originalFilename);
	return {
		path: saved.path,
		contentType: saved.contentType,
		placeholder: params.placeholder ?? inferPlaceholder({
			contentType: saved.contentType,
			fileName: params.filePathHint
		})
	};
}
//#endregion
//#region extensions/msteams/src/attachments/download.ts
function resolveDownloadCandidate(att) {
	const contentType = normalizeContentType(att.contentType);
	const name = typeof att.name === "string" ? att.name.trim() : "";
	if (contentType === "application/vnd.microsoft.teams.file.download.info") {
		if (!isRecord(att.content)) {return null;}
		const downloadUrl = typeof att.content.downloadUrl === "string" ? att.content.downloadUrl.trim() : "";
		if (!downloadUrl) {return null;}
		const fileType = typeof att.content.fileType === "string" ? att.content.fileType.trim() : "";
		const uniqueId = typeof att.content.uniqueId === "string" ? att.content.uniqueId.trim() : "";
		const fileName = typeof att.content.fileName === "string" ? att.content.fileName.trim() : "";
		const fileHint = name || fileName || (uniqueId && fileType ? `${uniqueId}.${fileType}` : "");
		return {
			url: downloadUrl,
			fileHint: fileHint || void 0,
			contentTypeHint: void 0,
			placeholder: inferPlaceholder({
				contentType,
				fileName: fileHint,
				fileType
			})
		};
	}
	const contentUrl = typeof att.contentUrl === "string" ? att.contentUrl.trim() : "";
	if (!contentUrl) {return null;}
	return {
		url: contentUrl,
		fileHint: name || void 0,
		contentTypeHint: contentType,
		placeholder: inferPlaceholder({
			contentType,
			fileName: name
		})
	};
}
function scopeCandidatesForUrl(url) {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host.endsWith("graph.microsoft.com") || host.endsWith("sharepoint.com") || host.endsWith("1drv.ms") || host.includes("sharepoint") ? ["https://graph.microsoft.com", "https://api.botframework.com"] : ["https://api.botframework.com", "https://graph.microsoft.com"];
	} catch {
		return ["https://api.botframework.com", "https://graph.microsoft.com"];
	}
}
function isRedirectStatus(status) {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
async function fetchWithAuthFallback(params) {
	const firstAttempt = await safeFetchWithPolicy({
		url: params.url,
		policy: params.policy,
		fetchFn: params.fetchFn,
		requestInit: params.requestInit
	});
	if (firstAttempt.ok) {return firstAttempt;}
	if (!params.tokenProvider) {return firstAttempt;}
	if (firstAttempt.status !== 401 && firstAttempt.status !== 403) {return firstAttempt;}
	if (!isUrlAllowed(params.url, params.policy.authAllowHosts)) {return firstAttempt;}
	const scopes = scopeCandidatesForUrl(params.url);
	const fetchFn = params.fetchFn ?? fetch;
	for (const scope of scopes) {try {
		const token = await params.tokenProvider.getAccessToken(scope);
		const authHeaders = new Headers(params.requestInit?.headers);
		authHeaders.set("Authorization", `Bearer ${token}`);
		const authAttempt = await safeFetchWithPolicy({
			url: params.url,
			policy: params.policy,
			fetchFn,
			requestInit: {
				...params.requestInit,
				headers: authHeaders
			}
		});
		if (authAttempt.ok) return authAttempt;
		if (isRedirectStatus(authAttempt.status)) return authAttempt;
		if (authAttempt.status !== 401 && authAttempt.status !== 403) continue;
	} catch {}}
	return firstAttempt;
}
/**
* Download all file attachments from a Teams message (images, documents, etc.).
* Renamed from downloadMSTeamsImageAttachments to support all file types.
*/
async function downloadMSTeamsAttachments(params) {
	const list = Array.isArray(params.attachments) ? params.attachments : [];
	if (list.length === 0) {return [];}
	const policy = resolveAttachmentFetchPolicy({
		allowHosts: params.allowHosts,
		authAllowHosts: params.authAllowHosts
	});
	const allowHosts = policy.allowHosts;
	const ssrfPolicy = resolveMediaSsrfPolicy(allowHosts);
	const candidates = list.filter(isDownloadableAttachment).map(resolveDownloadCandidate).filter(Boolean);
	const inlineCandidates = extractInlineImageCandidates(list);
	const seenUrls = /* @__PURE__ */ new Set();
	for (const inline of inlineCandidates) {if (inline.kind === "url") {
		if (!isUrlAllowed(inline.url, allowHosts)) continue;
		if (seenUrls.has(inline.url)) continue;
		seenUrls.add(inline.url);
		candidates.push({
			url: inline.url,
			fileHint: inline.fileHint,
			contentTypeHint: inline.contentType,
			placeholder: inline.placeholder
		});
	}}
	if (candidates.length === 0 && inlineCandidates.length === 0) {return [];}
	const out = [];
	for (const inline of inlineCandidates) {
		if (inline.kind !== "data") {continue;}
		if (inline.data.byteLength > params.maxBytes) {continue;}
		try {
			const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(inline.data, inline.contentType, "inbound", params.maxBytes);
			out.push({
				path: saved.path,
				contentType: saved.contentType,
				placeholder: inline.placeholder
			});
		} catch {}
	}
	for (const candidate of candidates) {
		if (!isUrlAllowed(candidate.url, allowHosts)) {continue;}
		try {
			const media = await downloadAndStoreMSTeamsRemoteMedia({
				url: candidate.url,
				filePathHint: candidate.fileHint ?? candidate.url,
				maxBytes: params.maxBytes,
				contentTypeHint: candidate.contentTypeHint,
				placeholder: candidate.placeholder,
				preserveFilenames: params.preserveFilenames,
				ssrfPolicy,
				fetchImpl: (input, init) => fetchWithAuthFallback({
					url: resolveRequestUrl(input),
					tokenProvider: params.tokenProvider,
					fetchFn: params.fetchFn,
					requestInit: init,
					policy
				})
			});
			out.push(media);
		} catch {}
	}
	return out;
}
//#endregion
//#region extensions/msteams/src/attachments/graph.ts
function readNestedString(value, keys) {
	let current = value;
	for (const key of keys) {
		if (!isRecord(current)) {return;}
		current = current[key];
	}
	return typeof current === "string" && current.trim() ? current.trim() : void 0;
}
function buildMSTeamsGraphMessageUrls(params) {
	const conversationType = params.conversationType?.trim().toLowerCase() ?? "";
	const messageIdCandidates = /* @__PURE__ */ new Set();
	const pushCandidate = (value) => {
		const trimmed = typeof value === "string" ? value.trim() : "";
		if (trimmed) {messageIdCandidates.add(trimmed);}
	};
	pushCandidate(params.messageId);
	pushCandidate(params.conversationMessageId);
	pushCandidate(readNestedString(params.channelData, ["messageId"]));
	pushCandidate(readNestedString(params.channelData, ["teamsMessageId"]));
	const replyToId = typeof params.replyToId === "string" ? params.replyToId.trim() : "";
	if (conversationType === "channel") {
		const teamId = readNestedString(params.channelData, ["team", "id"]) ?? readNestedString(params.channelData, ["teamId"]);
		const channelId = readNestedString(params.channelData, ["channel", "id"]) ?? readNestedString(params.channelData, ["channelId"]) ?? readNestedString(params.channelData, ["teamsChannelId"]);
		if (!teamId || !channelId) {return [];}
		const urls = [];
		if (replyToId) {for (const candidate of messageIdCandidates) {
			if (candidate === replyToId) continue;
			urls.push(`${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(replyToId)}/replies/${encodeURIComponent(candidate)}`);
		}}
		if (messageIdCandidates.size === 0 && replyToId) {messageIdCandidates.add(replyToId);}
		for (const candidate of messageIdCandidates) {urls.push(`${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(candidate)}`);}
		return Array.from(new Set(urls));
	}
	const chatId = params.conversationId?.trim() || readNestedString(params.channelData, ["chatId"]);
	if (!chatId) {return [];}
	if (messageIdCandidates.size === 0 && replyToId) {messageIdCandidates.add(replyToId);}
	const urls = Array.from(messageIdCandidates).map((candidate) => `${GRAPH_ROOT}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(candidate)}`);
	return Array.from(new Set(urls));
}
async function fetchGraphCollection(params) {
	const fetchFn = params.fetchFn ?? fetch;
	const { response, release } = await fetchWithSsrFGuard({
		url: params.url,
		fetchImpl: fetchFn,
		init: { headers: { Authorization: `Bearer ${params.accessToken}` } },
		policy: params.ssrfPolicy,
		auditContext: "msteams.graph.collection"
	});
	try {
		const status = response.status;
		if (!response.ok) {return {
			status,
			items: []
		};}
		try {
			const data = await response.json();
			return {
				status,
				items: Array.isArray(data.value) ? data.value : []
			};
		} catch {
			return {
				status,
				items: []
			};
		}
	} finally {
		await release();
	}
}
function normalizeGraphAttachment(att) {
	let content = att.content;
	if (typeof content === "string") {try {
		content = JSON.parse(content);
	} catch {}}
	return {
		contentType: normalizeContentType(att.contentType) ?? void 0,
		contentUrl: att.contentUrl ?? void 0,
		name: att.name ?? void 0,
		thumbnailUrl: att.thumbnailUrl ?? void 0,
		content
	};
}
/**
* Download all hosted content from a Teams message (images, documents, etc.).
* Renamed from downloadGraphHostedImages to support all file types.
*/
async function downloadGraphHostedContent(params) {
	const hosted = await fetchGraphCollection({
		url: `${params.messageUrl}/hostedContents`,
		accessToken: params.accessToken,
		fetchFn: params.fetchFn,
		ssrfPolicy: params.ssrfPolicy
	});
	if (hosted.items.length === 0) {return {
		media: [],
		status: hosted.status,
		count: 0
	};}
	const out = [];
	for (const item of hosted.items) {
		const contentBytes = typeof item.contentBytes === "string" ? item.contentBytes : "";
		if (!contentBytes) {continue;}
		let buffer;
		try {
			buffer = Buffer.from(contentBytes, "base64");
		} catch {
			continue;
		}
		if (buffer.byteLength > params.maxBytes) {continue;}
		const mime = await getMSTeamsRuntime().media.detectMime({
			buffer,
			headerMime: item.contentType ?? void 0
		});
		try {
			const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(buffer, mime ?? item.contentType ?? void 0, "inbound", params.maxBytes);
			out.push({
				path: saved.path,
				contentType: saved.contentType,
				placeholder: inferPlaceholder({ contentType: saved.contentType })
			});
		} catch {}
	}
	return {
		media: out,
		status: hosted.status,
		count: hosted.items.length
	};
}
async function downloadMSTeamsGraphMedia(params) {
	if (!params.messageUrl || !params.tokenProvider) {return { media: [] };}
	const policy = resolveAttachmentFetchPolicy({
		allowHosts: params.allowHosts,
		authAllowHosts: params.authAllowHosts
	});
	const ssrfPolicy = resolveMediaSsrfPolicy(policy.allowHosts);
	const messageUrl = params.messageUrl;
	let accessToken;
	try {
		accessToken = await params.tokenProvider.getAccessToken("https://graph.microsoft.com");
	} catch {
		return {
			media: [],
			messageUrl,
			tokenError: true
		};
	}
	const fetchFn = params.fetchFn ?? fetch;
	const sharePointMedia = [];
	const downloadedReferenceUrls = /* @__PURE__ */ new Set();
	try {
		const { response: msgRes, release } = await fetchWithSsrFGuard({
			url: messageUrl,
			fetchImpl: fetchFn,
			init: { headers: { Authorization: `Bearer ${accessToken}` } },
			policy: ssrfPolicy,
			auditContext: "msteams.graph.message"
		});
		try {
			if (msgRes.ok) {
				const spAttachments = ((await msgRes.json()).attachments ?? []).filter((a) => a.contentType === "reference" && a.contentUrl && a.name);
				for (const att of spAttachments) {
					const name = att.name ?? "file";
					try {
						const shareUrl = att.contentUrl;
						if (!isUrlAllowed(shareUrl, policy.allowHosts)) {continue;}
						const media = await downloadAndStoreMSTeamsRemoteMedia({
							url: `${GRAPH_ROOT}/shares/u!${Buffer.from(shareUrl).toString("base64url")}/driveItem/content`,
							filePathHint: name,
							maxBytes: params.maxBytes,
							contentTypeHint: "application/octet-stream",
							preserveFilenames: params.preserveFilenames,
							ssrfPolicy,
							fetchImpl: async (input, init) => {
								const requestUrl = resolveRequestUrl(input);
								const headers = new Headers(init?.headers);
								applyAuthorizationHeaderForUrl({
									headers,
									url: requestUrl,
									authAllowHosts: policy.authAllowHosts,
									bearerToken: accessToken
								});
								return await safeFetchWithPolicy({
									url: requestUrl,
									policy,
									fetchFn,
									requestInit: {
										...init,
										headers
									}
								});
							}
						});
						sharePointMedia.push(media);
						downloadedReferenceUrls.add(shareUrl);
					} catch {}
				}
			}
		} finally {
			await release();
		}
	} catch {}
	const hosted = await downloadGraphHostedContent({
		accessToken,
		messageUrl,
		maxBytes: params.maxBytes,
		fetchFn: params.fetchFn,
		preserveFilenames: params.preserveFilenames,
		ssrfPolicy
	});
	const attachments = await fetchGraphCollection({
		url: `${messageUrl}/attachments`,
		accessToken,
		fetchFn: params.fetchFn,
		ssrfPolicy
	});
	const normalizedAttachments = attachments.items.map(normalizeGraphAttachment);
	const filteredAttachments = sharePointMedia.length > 0 ? normalizedAttachments.filter((att) => {
		if (att.contentType?.toLowerCase() !== "reference") {return true;}
		const url = typeof att.contentUrl === "string" ? att.contentUrl : "";
		if (!url) {return true;}
		return !downloadedReferenceUrls.has(url);
	}) : normalizedAttachments;
	const attachmentMedia = await downloadMSTeamsAttachments({
		attachments: filteredAttachments,
		maxBytes: params.maxBytes,
		tokenProvider: params.tokenProvider,
		allowHosts: policy.allowHosts,
		authAllowHosts: policy.authAllowHosts,
		fetchFn: params.fetchFn,
		preserveFilenames: params.preserveFilenames
	});
	return {
		media: [
			...sharePointMedia,
			...hosted.media,
			...attachmentMedia
		],
		hostedCount: hosted.count,
		attachmentCount: filteredAttachments.length + sharePointMedia.length,
		hostedStatus: hosted.status,
		attachmentStatus: attachments.status,
		messageUrl
	};
}
//#endregion
//#region extensions/msteams/src/attachments/html.ts
function summarizeMSTeamsHtmlAttachments(attachments) {
	const list = Array.isArray(attachments) ? attachments : [];
	if (list.length === 0) {return;}
	let htmlAttachments = 0;
	let imgTags = 0;
	let dataImages = 0;
	let cidImages = 0;
	const srcHosts = /* @__PURE__ */ new Set();
	let attachmentTags = 0;
	const attachmentIds = /* @__PURE__ */ new Set();
	for (const att of list) {
		const html = extractHtmlFromAttachment(att);
		if (!html) {continue;}
		htmlAttachments += 1;
		IMG_SRC_RE.lastIndex = 0;
		let match = IMG_SRC_RE.exec(html);
		while (match) {
			imgTags += 1;
			const src = match[1]?.trim();
			if (src) {if (src.startsWith("data:")) dataImages += 1;
			else if (src.startsWith("cid:")) cidImages += 1;
			else srcHosts.add(safeHostForUrl(src));}
			match = IMG_SRC_RE.exec(html);
		}
		ATTACHMENT_TAG_RE.lastIndex = 0;
		let attachmentMatch = ATTACHMENT_TAG_RE.exec(html);
		while (attachmentMatch) {
			attachmentTags += 1;
			const id = attachmentMatch[1]?.trim();
			if (id) {attachmentIds.add(id);}
			attachmentMatch = ATTACHMENT_TAG_RE.exec(html);
		}
	}
	if (htmlAttachments === 0) {return;}
	return {
		htmlAttachments,
		imgTags,
		dataImages,
		cidImages,
		srcHosts: Array.from(srcHosts).slice(0, 5),
		attachmentTags,
		attachmentIds: Array.from(attachmentIds).slice(0, 5)
	};
}
function buildMSTeamsAttachmentPlaceholder(attachments) {
	const list = Array.isArray(attachments) ? attachments : [];
	if (list.length === 0) {return "";}
	const totalImages = list.filter(isLikelyImageAttachment).length + extractInlineImageCandidates(list).length;
	if (totalImages > 0) {return `<media:image>${totalImages > 1 ? ` (${totalImages} images)` : ""}`;}
	const count = list.length;
	return `<media:document>${count > 1 ? ` (${count} files)` : ""}`;
}
//#endregion
//#region extensions/msteams/src/attachments/payload.ts
function buildMSTeamsMediaPayload(mediaList) {
	return buildMediaPayload(mediaList, { preserveMediaTypeCardinality: true });
}
//#endregion
//#region extensions/msteams/src/reply-dispatcher.ts
function createMSTeamsReplyDispatcher(params) {
	const core = getMSTeamsRuntime();
	/**
	* Send a typing indicator.
	*
	* First tries the live turn context (cheapest path).  When the context has
	* been revoked (debounced messages) we fall back to proactive messaging via
	* the stored conversation reference so the user still sees the "…" bubble.
	*/
	const sendTypingIndicator = async () => {
		await withRevokedProxyFallback({
			run: async () => {
				await params.context.sendActivity({ type: "typing" });
			},
			onRevoked: async () => {
				const baseRef = buildConversationReference(params.conversationRef);
				await params.adapter.continueConversation(params.appId, {
					...baseRef,
					activityId: void 0
				}, async (ctx) => {
					await ctx.sendActivity({ type: "typing" });
				});
			},
			onRevokedLog: () => {
				params.log.debug?.("turn context revoked, sending typing via proactive messaging");
			}
		});
	};
	const typingCallbacks = createTypingCallbacks({
		start: sendTypingIndicator,
		onStartError: (err) => {
			logTypingFailure({
				log: (message) => params.log.debug?.(message),
				channel: "msteams",
				action: "start",
				error: err
			});
		}
	});
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg: params.cfg,
		agentId: params.agentId,
		channel: "msteams",
		accountId: params.accountId
	});
	const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "msteams");
	const { dispatcher, replyOptions, markDispatchIdle } = core.channel.reply.createReplyDispatcherWithTyping({
		...prefixOptions,
		humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
		typingCallbacks,
		deliver: async (payload) => {
			const tableMode = core.channel.text.resolveMarkdownTableMode({
				cfg: params.cfg,
				channel: "msteams"
			});
			const messages = renderReplyPayloadsToMessages([payload], {
				textChunkLimit: params.textLimit,
				chunkText: true,
				mediaMode: "split",
				tableMode,
				chunkMode
			});
			const mediaMaxBytes = resolveChannelMediaMaxBytes({
				cfg: params.cfg,
				resolveChannelLimitMb: ({ cfg }) => cfg.channels?.msteams?.mediaMaxMb
			});
			const ids = await sendMSTeamsMessages({
				replyStyle: params.replyStyle,
				adapter: params.adapter,
				appId: params.appId,
				conversationRef: params.conversationRef,
				context: params.context,
				messages,
				retry: {},
				onRetry: (event) => {
					params.log.debug?.("retrying send", {
						replyStyle: params.replyStyle,
						...event
					});
				},
				tokenProvider: params.tokenProvider,
				sharePointSiteId: params.sharePointSiteId,
				mediaMaxBytes
			});
			if (ids.length > 0) {params.onSentMessageIds?.(ids);}
		},
		onError: (err, info) => {
			const errMsg = formatUnknownError(err);
			const classification = classifyMSTeamsSendError(err);
			const hint = formatMSTeamsSendErrorHint(classification);
			params.runtime.error?.(`msteams ${info.kind} reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`);
			params.log.error("reply failed", {
				kind: info.kind,
				error: errMsg,
				classification,
				hint
			});
		}
	});
	return {
		dispatcher,
		replyOptions: {
			...replyOptions,
			onModelSelected
		},
		markDispatchIdle
	};
}
//#endregion
//#region extensions/msteams/src/sent-message-cache.ts
const TTL_MS = 1440 * 60 * 1e3;
const sentMessages = /* @__PURE__ */ new Map();
function cleanupExpired(entry) {
	const now = Date.now();
	for (const [msgId, timestamp] of entry.timestamps) {if (now - timestamp > TTL_MS) entry.timestamps.delete(msgId);}
}
function recordMSTeamsSentMessage(conversationId, messageId) {
	if (!conversationId || !messageId) {return;}
	let entry = sentMessages.get(conversationId);
	if (!entry) {
		entry = { timestamps: /* @__PURE__ */ new Map() };
		sentMessages.set(conversationId, entry);
	}
	entry.timestamps.set(messageId, Date.now());
	if (entry.timestamps.size > 200) {cleanupExpired(entry);}
}
function wasMSTeamsMessageSent(conversationId, messageId) {
	const entry = sentMessages.get(conversationId);
	if (!entry) {return false;}
	cleanupExpired(entry);
	return entry.timestamps.has(messageId);
}
//#endregion
//#region extensions/msteams/src/monitor-handler/inbound-media.ts
async function resolveMSTeamsInboundMedia(params) {
	const { attachments, htmlSummary, maxBytes, tokenProvider, allowHosts, conversationType, conversationId, conversationMessageId, activity, log, preserveFilenames } = params;
	let mediaList = await downloadMSTeamsAttachments({
		attachments,
		maxBytes,
		tokenProvider,
		allowHosts,
		authAllowHosts: params.authAllowHosts,
		preserveFilenames
	});
	if (mediaList.length === 0) {
		if (attachments.length > 0 && attachments.every((att) => String(att.contentType ?? "").startsWith("text/html"))) {
			const messageUrls = buildMSTeamsGraphMessageUrls({
				conversationType,
				conversationId,
				messageId: activity.id ?? void 0,
				replyToId: activity.replyToId ?? void 0,
				conversationMessageId,
				channelData: activity.channelData
			});
			if (messageUrls.length === 0) {log.debug?.("graph message url unavailable", {
				conversationType,
				hasChannelData: Boolean(activity.channelData),
				messageId: activity.id ?? void 0,
				replyToId: activity.replyToId ?? void 0
			});}
			else {
				const attempts = [];
				for (const messageUrl of messageUrls) {
					const graphMedia = await downloadMSTeamsGraphMedia({
						messageUrl,
						tokenProvider,
						maxBytes,
						allowHosts,
						authAllowHosts: params.authAllowHosts,
						preserveFilenames
					});
					attempts.push({
						url: messageUrl,
						hostedStatus: graphMedia.hostedStatus,
						attachmentStatus: graphMedia.attachmentStatus,
						hostedCount: graphMedia.hostedCount,
						attachmentCount: graphMedia.attachmentCount,
						tokenError: graphMedia.tokenError
					});
					if (graphMedia.media.length > 0) {
						mediaList = graphMedia.media;
						break;
					}
					if (graphMedia.tokenError) {break;}
				}
				if (mediaList.length === 0) {log.debug?.("graph media fetch empty", { attempts });}
			}
		}
	}
	if (mediaList.length > 0) {log.debug?.("downloaded attachments", { count: mediaList.length });}
	else if (htmlSummary?.imgTags) {log.debug?.("inline images detected but none downloaded", {
		imgTags: htmlSummary.imgTags,
		srcHosts: htmlSummary.srcHosts,
		dataImages: htmlSummary.dataImages,
		cidImages: htmlSummary.cidImages
	});}
	return mediaList;
}
//#endregion
//#region extensions/msteams/src/monitor-handler/message-handler.ts
function createMSTeamsMessageHandler(deps) {
	const { cfg, runtime, appId, adapter, tokenProvider, textLimit, mediaMaxBytes, conversationStore, pollStore, log } = deps;
	const core = getMSTeamsRuntime();
	const pairing = createScopedPairingAccess({
		core,
		channel: "msteams",
		accountId: DEFAULT_ACCOUNT_ID
	});
	const logVerboseMessage = (message) => {
		if (core.logging.shouldLogVerbose()) {log.debug?.(message);}
	};
	const msteamsCfg = cfg.channels?.msteams;
	const historyLimit = Math.max(0, msteamsCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 50);
	const conversationHistories = /* @__PURE__ */ new Map();
	const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
		cfg,
		channel: "msteams"
	});
	const handleTeamsMessageNow = async (params) => {
		const context = params.context;
		const activity = context.activity;
		const rawText = params.rawText;
		const text = params.text;
		const attachments = params.attachments;
		const attachmentPlaceholder = buildMSTeamsAttachmentPlaceholder(attachments);
		const rawBody = text || attachmentPlaceholder;
		const from = activity.from;
		const conversation = activity.conversation;
		const attachmentTypes = attachments.map((att) => typeof att.contentType === "string" ? att.contentType : void 0).filter(Boolean).slice(0, 3);
		const htmlSummary = summarizeMSTeamsHtmlAttachments(attachments);
		log.info("received message", {
			rawText: rawText.slice(0, 50),
			text: text.slice(0, 50),
			attachments: attachments.length,
			attachmentTypes,
			from: from?.id,
			conversation: conversation?.id
		});
		if (htmlSummary) {log.debug?.("html attachment summary", htmlSummary);}
		if (!from?.id) {
			log.debug?.("skipping message without from.id");
			return;
		}
		const rawConversationId = conversation?.id ?? "";
		const conversationId = normalizeMSTeamsConversationId(rawConversationId);
		const conversationMessageId = extractMSTeamsConversationMessageId(rawConversationId);
		const conversationType = conversation?.conversationType ?? "personal";
		const isGroupChat = conversationType === "groupChat" || conversation?.isGroup === true;
		const isChannel = conversationType === "channel";
		const isDirectMessage = !isGroupChat && !isChannel;
		const senderName = from.name ?? from.id;
		const senderId = from.aadObjectId ?? from.id;
		const dmPolicy = msteamsCfg?.dmPolicy ?? "pairing";
		const storedAllowFrom = await readStoreAllowFromForDmPolicy({
			provider: "msteams",
			accountId: pairing.accountId,
			dmPolicy,
			readStore: pairing.readStoreForDmPolicy
		});
		const useAccessGroups = cfg.commands?.useAccessGroups !== false;
		const configuredDmAllowFrom = (msteamsCfg?.allowFrom ?? []).map((v) => String(v));
		const groupAllowFrom = msteamsCfg?.groupAllowFrom;
		const resolvedAllowFromLists = resolveEffectiveAllowFromLists({
			allowFrom: configuredDmAllowFrom,
			groupAllowFrom,
			storeAllowFrom: storedAllowFrom,
			dmPolicy
		});
		const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
		const groupPolicy = !isDirectMessage && msteamsCfg ? msteamsCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist" : "disabled";
		const effectiveGroupAllowFrom = resolvedAllowFromLists.effectiveGroupAllowFrom;
		const teamId = activity.channelData?.team?.id;
		const teamName = activity.channelData?.team?.name;
		const channelName = activity.channelData?.channel?.name;
		const channelGate = resolveMSTeamsRouteConfig({
			cfg: msteamsCfg,
			teamId,
			teamName,
			conversationId,
			channelName,
			allowNameMatching: isDangerousNameMatchingEnabled(msteamsCfg)
		});
		const senderGroupPolicy = resolveSenderScopedGroupPolicy({
			groupPolicy,
			groupAllowFrom: effectiveGroupAllowFrom
		});
		const access = resolveDmGroupAccessWithLists({
			isGroup: !isDirectMessage,
			dmPolicy,
			groupPolicy: senderGroupPolicy,
			allowFrom: configuredDmAllowFrom,
			groupAllowFrom,
			storeAllowFrom: storedAllowFrom,
			groupAllowFromFallbackToAllowFrom: false,
			isSenderAllowed: (allowFrom) => resolveMSTeamsAllowlistMatch({
				allowFrom,
				senderId,
				senderName,
				allowNameMatching: isDangerousNameMatchingEnabled(msteamsCfg)
			}).allowed
		});
		const effectiveDmAllowFrom = access.effectiveAllowFrom;
		if (isDirectMessage && msteamsCfg && access.decision !== "allow") {
			if (access.reason === "dmPolicy=disabled") {
				log.debug?.("dropping dm (dms disabled)");
				return;
			}
			const allowMatch = resolveMSTeamsAllowlistMatch({
				allowFrom: effectiveDmAllowFrom,
				senderId,
				senderName,
				allowNameMatching: isDangerousNameMatchingEnabled(msteamsCfg)
			});
			if (access.decision === "pairing") {
				if (await pairing.upsertPairingRequest({
					id: senderId,
					meta: { name: senderName }
				})) {log.info("msteams pairing request created", {
					sender: senderId,
					label: senderName
				});}
			}
			log.debug?.("dropping dm (not allowlisted)", {
				sender: senderId,
				label: senderName,
				allowlistMatch: formatAllowlistMatchMeta(allowMatch)
			});
			return;
		}
		if (!isDirectMessage && msteamsCfg) {
			if (channelGate.allowlistConfigured && !channelGate.allowed) {
				log.debug?.("dropping group message (not in team/channel allowlist)", {
					conversationId,
					teamKey: channelGate.teamKey ?? "none",
					channelKey: channelGate.channelKey ?? "none",
					channelMatchKey: channelGate.channelMatchKey ?? "none",
					channelMatchSource: channelGate.channelMatchSource ?? "none"
				});
				return;
			}
			const senderGroupAccess = evaluateSenderGroupAccessForPolicy({
				groupPolicy,
				groupAllowFrom: effectiveGroupAllowFrom,
				senderId,
				isSenderAllowed: (_senderId, allowFrom) => resolveMSTeamsAllowlistMatch({
					allowFrom,
					senderId,
					senderName,
					allowNameMatching: isDangerousNameMatchingEnabled(msteamsCfg)
				}).allowed
			});
			if (!senderGroupAccess.allowed && senderGroupAccess.reason === "disabled") {
				log.debug?.("dropping group message (groupPolicy: disabled)", { conversationId });
				return;
			}
			if (!senderGroupAccess.allowed && senderGroupAccess.reason === "empty_allowlist") {
				log.debug?.("dropping group message (groupPolicy: allowlist, no allowlist)", { conversationId });
				return;
			}
			if (!senderGroupAccess.allowed && senderGroupAccess.reason === "sender_not_allowlisted") {
				const allowMatch = resolveMSTeamsAllowlistMatch({
					allowFrom: effectiveGroupAllowFrom,
					senderId,
					senderName,
					allowNameMatching: isDangerousNameMatchingEnabled(msteamsCfg)
				});
				log.debug?.("dropping group message (not in groupAllowFrom)", {
					sender: senderId,
					label: senderName,
					allowlistMatch: formatAllowlistMatchMeta(allowMatch)
				});
				return;
			}
		}
		const commandDmAllowFrom = isDirectMessage ? effectiveDmAllowFrom : configuredDmAllowFrom;
		const ownerAllowedForCommands = isMSTeamsGroupAllowed({
			groupPolicy: "allowlist",
			allowFrom: commandDmAllowFrom,
			senderId,
			senderName,
			allowNameMatching: isDangerousNameMatchingEnabled(msteamsCfg)
		});
		const groupAllowedForCommands = isMSTeamsGroupAllowed({
			groupPolicy: "allowlist",
			allowFrom: effectiveGroupAllowFrom,
			senderId,
			senderName,
			allowNameMatching: isDangerousNameMatchingEnabled(msteamsCfg)
		});
		const { commandAuthorized, shouldBlock } = resolveDualTextControlCommandGate({
			useAccessGroups,
			primaryConfigured: commandDmAllowFrom.length > 0,
			primaryAllowed: ownerAllowedForCommands,
			secondaryConfigured: effectiveGroupAllowFrom.length > 0,
			secondaryAllowed: groupAllowedForCommands,
			hasControlCommand: core.channel.text.hasControlCommand(text, cfg)
		});
		if (shouldBlock) {
			logInboundDrop({
				log: logVerboseMessage,
				channel: "msteams",
				reason: "control command (unauthorized)",
				target: senderId
			});
			return;
		}
		const agent = activity.recipient;
		const conversationRef = {
			activityId: activity.id,
			user: {
				id: from.id,
				name: from.name,
				aadObjectId: from.aadObjectId
			},
			agent,
			bot: agent ? {
				id: agent.id,
				name: agent.name
			} : void 0,
			conversation: {
				id: conversationId,
				conversationType,
				tenantId: conversation?.tenantId
			},
			teamId,
			channelId: activity.channelId,
			serviceUrl: activity.serviceUrl,
			locale: activity.locale
		};
		conversationStore.upsert(conversationId, conversationRef).catch((err) => {
			log.debug?.("failed to save conversation reference", { error: formatUnknownError(err) });
		});
		const pollVote = extractMSTeamsPollVote(activity);
		if (pollVote) {
			try {
				if (!await pollStore.recordVote({
					pollId: pollVote.pollId,
					voterId: senderId,
					selections: pollVote.selections
				})) {log.debug?.("poll vote ignored (poll not found)", { pollId: pollVote.pollId });}
				else {log.info("recorded poll vote", {
					pollId: pollVote.pollId,
					voter: senderId,
					selections: pollVote.selections
				});}
			} catch (err) {
				log.error("failed to record poll vote", {
					pollId: pollVote.pollId,
					error: formatUnknownError(err)
				});
			}
			return;
		}
		if (!rawBody) {
			log.debug?.("skipping empty message after stripping mentions");
			return;
		}
		const teamsFrom = isDirectMessage ? `msteams:${senderId}` : isChannel ? `msteams:channel:${conversationId}` : `msteams:group:${conversationId}`;
		const teamsTo = isDirectMessage ? `user:${senderId}` : `conversation:${conversationId}`;
		const route = core.channel.routing.resolveAgentRoute({
			cfg,
			channel: "msteams",
			peer: {
				kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
				id: isDirectMessage ? senderId : conversationId
			}
		});
		const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
		const inboundLabel = isDirectMessage ? `Teams DM from ${senderName}` : `Teams message in ${conversationType} from ${senderName}`;
		core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
			sessionKey: route.sessionKey,
			contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`
		});
		const channelId = conversationId;
		const { teamConfig, channelConfig } = channelGate;
		const { requireMention, replyStyle } = resolveMSTeamsReplyPolicy({
			isDirectMessage,
			globalConfig: msteamsCfg,
			teamConfig,
			channelConfig
		});
		const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);
		if (!isDirectMessage) {
			const mentionGate = resolveMentionGating({
				requireMention: Boolean(requireMention),
				canDetectMention: true,
				wasMentioned: params.wasMentioned,
				implicitMention: params.implicitMention,
				shouldBypassMention: false
			});
			const mentioned = mentionGate.effectiveWasMentioned;
			if (requireMention && mentionGate.shouldSkip) {
				log.debug?.("skipping message (mention required)", {
					teamId,
					channelId,
					requireMention,
					mentioned
				});
				recordPendingHistoryEntryIfEnabled({
					historyMap: conversationHistories,
					historyKey: conversationId,
					limit: historyLimit,
					entry: {
						sender: senderName,
						body: rawBody,
						timestamp: timestamp?.getTime(),
						messageId: activity.id ?? void 0
					}
				});
				return;
			}
		}
		const mediaPayload = buildMSTeamsMediaPayload(await resolveMSTeamsInboundMedia({
			attachments,
			htmlSummary: htmlSummary ?? void 0,
			maxBytes: mediaMaxBytes,
			tokenProvider,
			allowHosts: msteamsCfg?.mediaAllowHosts,
			authAllowHosts: msteamsCfg?.mediaAuthAllowHosts,
			conversationType,
			conversationId,
			conversationMessageId: conversationMessageId ?? void 0,
			activity: {
				id: activity.id,
				replyToId: activity.replyToId,
				channelData: activity.channelData
			},
			log,
			preserveFilenames: cfg.media?.preserveFilenames
		}));
		const envelopeFrom = isDirectMessage ? senderName : conversationType;
		const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
			cfg,
			agentId: route.agentId,
			sessionKey: route.sessionKey
		});
		let combinedBody = core.channel.reply.formatAgentEnvelope({
			channel: "Teams",
			from: envelopeFrom,
			timestamp,
			previousTimestamp,
			envelope: envelopeOptions,
			body: rawBody
		});
		const isRoomish = !isDirectMessage;
		const historyKey = isRoomish ? conversationId : void 0;
		if (isRoomish && historyKey) {combinedBody = buildPendingHistoryContextFromMap({
			historyMap: conversationHistories,
			historyKey,
			limit: historyLimit,
			currentMessage: combinedBody,
			formatEntry: (entry) => core.channel.reply.formatAgentEnvelope({
				channel: "Teams",
				from: conversationType,
				timestamp: entry.timestamp,
				body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
				envelope: envelopeOptions
			})
		});}
		const inboundHistory = isRoomish && historyKey && historyLimit > 0 ? (conversationHistories.get(historyKey) ?? []).map((entry) => ({
			sender: entry.sender,
			body: entry.body,
			timestamp: entry.timestamp
		})) : void 0;
		const commandBody = text.trim();
		const ctxPayload = core.channel.reply.finalizeInboundContext({
			Body: combinedBody,
			BodyForAgent: rawBody,
			InboundHistory: inboundHistory,
			RawBody: rawBody,
			CommandBody: commandBody,
			BodyForCommands: commandBody,
			From: teamsFrom,
			To: teamsTo,
			SessionKey: route.sessionKey,
			AccountId: route.accountId,
			ChatType: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
			ConversationLabel: envelopeFrom,
			GroupSubject: !isDirectMessage ? conversationType : void 0,
			SenderName: senderName,
			SenderId: senderId,
			Provider: "msteams",
			Surface: "msteams",
			MessageSid: activity.id,
			Timestamp: timestamp?.getTime() ?? Date.now(),
			WasMentioned: isDirectMessage || params.wasMentioned || params.implicitMention,
			CommandAuthorized: commandAuthorized,
			OriginatingChannel: "msteams",
			OriginatingTo: teamsTo,
			...mediaPayload
		});
		await core.channel.session.recordInboundSession({
			storePath,
			sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
			ctx: ctxPayload,
			onRecordError: (err) => {
				logVerboseMessage(`msteams: failed updating session meta: ${String(err)}`);
			}
		});
		logVerboseMessage(`msteams inbound: from=${ctxPayload.From} preview="${preview}"`);
		const sharePointSiteId = msteamsCfg?.sharePointSiteId;
		const { dispatcher, replyOptions, markDispatchIdle } = createMSTeamsReplyDispatcher({
			cfg,
			agentId: route.agentId,
			accountId: route.accountId,
			runtime,
			log,
			adapter,
			appId,
			conversationRef,
			context,
			replyStyle,
			textLimit,
			onSentMessageIds: (ids) => {
				for (const id of ids) {recordMSTeamsSentMessage(conversationId, id);}
			},
			tokenProvider,
			sharePointSiteId
		});
		log.info("dispatching to agent", { sessionKey: route.sessionKey });
		try {
			const { queuedFinal, counts } = await dispatchReplyFromConfigWithSettledDispatcher({
				cfg,
				ctxPayload,
				dispatcher,
				onSettled: () => {
					markDispatchIdle();
				},
				replyOptions
			});
			log.info("dispatch complete", {
				queuedFinal,
				counts
			});
			if (!queuedFinal) {
				if (isRoomish && historyKey) {clearHistoryEntriesIfEnabled({
					historyMap: conversationHistories,
					historyKey,
					limit: historyLimit
				});}
				return;
			}
			const finalCount = counts.final;
			logVerboseMessage(`msteams: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${teamsTo}`);
			if (isRoomish && historyKey) {clearHistoryEntriesIfEnabled({
				historyMap: conversationHistories,
				historyKey,
				limit: historyLimit
			});}
		} catch (err) {
			log.error("dispatch failed", { error: String(err) });
			runtime.error?.(`msteams dispatch failed: ${String(err)}`);
			try {
				await context.sendActivity(`⚠️ Agent failed: ${err instanceof Error ? err.message : String(err)}`);
			} catch {}
		}
	};
	const inboundDebouncer = core.channel.debounce.createInboundDebouncer({
		debounceMs: inboundDebounceMs,
		buildKey: (entry) => {
			const conversationId = normalizeMSTeamsConversationId(entry.context.activity.conversation?.id ?? "");
			const senderId = entry.context.activity.from?.aadObjectId ?? entry.context.activity.from?.id ?? "";
			if (!senderId || !conversationId) {return null;}
			return `msteams:${appId}:${conversationId}:${senderId}`;
		},
		shouldDebounce: (entry) => {
			if (!entry.text.trim()) {return false;}
			if (entry.attachments.length > 0) {return false;}
			return !core.channel.text.hasControlCommand(entry.text, cfg);
		},
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) {return;}
			if (entries.length === 1) {
				await handleTeamsMessageNow(last);
				return;
			}
			const combinedText = entries.map((entry) => entry.text).filter(Boolean).join("\n");
			if (!combinedText.trim()) {return;}
			const combinedRawText = entries.map((entry) => entry.rawText).filter(Boolean).join("\n");
			const wasMentioned = entries.some((entry) => entry.wasMentioned);
			const implicitMention = entries.some((entry) => entry.implicitMention);
			await handleTeamsMessageNow({
				context: last.context,
				rawText: combinedRawText,
				text: combinedText,
				attachments: [],
				wasMentioned,
				implicitMention
			});
		},
		onError: (err) => {
			runtime.error?.(`msteams debounce flush failed: ${String(err)}`);
		}
	});
	return async function handleTeamsMessage(context) {
		const activity = context.activity;
		const rawText = activity.text?.trim() ?? "";
		const text = stripMSTeamsMentionTags(rawText);
		const attachments = Array.isArray(activity.attachments) ? activity.attachments : [];
		const wasMentioned = wasMSTeamsBotMentioned(activity);
		const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
		const replyToId = activity.replyToId ?? void 0;
		const implicitMention = Boolean(conversationId && replyToId && wasMSTeamsMessageSent(conversationId, replyToId));
		await inboundDebouncer.enqueue({
			context,
			rawText,
			text,
			attachments,
			wasMentioned,
			implicitMention
		});
	};
}
//#endregion
//#region extensions/msteams/src/monitor-handler.ts
/**
* Handle fileConsent/invoke activities for large file uploads.
*/
async function handleFileConsentInvoke(context, log) {
	const expiredUploadMessage = "The file upload request has expired. Please try sending the file again.";
	const activity = context.activity;
	if (activity.type !== "invoke" || activity.name !== "fileConsent/invoke") {return false;}
	const consentResponse = parseFileConsentInvoke(activity);
	if (!consentResponse) {
		log.debug?.("invalid file consent invoke", { value: activity.value });
		return false;
	}
	const uploadId = typeof consentResponse.context?.uploadId === "string" ? consentResponse.context.uploadId : void 0;
	const pendingFile = getPendingUpload(uploadId);
	if (pendingFile) {
		const pendingConversationId = normalizeMSTeamsConversationId(pendingFile.conversationId);
		const invokeConversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
		if (!invokeConversationId || pendingConversationId !== invokeConversationId) {
			log.info("file consent conversation mismatch", {
				uploadId,
				expectedConversationId: pendingConversationId,
				receivedConversationId: invokeConversationId || void 0
			});
			if (consentResponse.action === "accept") {await context.sendActivity(expiredUploadMessage);}
			return true;
		}
	}
	if (consentResponse.action === "accept" && consentResponse.uploadInfo) {if (pendingFile) {
		log.debug?.("user accepted file consent, uploading", {
			uploadId,
			filename: pendingFile.filename,
			size: pendingFile.buffer.length
		});
		try {
			await uploadToConsentUrl({
				url: consentResponse.uploadInfo.uploadUrl,
				buffer: pendingFile.buffer,
				contentType: pendingFile.contentType
			});
			const fileInfoCard = buildFileInfoCard({
				filename: consentResponse.uploadInfo.name,
				contentUrl: consentResponse.uploadInfo.contentUrl,
				uniqueId: consentResponse.uploadInfo.uniqueId,
				fileType: consentResponse.uploadInfo.fileType
			});
			await context.sendActivity({
				type: "message",
				attachments: [fileInfoCard]
			});
			log.info("file upload complete", {
				uploadId,
				filename: consentResponse.uploadInfo.name,
				uniqueId: consentResponse.uploadInfo.uniqueId
			});
		} catch (err) {
			log.debug?.("file upload failed", {
				uploadId,
				error: String(err)
			});
			await context.sendActivity(`File upload failed: ${String(err)}`);
		} finally {
			removePendingUpload(uploadId);
		}
	} else {
		log.debug?.("pending file not found for consent", { uploadId });
		await context.sendActivity(expiredUploadMessage);
	}}
	else {
		log.debug?.("user declined file consent", { uploadId });
		removePendingUpload(uploadId);
	}
	return true;
}
function registerMSTeamsHandlers(handler, deps) {
	const handleTeamsMessage = createMSTeamsMessageHandler(deps);
	const originalRun = handler.run;
	if (originalRun) {handler.run = async (context) => {
		const ctx = context;
		if (ctx.activity?.type === "invoke" && ctx.activity?.name === "fileConsent/invoke") {
			await ctx.sendActivity({
				type: "invokeResponse",
				value: { status: 200 }
			});
			try {
				await withRevokedProxyFallback({
					run: async () => await handleFileConsentInvoke(ctx, deps.log),
					onRevoked: async () => true,
					onRevokedLog: () => {
						deps.log.debug?.("turn context revoked during file consent invoke; skipping delayed response");
					}
				});
			} catch (err) {
				deps.log.debug?.("file consent handler error", { error: String(err) });
			}
			return;
		}
		return originalRun.call(handler, context);
	};}
	handler.onMessage(async (context, next) => {
		try {
			await handleTeamsMessage(context);
		} catch (err) {
			deps.runtime.error?.(`msteams handler failed: ${String(err)}`);
		}
		await next();
	});
	handler.onMembersAdded(async (context, next) => {
		const membersAdded = context.activity?.membersAdded ?? [];
		for (const member of membersAdded) {if (member.id !== context.activity?.recipient?.id) deps.log.debug?.("member added", { member: member.id });}
		await next();
	});
	return handler;
}
//#endregion
//#region extensions/msteams/src/monitor.ts
const MSTEAMS_WEBHOOK_MAX_BODY_BYTES = DEFAULT_WEBHOOK_MAX_BODY_BYTES;
const MSTEAMS_WEBHOOK_INACTIVITY_TIMEOUT_MS = 3e4;
const MSTEAMS_WEBHOOK_REQUEST_TIMEOUT_MS = 3e4;
const MSTEAMS_WEBHOOK_HEADERS_TIMEOUT_MS = 15e3;
function applyMSTeamsWebhookTimeouts(httpServer, opts) {
	const inactivityTimeoutMs = opts?.inactivityTimeoutMs ?? MSTEAMS_WEBHOOK_INACTIVITY_TIMEOUT_MS;
	const requestTimeoutMs = opts?.requestTimeoutMs ?? MSTEAMS_WEBHOOK_REQUEST_TIMEOUT_MS;
	const headersTimeoutMs = Math.min(opts?.headersTimeoutMs ?? MSTEAMS_WEBHOOK_HEADERS_TIMEOUT_MS, requestTimeoutMs);
	httpServer.setTimeout(inactivityTimeoutMs);
	httpServer.requestTimeout = requestTimeoutMs;
	httpServer.headersTimeout = headersTimeoutMs;
}
async function monitorMSTeamsProvider(opts) {
	const core = getMSTeamsRuntime();
	const log = core.logging.getChildLogger({ name: "msteams" });
	let cfg = opts.cfg;
	let msteamsCfg = cfg.channels?.msteams;
	if (!msteamsCfg?.enabled) {
		log.debug?.("msteams provider disabled");
		return {
			app: null,
			shutdown: async () => {}
		};
	}
	const creds = resolveMSTeamsCredentials(msteamsCfg);
	if (!creds) {
		log.error("msteams credentials not configured");
		return {
			app: null,
			shutdown: async () => {}
		};
	}
	const appId = creds.appId;
	const runtime = opts.runtime ?? {
		log: console.log,
		error: console.error,
		exit: (code) => {
			throw new Error(`exit ${code}`);
		}
	};
	let allowFrom = msteamsCfg.allowFrom;
	let groupAllowFrom = msteamsCfg.groupAllowFrom;
	let teamsConfig = msteamsCfg.teams;
	const cleanAllowEntry = (entry) => entry.replace(/^(msteams|teams):/i, "").replace(/^user:/i, "").trim();
	const resolveAllowlistUsers = async (label, entries) => {
		if (entries.length === 0) {return {
			additions: [],
			unresolved: []
		};}
		const resolved = await resolveMSTeamsUserAllowlist({
			cfg,
			entries
		});
		const additions = [];
		const unresolved = [];
		for (const entry of resolved) {if (entry.resolved && entry.id) additions.push(entry.id);
		else unresolved.push(entry.input);}
		summarizeMapping(label, resolved.filter((entry) => entry.resolved && entry.id).map((entry) => `${entry.input}→${entry.id}`), unresolved, runtime);
		return {
			additions,
			unresolved
		};
	};
	try {
		const allowEntries = allowFrom?.map((entry) => cleanAllowEntry(String(entry))).filter((entry) => entry && entry !== "*") ?? [];
		if (allowEntries.length > 0) {
			const { additions } = await resolveAllowlistUsers("msteams users", allowEntries);
			allowFrom = mergeAllowlist({
				existing: allowFrom,
				additions
			});
		}
		if (Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0) {
			const groupEntries = groupAllowFrom.map((entry) => cleanAllowEntry(String(entry))).filter((entry) => entry && entry !== "*");
			if (groupEntries.length > 0) {
				const { additions } = await resolveAllowlistUsers("msteams group users", groupEntries);
				groupAllowFrom = mergeAllowlist({
					existing: groupAllowFrom,
					additions
				});
			}
		}
		if (teamsConfig && Object.keys(teamsConfig).length > 0) {
			const entries = [];
			for (const [teamKey, teamCfg] of Object.entries(teamsConfig)) {
				if (teamKey === "*") {continue;}
				const channels = teamCfg?.channels ?? {};
				const channelKeys = Object.keys(channels).filter((key) => key !== "*");
				if (channelKeys.length === 0) {
					entries.push({
						input: teamKey,
						teamKey
					});
					continue;
				}
				for (const channelKey of channelKeys) {entries.push({
					input: `${teamKey}/${channelKey}`,
					teamKey,
					channelKey
				});}
			}
			if (entries.length > 0) {
				const resolved = await resolveMSTeamsChannelAllowlist({
					cfg,
					entries: entries.map((entry) => entry.input)
				});
				const mapping = [];
				const unresolved = [];
				const nextTeams = { ...teamsConfig };
				resolved.forEach((entry, idx) => {
					const source = entries[idx];
					if (!source) {return;}
					const sourceTeam = teamsConfig?.[source.teamKey] ?? {};
					if (!entry.resolved || !entry.teamId) {
						unresolved.push(entry.input);
						return;
					}
					mapping.push(entry.channelId ? `${entry.input}→${entry.teamId}/${entry.channelId}` : `${entry.input}→${entry.teamId}`);
					const existing = nextTeams[entry.teamId] ?? {};
					const mergedChannels = {
						...sourceTeam.channels,
						...existing.channels
					};
					const mergedTeam = {
						...sourceTeam,
						...existing,
						channels: mergedChannels
					};
					nextTeams[entry.teamId] = mergedTeam;
					if (source.channelKey && entry.channelId) {
						const sourceChannel = sourceTeam.channels?.[source.channelKey];
						if (sourceChannel) {nextTeams[entry.teamId] = {
							...mergedTeam,
							channels: {
								...mergedChannels,
								[entry.channelId]: {
									...sourceChannel,
									...mergedChannels?.[entry.channelId]
								}
							}
						};}
					}
				});
				teamsConfig = nextTeams;
				summarizeMapping("msteams channels", mapping, unresolved, runtime);
			}
		}
	} catch (err) {
		runtime.log?.(`msteams resolve failed; using config entries. ${String(err)}`);
	}
	msteamsCfg = {
		...msteamsCfg,
		allowFrom,
		groupAllowFrom,
		teams: teamsConfig
	};
	cfg = {
		...cfg,
		channels: {
			...cfg.channels,
			msteams: msteamsCfg
		}
	};
	const port = msteamsCfg.webhook?.port ?? 3978;
	const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "msteams");
	const MB = 1024 * 1024;
	const agentDefaults = cfg.agents?.defaults;
	const mediaMaxBytes = typeof agentDefaults?.mediaMaxMb === "number" && agentDefaults.mediaMaxMb > 0 ? Math.floor(agentDefaults.mediaMaxMb * MB) : 8 * MB;
	const conversationStore = opts.conversationStore ?? createMSTeamsConversationStoreFs();
	const pollStore = opts.pollStore ?? createMSTeamsPollStoreFs();
	log.info(`starting provider (port ${port})`);
	const express = await import("express");
	const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
	const { ActivityHandler, MsalTokenProvider, authorizeJWT } = sdk;
	const tokenProvider = new MsalTokenProvider(authConfig);
	const adapter = createMSTeamsAdapter(authConfig, sdk);
	const handler = registerMSTeamsHandlers(new ActivityHandler(), {
		cfg,
		runtime,
		appId,
		adapter,
		tokenProvider,
		textLimit,
		mediaMaxBytes,
		conversationStore,
		pollStore,
		log
	});
	const expressApp = express.default();
	expressApp.use(authorizeJWT(authConfig));
	expressApp.use(express.json({ limit: MSTEAMS_WEBHOOK_MAX_BODY_BYTES }));
	expressApp.use((err, _req, res, next) => {
		if (err && typeof err === "object" && "status" in err && err.status === 413) {
			res.status(413).json({ error: "Payload too large" });
			return;
		}
		next(err);
	});
	const configuredPath = msteamsCfg.webhook?.path ?? "/api/messages";
	const messageHandler = (req, res) => {
		adapter.process(req, res, (context) => handler.run(context)).catch((err) => {
			log.error("msteams webhook failed", { error: formatUnknownError(err) });
		});
	};
	expressApp.post(configuredPath, messageHandler);
	if (configuredPath !== "/api/messages") {expressApp.post("/api/messages", messageHandler);}
	log.debug?.("listening on paths", {
		primary: configuredPath,
		fallback: "/api/messages"
	});
	const httpServer = expressApp.listen(port);
	await new Promise((resolve, reject) => {
		const onListening = () => {
			httpServer.off("error", onError);
			log.info(`msteams provider started on port ${port}`);
			resolve();
		};
		const onError = (err) => {
			httpServer.off("listening", onListening);
			log.error("msteams server error", { error: String(err) });
			reject(err);
		};
		httpServer.once("listening", onListening);
		httpServer.once("error", onError);
	});
	applyMSTeamsWebhookTimeouts(httpServer);
	httpServer.on("error", (err) => {
		log.error("msteams server error", { error: String(err) });
	});
	const shutdown = async () => {
		log.info("shutting down msteams provider");
		return new Promise((resolve) => {
			httpServer.close((err) => {
				if (err) {log.debug?.("msteams server close error", { error: String(err) });}
				resolve();
			});
		});
	};
	await keepHttpServerTaskAlive({
		server: httpServer,
		abortSignal: opts.abortSignal,
		onAbort: shutdown
	});
	return {
		app: expressApp,
		shutdown
	};
}
//#endregion
export { monitorMSTeamsProvider };
