import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as jsonResult, f as readNumberParam, g as readStringParam, i as createActionGate, m as readStringArrayParam, p as readReactionParams } from "./common-E9YpX7pB.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { a as resolveMatrixAccountConfig } from "./account-config-C6EZ3oG4.js";
import "./accounts-CAjG_HwT.js";
import { _ as parsePollStart, d as buildPollResponseContent, g as isPollStartType, i as reactMatrixMessage, u as resolveMatrixRoomId } from "./send-xdKxcj70.js";
import { i as buildMatrixReactionRelationsPath, o as selectOwnMatrixReactionEventIds, s as summarizeMatrixReactionEvents } from "./reaction-common-BjAtJ4Dp.js";
import { n as withResolvedRoomAction, t as withResolvedActionClient } from "./client-CWBVxcE6.js";
import { a as fetchEventSummary, c as resolveMatrixActionLimit, i as sendMatrixMessage, n as editMatrixMessage, o as readPinnedEvents, r as readMatrixMessages, s as EventType, t as deleteMatrixMessage } from "./messages-c419K2HL.js";
import "./runtime-api-DYOyZ9O3.js";
import { t as applyMatrixProfileUpdate } from "./profile-update-DyKXeMb-.js";
import { _ as scanMatrixVerificationQr, a as confirmMatrixVerificationSas, c as getMatrixRoomKeyBackupStatus, d as listMatrixVerifications, f as mismatchMatrixVerificationSas, h as restoreMatrixRoomKeyBackup, i as confirmMatrixVerificationReciprocateQr, l as getMatrixVerificationSas, n as bootstrapMatrixVerification, o as generateMatrixVerificationQr, p as requestMatrixVerification, r as cancelMatrixVerification, s as getMatrixEncryptionStatus, t as acceptMatrixVerification, u as getMatrixVerificationStatus, v as startMatrixVerification, y as verifyMatrixRecoveryKey } from "./verification-BHCyRbYY.js";
//#region extensions/matrix/src/matrix/actions/polls.ts
function normalizeOptionIndexes(indexes) {
	const normalized = indexes.map((index) => Math.trunc(index)).filter((index) => Number.isFinite(index) && index > 0);
	return Array.from(new Set(normalized));
}
function normalizeOptionIds(optionIds) {
	return Array.from(new Set(optionIds.map((optionId) => optionId.trim()).filter((optionId) => optionId.length > 0)));
}
function resolveSelectedAnswerIds(params) {
	const parsed = parsePollStart(params.pollContent);
	if (!parsed) throw new Error("Matrix poll vote requires a valid poll start event.");
	const selectedById = normalizeOptionIds(params.optionIds ?? []);
	const selectedByIndex = normalizeOptionIndexes(params.optionIndexes ?? []).map((index) => {
		const answer = parsed.answers[index - 1];
		if (!answer) throw new Error(`Matrix poll option index ${index} is out of range for a poll with ${parsed.answers.length} options.`);
		return answer.id;
	});
	const answerIds = normalizeOptionIds([...selectedById, ...selectedByIndex]);
	if (answerIds.length === 0) throw new Error("Matrix poll vote requires at least one poll option id or index.");
	if (answerIds.length > parsed.maxSelections) throw new Error(`Matrix poll allows at most ${parsed.maxSelections} selection${parsed.maxSelections === 1 ? "" : "s"}.`);
	const answerMap = new Map(parsed.answers.map((answer) => [answer.id, answer.text]));
	return {
		answerIds,
		labels: answerIds.map((answerId) => {
			const label = answerMap.get(answerId);
			if (!label) throw new Error(`Matrix poll option id "${answerId}" is not valid for poll ${parsed.question}.`);
			return label;
		}),
		maxSelections: parsed.maxSelections
	};
}
async function voteMatrixPoll(roomId, pollId, opts = {}) {
	return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
		const pollEvent = await client.getEvent(resolvedRoom, pollId);
		if (!isPollStartType(typeof pollEvent.type === "string" ? pollEvent.type : "")) throw new Error(`Event ${pollId} is not a Matrix poll start event.`);
		const { answerIds, labels, maxSelections } = resolveSelectedAnswerIds({
			optionIds: [...opts.optionIds ?? [], ...opts.optionId ? [opts.optionId] : []],
			optionIndexes: [...opts.optionIndexes ?? [], ...opts.optionIndex !== void 0 ? [opts.optionIndex] : []],
			pollContent: pollEvent.content
		});
		const content = buildPollResponseContent(pollId, answerIds);
		return {
			eventId: await client.sendEvent(resolvedRoom, "m.poll.response", content) ?? null,
			roomId: resolvedRoom,
			pollId,
			answerIds,
			labels,
			maxSelections
		};
	});
}
//#endregion
//#region extensions/matrix/src/matrix/actions/reactions.ts
async function listMatrixReactionEvents(client, roomId, messageId, limit) {
	const res = await client.doRequest("GET", buildMatrixReactionRelationsPath(roomId, messageId), {
		dir: "b",
		limit
	});
	return Array.isArray(res.chunk) ? res.chunk : [];
}
async function listMatrixReactions(roomId, messageId, opts = {}) {
	return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
		return summarizeMatrixReactionEvents(await listMatrixReactionEvents(client, resolvedRoom, messageId, resolveMatrixActionLimit(opts.limit, 100)));
	});
}
async function removeMatrixReactions(roomId, messageId, opts = {}) {
	return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
		const chunk = await listMatrixReactionEvents(client, resolvedRoom, messageId, 200);
		const userId = await client.getUserId();
		if (!userId) return { removed: 0 };
		const toRemove = selectOwnMatrixReactionEventIds(chunk, userId, opts.emoji);
		if (toRemove.length === 0) return { removed: 0 };
		await Promise.all(toRemove.map((id) => client.redactEvent(resolvedRoom, id)));
		return { removed: toRemove.length };
	});
}
//#endregion
//#region extensions/matrix/src/matrix/actions/pins.ts
async function updateMatrixPins(roomId, opts, update) {
	return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
		const next = update(await readPinnedEvents(client, resolvedRoom));
		const payload = { pinned: next };
		await client.sendStateEvent(resolvedRoom, EventType.RoomPinnedEvents, "", payload);
		return { pinned: next };
	});
}
async function pinMatrixMessage(roomId, messageId, opts = {}) {
	return await updateMatrixPins(roomId, opts, (current) => current.includes(messageId) ? current : [...current, messageId]);
}
async function unpinMatrixMessage(roomId, messageId, opts = {}) {
	return await updateMatrixPins(roomId, opts, (current) => current.filter((id) => id !== messageId));
}
async function listMatrixPins(roomId, opts = {}) {
	return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
		const pinned = await readPinnedEvents(client, resolvedRoom);
		return {
			pinned,
			events: (await Promise.all(pinned.map(async (eventId) => {
				try {
					return await fetchEventSummary(client, resolvedRoom, eventId);
				} catch {
					return null;
				}
			}))).filter((event) => Boolean(event))
		};
	});
}
//#endregion
//#region extensions/matrix/src/matrix/actions/room.ts
async function getMatrixMemberInfo(userId, opts = {}) {
	return await withResolvedActionClient(opts, async (client) => {
		const roomId = opts.roomId ? await resolveMatrixRoomId(client, opts.roomId) : void 0;
		const profile = await client.getUserProfile(userId);
		return {
			userId,
			profile: {
				displayName: profile?.displayname ?? null,
				avatarUrl: profile?.avatar_url ?? null
			},
			membership: null,
			powerLevel: null,
			displayName: profile?.displayname ?? null,
			roomId: roomId ?? null
		};
	});
}
async function getMatrixRoomInfo(roomId, opts = {}) {
	return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
		let name = null;
		let topic = null;
		let canonicalAlias = null;
		let memberCount = null;
		try {
			const nameState = await client.getRoomStateEvent(resolvedRoom, "m.room.name", "");
			name = typeof nameState?.name === "string" ? nameState.name : null;
		} catch {}
		try {
			const topicState = await client.getRoomStateEvent(resolvedRoom, EventType.RoomTopic, "");
			topic = typeof topicState?.topic === "string" ? topicState.topic : null;
		} catch {}
		try {
			const aliasState = await client.getRoomStateEvent(resolvedRoom, "m.room.canonical_alias", "");
			canonicalAlias = typeof aliasState?.alias === "string" ? aliasState.alias : null;
		} catch {}
		try {
			memberCount = (await client.getJoinedRoomMembers(resolvedRoom)).length;
		} catch {}
		return {
			roomId: resolvedRoom,
			name,
			topic,
			canonicalAlias,
			altAliases: [],
			memberCount
		};
	});
}
//#endregion
//#region extensions/matrix/src/tool-actions.ts
const messageActions = new Set([
	"sendMessage",
	"editMessage",
	"deleteMessage",
	"readMessages"
]);
const reactionActions = new Set(["react", "reactions"]);
const pinActions = new Set([
	"pinMessage",
	"unpinMessage",
	"listPins"
]);
const pollActions = new Set(["pollVote"]);
const profileActions = new Set(["setProfile"]);
const verificationActions = new Set([
	"encryptionStatus",
	"verificationList",
	"verificationRequest",
	"verificationAccept",
	"verificationCancel",
	"verificationStart",
	"verificationGenerateQr",
	"verificationScanQr",
	"verificationSas",
	"verificationConfirm",
	"verificationMismatch",
	"verificationConfirmQr",
	"verificationStatus",
	"verificationBootstrap",
	"verificationRecoveryKey",
	"verificationBackupStatus",
	"verificationBackupRestore"
]);
function readRoomId(params, required = true) {
	const direct = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
	if (direct) return direct;
	if (!required) return readStringParam(params, "to") ?? "";
	return readStringParam(params, "to", { required: true });
}
function toSnakeCaseKey(key) {
	return normalizeOptionalLowercaseString(key.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}
function readRawParam(params, key) {
	if (Object.hasOwn(params, key)) return params[key];
	const snakeKey = toSnakeCaseKey(key);
	if (snakeKey !== key && Object.hasOwn(params, snakeKey)) return params[snakeKey];
}
function readStringAliasParam(params, keys, options = {}) {
	for (const key of keys) {
		const raw = readRawParam(params, key);
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		if (trimmed) return trimmed;
	}
	if (options.required) throw new Error(`${keys[0]} required`);
}
function readNumericArrayParam(params, key, options = {}) {
	const { integer = false } = options;
	const raw = readRawParam(params, key);
	if (raw === void 0) return [];
	return (Array.isArray(raw) ? raw : [raw]).map((value) => {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			const trimmed = value.trim();
			if (!trimmed) return null;
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) ? parsed : null;
		}
		return null;
	}).filter((value) => value !== null).map((value) => integer ? Math.trunc(value) : value);
}
async function handleMatrixAction(params, cfg, opts = {}) {
	const action = readStringParam(params, "action", { required: true });
	const accountId = readStringParam(params, "accountId") ?? void 0;
	const isActionEnabled = createActionGate(resolveMatrixAccountConfig({
		cfg,
		accountId
	}).actions);
	const clientOpts = {
		cfg,
		...accountId ? { accountId } : {}
	};
	if (reactionActions.has(action)) {
		if (!isActionEnabled("reactions")) throw new Error("Matrix reactions are disabled.");
		const roomId = readRoomId(params);
		const messageId = readStringParam(params, "messageId", { required: true });
		if (action === "react") {
			const { emoji, remove, isEmpty } = readReactionParams(params, { removeErrorMessage: "Emoji is required to remove a Matrix reaction." });
			if (remove || isEmpty) return jsonResult({
				ok: true,
				removed: (await removeMatrixReactions(roomId, messageId, {
					...clientOpts,
					emoji: remove ? emoji : void 0
				})).removed
			});
			await reactMatrixMessage(roomId, messageId, emoji, clientOpts);
			return jsonResult({
				ok: true,
				added: emoji
			});
		}
		const limit = readNumberParam(params, "limit", { integer: true });
		return jsonResult({
			ok: true,
			reactions: await listMatrixReactions(roomId, messageId, {
				...clientOpts,
				limit: limit ?? void 0
			})
		});
	}
	if (pollActions.has(action)) {
		const roomId = readRoomId(params);
		const pollId = readStringAliasParam(params, ["pollId", "messageId"], { required: true });
		if (!pollId) throw new Error("pollId required");
		const optionId = readStringParam(params, "pollOptionId");
		const optionIndex = readNumberParam(params, "pollOptionIndex", { integer: true });
		const optionIds = [...readStringArrayParam(params, "pollOptionIds") ?? [], ...optionId ? [optionId] : []];
		const optionIndexes = [...readNumericArrayParam(params, "pollOptionIndexes", { integer: true }), ...optionIndex !== void 0 ? [optionIndex] : []];
		return jsonResult({
			ok: true,
			result: await voteMatrixPoll(roomId, pollId, {
				...clientOpts,
				optionIds,
				optionIndexes
			})
		});
	}
	if (messageActions.has(action)) {
		if (!isActionEnabled("messages")) throw new Error("Matrix messages are disabled.");
		switch (action) {
			case "sendMessage": {
				const to = readStringParam(params, "to", { required: true });
				const mediaUrl = readStringParam(params, "mediaUrl", { trim: false }) ?? readStringParam(params, "media", { trim: false }) ?? readStringParam(params, "filePath", { trim: false }) ?? readStringParam(params, "path", { trim: false });
				const content = readStringParam(params, "content", {
					required: !mediaUrl,
					allowEmpty: true
				});
				const replyToId = readStringParam(params, "replyToId") ?? readStringParam(params, "replyTo");
				const threadId = readStringParam(params, "threadId");
				const audioAsVoice = typeof readRawParam(params, "audioAsVoice") === "boolean" ? readRawParam(params, "audioAsVoice") : typeof readRawParam(params, "asVoice") === "boolean" ? readRawParam(params, "asVoice") : void 0;
				return jsonResult({
					ok: true,
					result: await sendMatrixMessage(to, content, {
						mediaUrl: mediaUrl ?? void 0,
						mediaLocalRoots: opts.mediaLocalRoots,
						replyToId: replyToId ?? void 0,
						threadId: threadId ?? void 0,
						audioAsVoice,
						...clientOpts
					})
				});
			}
			case "editMessage": return jsonResult({
				ok: true,
				result: await editMatrixMessage(readRoomId(params), readStringParam(params, "messageId", { required: true }), readStringParam(params, "content", { required: true }), clientOpts)
			});
			case "deleteMessage":
				await deleteMatrixMessage(readRoomId(params), readStringParam(params, "messageId", { required: true }), {
					reason: readStringParam(params, "reason") ?? void 0,
					...clientOpts
				});
				return jsonResult({
					ok: true,
					deleted: true
				});
			case "readMessages": {
				const roomId = readRoomId(params);
				const limit = readNumberParam(params, "limit", { integer: true });
				const before = readStringParam(params, "before");
				const after = readStringParam(params, "after");
				return jsonResult({
					ok: true,
					...await readMatrixMessages(roomId, {
						limit: limit ?? void 0,
						before: before ?? void 0,
						after: after ?? void 0,
						...clientOpts
					})
				});
			}
			default: break;
		}
	}
	if (pinActions.has(action)) {
		if (!isActionEnabled("pins")) throw new Error("Matrix pins are disabled.");
		const roomId = readRoomId(params);
		if (action === "pinMessage") return jsonResult({
			ok: true,
			pinned: (await pinMatrixMessage(roomId, readStringParam(params, "messageId", { required: true }), clientOpts)).pinned
		});
		if (action === "unpinMessage") return jsonResult({
			ok: true,
			pinned: (await unpinMatrixMessage(roomId, readStringParam(params, "messageId", { required: true }), clientOpts)).pinned
		});
		const result = await listMatrixPins(roomId, clientOpts);
		return jsonResult({
			ok: true,
			pinned: result.pinned,
			events: result.events
		});
	}
	if (profileActions.has(action)) {
		if (!isActionEnabled("profile")) throw new Error("Matrix profile updates are disabled.");
		const avatarPath = readStringParam(params, "avatarPath") ?? readStringParam(params, "path") ?? readStringParam(params, "filePath");
		return jsonResult({
			ok: true,
			...await applyMatrixProfileUpdate({
				cfg,
				account: accountId,
				displayName: readStringParam(params, "displayName") ?? readStringParam(params, "name"),
				avatarUrl: readStringParam(params, "avatarUrl"),
				avatarPath,
				mediaLocalRoots: opts.mediaLocalRoots
			})
		});
	}
	if (action === "memberInfo") {
		if (!isActionEnabled("memberInfo")) throw new Error("Matrix member info is disabled.");
		return jsonResult({
			ok: true,
			member: await getMatrixMemberInfo(readStringParam(params, "userId", { required: true }), {
				roomId: readStringParam(params, "roomId") ?? readStringParam(params, "channelId") ?? void 0,
				...clientOpts
			})
		});
	}
	if (action === "channelInfo") {
		if (!isActionEnabled("channelInfo")) throw new Error("Matrix room info is disabled.");
		return jsonResult({
			ok: true,
			room: await getMatrixRoomInfo(readRoomId(params), clientOpts)
		});
	}
	if (verificationActions.has(action)) {
		if (!isActionEnabled("verification")) throw new Error("Matrix verification actions are disabled.");
		const requestId = readStringParam(params, "requestId") ?? readStringParam(params, "verificationId") ?? readStringParam(params, "id");
		if (action === "encryptionStatus") return jsonResult({
			ok: true,
			status: await getMatrixEncryptionStatus({
				includeRecoveryKey: params.includeRecoveryKey === true,
				...clientOpts
			})
		});
		if (action === "verificationStatus") return jsonResult({
			ok: true,
			status: await getMatrixVerificationStatus({
				includeRecoveryKey: params.includeRecoveryKey === true,
				...clientOpts
			})
		});
		if (action === "verificationBootstrap") {
			const result = await bootstrapMatrixVerification({
				recoveryKey: readStringParam(params, "recoveryKey", { trim: false }) ?? readStringParam(params, "key", { trim: false }) ?? void 0,
				forceResetCrossSigning: params.forceResetCrossSigning === true,
				...clientOpts
			});
			return jsonResult({
				ok: result.success,
				result
			});
		}
		if (action === "verificationRecoveryKey") {
			const result = await verifyMatrixRecoveryKey(readStringParam({ recoveryKey: readStringParam(params, "recoveryKey", { trim: false }) ?? readStringParam(params, "key", { trim: false }) }, "recoveryKey", {
				required: true,
				trim: false
			}), clientOpts);
			return jsonResult({
				ok: result.success,
				result
			});
		}
		if (action === "verificationBackupStatus") return jsonResult({
			ok: true,
			status: await getMatrixRoomKeyBackupStatus(clientOpts)
		});
		if (action === "verificationBackupRestore") {
			const result = await restoreMatrixRoomKeyBackup({
				recoveryKey: readStringParam(params, "recoveryKey", { trim: false }) ?? readStringParam(params, "key", { trim: false }) ?? void 0,
				...clientOpts
			});
			return jsonResult({
				ok: result.success,
				result
			});
		}
		if (action === "verificationList") return jsonResult({
			ok: true,
			verifications: await listMatrixVerifications(clientOpts)
		});
		if (action === "verificationRequest") {
			const userId = readStringParam(params, "userId");
			const deviceId = readStringParam(params, "deviceId");
			const roomId = readStringParam(params, "roomId") ?? readStringParam(params, "channelId");
			return jsonResult({
				ok: true,
				verification: await requestMatrixVerification({
					ownUser: typeof params.ownUser === "boolean" ? params.ownUser : void 0,
					userId: userId ?? void 0,
					deviceId: deviceId ?? void 0,
					roomId: roomId ?? void 0,
					...clientOpts
				})
			});
		}
		if (action === "verificationAccept") return jsonResult({
			ok: true,
			verification: await acceptMatrixVerification(readStringParam({ requestId }, "requestId", { required: true }), clientOpts)
		});
		if (action === "verificationCancel") {
			const reason = readStringParam(params, "reason");
			const code = readStringParam(params, "code");
			return jsonResult({
				ok: true,
				verification: await cancelMatrixVerification(readStringParam({ requestId }, "requestId", { required: true }), {
					reason: reason ?? void 0,
					code: code ?? void 0,
					...clientOpts
				})
			});
		}
		if (action === "verificationStart") {
			const method = normalizeOptionalLowercaseString(readStringParam(params, "method"));
			if (method && method !== "sas") throw new Error("Matrix verificationStart only supports method=sas; use verificationGenerateQr/verificationScanQr for QR flows.");
			return jsonResult({
				ok: true,
				verification: await startMatrixVerification(readStringParam({ requestId }, "requestId", { required: true }), {
					method: "sas",
					...clientOpts
				})
			});
		}
		if (action === "verificationGenerateQr") return jsonResult({
			ok: true,
			...await generateMatrixVerificationQr(readStringParam({ requestId }, "requestId", { required: true }), clientOpts)
		});
		if (action === "verificationScanQr") {
			const qrDataBase64 = readStringParam(params, "qrDataBase64") ?? readStringParam(params, "qrData") ?? readStringParam(params, "qr");
			return jsonResult({
				ok: true,
				verification: await scanMatrixVerificationQr(readStringParam({ requestId }, "requestId", { required: true }), readStringParam({ qrDataBase64 }, "qrDataBase64", { required: true }), clientOpts)
			});
		}
		if (action === "verificationSas") return jsonResult({
			ok: true,
			sas: await getMatrixVerificationSas(readStringParam({ requestId }, "requestId", { required: true }), clientOpts)
		});
		if (action === "verificationConfirm") return jsonResult({
			ok: true,
			verification: await confirmMatrixVerificationSas(readStringParam({ requestId }, "requestId", { required: true }), clientOpts)
		});
		if (action === "verificationMismatch") return jsonResult({
			ok: true,
			verification: await mismatchMatrixVerificationSas(readStringParam({ requestId }, "requestId", { required: true }), clientOpts)
		});
		if (action === "verificationConfirmQr") return jsonResult({
			ok: true,
			verification: await confirmMatrixVerificationReciprocateQr(readStringParam({ requestId }, "requestId", { required: true }), clientOpts)
		});
	}
	throw new Error(`Unsupported Matrix action: ${action}`);
}
//#endregion
export { handleMatrixAction };
