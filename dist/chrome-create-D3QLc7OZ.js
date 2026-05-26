import { _ as sleep } from "./utils-sBTEdeml.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./runtime-env-BtvWnLRh.js";
import "./ssrf-runtime-Be2o3zD7.js";
//#region extensions/google-meet/src/google-api-errors.ts
const REAUTH_HINT = "Re-run `openclaw googlemeet auth login` and store the refreshed oauth block.";
function scopeText(scopes) {
	return scopes.map((scope) => `\`${scope}\``).join(", ");
}
async function googleApiError(params) {
	const scopeHint = params.scopes && params.scopes.length > 0 ? ` Required OAuth scope: ${scopeText(params.scopes)}. ${REAUTH_HINT}` : "";
	return /* @__PURE__ */ new Error(`${params.prefix} failed (${params.response.status}): ${params.detail}${scopeHint}`);
}
//#endregion
//#region extensions/google-meet/src/drive.ts
const GOOGLE_DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_API_HOST = "www.googleapis.com";
const GOOGLE_DRIVE_MEET_SCOPE = "https://www.googleapis.com/auth/drive.meet.readonly";
const TEXT_PLAIN_MIME = "text/plain";
function appendQuery$1(url, query) {
	const parsed = new URL(url);
	for (const [key, value] of Object.entries(query)) if (value !== void 0) parsed.searchParams.set(key, value);
	return parsed.toString();
}
function extractGoogleDriveDocumentId(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (!trimmed) return;
	if (/^https?:\/\//i.test(trimmed)) try {
		return new URL(trimmed).pathname.match(/\/document\/d\/([^/]+)/)?.[1];
	} catch {
		return;
	}
	return trimmed.split("/").filter(Boolean).at(-1);
}
async function exportGoogleDriveDocumentText(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: appendQuery$1(`${GOOGLE_DRIVE_API_BASE_URL}/files/${encodeURIComponent(params.documentId)}/export`, { mimeType: TEXT_PLAIN_MIME }),
		init: { headers: {
			Authorization: `Bearer ${params.accessToken}`,
			Accept: TEXT_PLAIN_MIME
		} },
		policy: { allowedHostnames: [GOOGLE_DRIVE_API_HOST] },
		auditContext: "google-meet.drive.files.export"
	});
	try {
		if (!response.ok) throw await googleApiError({
			response,
			detail: await response.text(),
			prefix: "Google Drive files.export",
			scopes: [GOOGLE_DRIVE_MEET_SCOPE]
		});
		return await response.text();
	} finally {
		await release();
	}
}
//#endregion
//#region extensions/google-meet/src/meet.ts
const GOOGLE_MEET_API_BASE_URL = `https://meet.googleapis.com/v2`;
const GOOGLE_MEET_URL_HOST = "meet.google.com";
const GOOGLE_MEET_API_HOST = "meet.googleapis.com";
const GOOGLE_MEET_MEDIA_SCOPE = "https://www.googleapis.com/auth/meetings.conference.media.readonly";
const GOOGLE_MEET_SPACE_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";
const GOOGLE_MEET_SPACE_CREATED_SCOPE = "https://www.googleapis.com/auth/meetings.space.created";
const GOOGLE_MEET_SPACE_SETTINGS_SCOPE = "https://www.googleapis.com/auth/meetings.space.settings";
function normalizeGoogleMeetSpaceName(input) {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Meeting input is required");
	if (trimmed.startsWith("spaces/")) {
		const suffix = trimmed.slice(7).trim();
		if (!suffix) throw new Error("spaces/ input must include a meeting code or space id");
		return `spaces/${suffix}`;
	}
	if (/^https?:\/\//i.test(trimmed)) {
		const url = new URL(trimmed);
		if (url.hostname !== GOOGLE_MEET_URL_HOST) throw new Error(`Expected a ${GOOGLE_MEET_URL_HOST} URL, received ${url.hostname}`);
		const firstSegment = url.pathname.split("/").map((segment) => segment.trim()).find(Boolean);
		if (!firstSegment) throw new Error("Google Meet URL did not include a meeting code");
		return `spaces/${firstSegment}`;
	}
	return `spaces/${trimmed}`;
}
function encodeSpaceNameForPath(name) {
	return name.split("/").map(encodeURIComponent).join("/");
}
function encodeResourceNameForPath(name) {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Google Meet resource name is required");
	return trimmed.split("/").map(encodeURIComponent).join("/");
}
function normalizeConferenceRecordName(input) {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Conference record is required");
	return trimmed.startsWith("conferenceRecords/") ? trimmed : `conferenceRecords/${trimmed}`;
}
function appendQuery(url, query) {
	if (!query) return url;
	const parsed = new URL(url);
	for (const [key, value] of Object.entries(query)) if (value !== void 0) parsed.searchParams.set(key, String(value));
	return parsed.toString();
}
function assertResourceArray(value, key, context) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new Error(`Google Meet ${context} response had non-array ${key}`);
	const resources = value;
	for (const resource of resources) if (!resource.name?.trim()) throw new Error(`Google Meet ${context} response included a resource without name`);
	return resources;
}
function getErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
async function fetchGoogleMeetJson(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: appendQuery(`${GOOGLE_MEET_API_BASE_URL}/${params.path}`, params.query),
		init: { headers: {
			Authorization: `Bearer ${params.accessToken}`,
			Accept: "application/json"
		} },
		policy: { allowedHostnames: [GOOGLE_MEET_API_HOST] },
		auditContext: params.auditContext
	});
	try {
		if (!response.ok) throw await googleApiError({
			response,
			detail: await response.text(),
			prefix: params.errorPrefix,
			scopes: [GOOGLE_MEET_MEDIA_SCOPE]
		});
		return await response.json();
	} finally {
		await release();
	}
}
async function listGoogleMeetCollection(params) {
	const items = [];
	let pageToken;
	do {
		const payload = await fetchGoogleMeetJson({
			accessToken: params.accessToken,
			path: params.path,
			query: {
				...params.query,
				pageToken
			},
			auditContext: params.auditContext,
			errorPrefix: params.errorPrefix
		});
		const pageItems = assertResourceArray(payload[params.collectionKey], params.collectionKey, params.errorPrefix);
		const remaining = typeof params.maxItems === "number" ? Math.max(params.maxItems - items.length, 0) : void 0;
		items.push(...remaining === void 0 ? pageItems : pageItems.slice(0, remaining));
		if (typeof params.maxItems === "number" && items.length >= params.maxItems) break;
		pageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : void 0;
	} while (pageToken);
	return items;
}
async function fetchGoogleMeetSpace(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: `${GOOGLE_MEET_API_BASE_URL}/${encodeSpaceNameForPath(normalizeGoogleMeetSpaceName(params.meeting))}`,
		init: { headers: {
			Authorization: `Bearer ${params.accessToken}`,
			Accept: "application/json"
		} },
		policy: { allowedHostnames: [GOOGLE_MEET_API_HOST] },
		auditContext: "google-meet.spaces.get"
	});
	try {
		if (!response.ok) throw await googleApiError({
			response,
			detail: await response.text(),
			prefix: "Google Meet spaces.get",
			scopes: [GOOGLE_MEET_SPACE_SCOPE]
		});
		const payload = await response.json();
		if (!payload.name?.trim()) throw new Error("Google Meet spaces.get response was missing name");
		return payload;
	} finally {
		await release();
	}
}
async function createGoogleMeetSpace(params) {
	const body = params.config && Object.keys(params.config).length > 0 ? JSON.stringify({ config: params.config }) : "{}";
	const { response, release } = await fetchWithSsrFGuard({
		url: `${GOOGLE_MEET_API_BASE_URL}/spaces`,
		init: {
			method: "POST",
			headers: {
				Authorization: `Bearer ${params.accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json"
			},
			body
		},
		policy: { allowedHostnames: [GOOGLE_MEET_API_HOST] },
		auditContext: "google-meet.spaces.create"
	});
	try {
		if (!response.ok) throw await googleApiError({
			response,
			detail: await response.text(),
			prefix: "Google Meet spaces.create",
			scopes: params.config && Object.keys(params.config).length > 0 ? [GOOGLE_MEET_SPACE_CREATED_SCOPE, GOOGLE_MEET_SPACE_SETTINGS_SCOPE] : [GOOGLE_MEET_SPACE_CREATED_SCOPE]
		});
		const payload = await response.json();
		if (!payload.name?.trim()) throw new Error("Google Meet spaces.create response was missing name");
		const meetingUri = payload.meetingUri?.trim();
		if (!meetingUri) throw new Error("Google Meet spaces.create response was missing meetingUri");
		return {
			space: payload,
			meetingUri
		};
	} finally {
		await release();
	}
}
async function endGoogleMeetActiveConference(params) {
	const space = (await fetchGoogleMeetSpace({
		accessToken: params.accessToken,
		meeting: params.meeting
	})).name;
	const { response, release } = await fetchWithSsrFGuard({
		url: `${GOOGLE_MEET_API_BASE_URL}/${encodeSpaceNameForPath(space)}:endActiveConference`,
		init: {
			method: "POST",
			headers: {
				Authorization: `Bearer ${params.accessToken}`,
				Accept: "application/json",
				"Content-Type": "application/json"
			},
			body: "{}"
		},
		policy: { allowedHostnames: [GOOGLE_MEET_API_HOST] },
		auditContext: "google-meet.spaces.endActiveConference"
	});
	try {
		if (!response.ok) throw await googleApiError({
			response,
			detail: await response.text(),
			prefix: "Google Meet spaces.endActiveConference",
			scopes: [GOOGLE_MEET_SPACE_CREATED_SCOPE]
		});
		return {
			space,
			ended: true
		};
	} finally {
		await release();
	}
}
async function fetchGoogleMeetConferenceRecord(params) {
	const name = normalizeConferenceRecordName(params.conferenceRecord);
	const payload = await fetchGoogleMeetJson({
		accessToken: params.accessToken,
		path: encodeResourceNameForPath(name),
		auditContext: "google-meet.conferenceRecords.get",
		errorPrefix: "Google Meet conferenceRecords.get"
	});
	if (!payload.name?.trim()) throw new Error("Google Meet conferenceRecords.get response was missing name");
	return payload;
}
async function listGoogleMeetConferenceRecords(params) {
	const filter = params.meeting ? `space.name = "${normalizeGoogleMeetSpaceName(params.meeting)}"` : void 0;
	return listGoogleMeetCollection({
		accessToken: params.accessToken,
		path: "conferenceRecords",
		collectionKey: "conferenceRecords",
		query: {
			pageSize: params.pageSize,
			filter
		},
		maxItems: params.maxItems,
		auditContext: "google-meet.conferenceRecords.list",
		errorPrefix: "Google Meet conferenceRecords.list"
	});
}
async function fetchLatestGoogleMeetConferenceRecord(params) {
	const space = await fetchGoogleMeetSpace({
		accessToken: params.accessToken,
		meeting: params.meeting
	});
	const [conferenceRecord] = await listGoogleMeetConferenceRecords({
		accessToken: params.accessToken,
		meeting: space.name,
		pageSize: 1,
		maxItems: 1
	});
	return {
		input: params.meeting,
		space,
		...conferenceRecord ? { conferenceRecord } : {}
	};
}
async function listGoogleMeetParticipants(params) {
	const parent = normalizeConferenceRecordName(params.conferenceRecord);
	return listGoogleMeetCollection({
		accessToken: params.accessToken,
		path: `${encodeResourceNameForPath(parent)}/participants`,
		collectionKey: "participants",
		query: { pageSize: params.pageSize },
		auditContext: "google-meet.conferenceRecords.participants.list",
		errorPrefix: "Google Meet conferenceRecords.participants.list"
	});
}
async function listGoogleMeetParticipantSessions(params) {
	return listGoogleMeetCollection({
		accessToken: params.accessToken,
		path: `${encodeResourceNameForPath(params.participant)}/participantSessions`,
		collectionKey: "participantSessions",
		query: { pageSize: params.pageSize },
		auditContext: "google-meet.conferenceRecords.participants.participantSessions.list",
		errorPrefix: "Google Meet conferenceRecords.participants.participantSessions.list"
	});
}
async function listGoogleMeetRecordings(params) {
	const parent = normalizeConferenceRecordName(params.conferenceRecord);
	return listGoogleMeetCollection({
		accessToken: params.accessToken,
		path: `${encodeResourceNameForPath(parent)}/recordings`,
		collectionKey: "recordings",
		query: { pageSize: params.pageSize },
		auditContext: "google-meet.conferenceRecords.recordings.list",
		errorPrefix: "Google Meet conferenceRecords.recordings.list"
	});
}
async function listGoogleMeetTranscripts(params) {
	const parent = normalizeConferenceRecordName(params.conferenceRecord);
	return listGoogleMeetCollection({
		accessToken: params.accessToken,
		path: `${encodeResourceNameForPath(parent)}/transcripts`,
		collectionKey: "transcripts",
		query: { pageSize: params.pageSize },
		auditContext: "google-meet.conferenceRecords.transcripts.list",
		errorPrefix: "Google Meet conferenceRecords.transcripts.list"
	});
}
async function listGoogleMeetTranscriptEntries(params) {
	return listGoogleMeetCollection({
		accessToken: params.accessToken,
		path: `${encodeResourceNameForPath(params.transcript)}/entries`,
		collectionKey: "transcriptEntries",
		query: { pageSize: params.pageSize },
		auditContext: "google-meet.conferenceRecords.transcripts.entries.list",
		errorPrefix: "Google Meet conferenceRecords.transcripts.entries.list"
	});
}
async function listGoogleMeetSmartNotes(params) {
	const parent = normalizeConferenceRecordName(params.conferenceRecord);
	return listGoogleMeetCollection({
		accessToken: params.accessToken,
		path: `${encodeResourceNameForPath(parent)}/smartNotes`,
		collectionKey: "smartNotes",
		query: { pageSize: params.pageSize },
		auditContext: "google-meet.conferenceRecords.smartNotes.list",
		errorPrefix: "Google Meet conferenceRecords.smartNotes.list"
	});
}
function getParticipantDisplayName(participant) {
	return participant.signedinUser?.displayName ?? participant.anonymousUser?.displayName ?? participant.phoneUser?.displayName;
}
function getParticipantUser(participant) {
	return participant.signedinUser?.user;
}
function getDocsDestinationDocumentId(destination) {
	return extractGoogleDriveDocumentId(destination?.document) ?? extractGoogleDriveDocumentId(destination?.documentId) ?? extractGoogleDriveDocumentId(destination?.file);
}
async function attachDocumentText(params) {
	const documentId = getDocsDestinationDocumentId(params.resource.docsDestination);
	if (!documentId) return params.resource;
	try {
		return {
			...params.resource,
			documentText: await exportGoogleDriveDocumentText({
				accessToken: params.accessToken,
				documentId
			})
		};
	} catch (error) {
		return {
			...params.resource,
			documentTextError: getErrorMessage(error)
		};
	}
}
function parseGoogleMeetTimestamp(value) {
	if (!value?.trim()) return;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function isoFromMs(value) {
	return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : void 0;
}
function minTimestamp(values) {
	const parsed = values.map(parseGoogleMeetTimestamp).filter((value) => typeof value === "number");
	return parsed.length > 0 ? isoFromMs(Math.min(...parsed)) : void 0;
}
function maxTimestamp(values) {
	const parsed = values.map(parseGoogleMeetTimestamp).filter((value) => typeof value === "number");
	return parsed.length > 0 ? isoFromMs(Math.max(...parsed)) : void 0;
}
function sumSessionDurationMs(sessions, fallbackStart, fallbackEnd) {
	const sessionTotal = sessions.reduce((total, session) => {
		const startMs = parseGoogleMeetTimestamp(session.startTime);
		const endMs = parseGoogleMeetTimestamp(session.endTime);
		return startMs !== void 0 && endMs !== void 0 && endMs > startMs ? total + (endMs - startMs) : total;
	}, 0);
	if (sessionTotal > 0) return sessionTotal;
	const startMs = parseGoogleMeetTimestamp(fallbackStart);
	const endMs = parseGoogleMeetTimestamp(fallbackEnd);
	return startMs !== void 0 && endMs !== void 0 && endMs > startMs ? endMs - startMs : void 0;
}
function attendanceMergeKey(row) {
	return (row.user ?? row.displayName ?? row.participant).trim().toLocaleLowerCase();
}
function sortSessions(sessions) {
	return sessions.toSorted((left, right) => (parseGoogleMeetTimestamp(left.startTime) ?? 0) - (parseGoogleMeetTimestamp(right.startTime) ?? 0));
}
function decorateAttendanceRow(row, conferenceRecord, params) {
	const sessions = sortSessions(row.sessions);
	const firstJoinTime = minTimestamp([row.earliestStartTime, ...sessions.map((session) => session.startTime)]);
	const lastLeaveTime = maxTimestamp([row.latestEndTime, ...sessions.map((session) => session.endTime)]);
	const durationMs = sumSessionDurationMs(sessions, firstJoinTime, lastLeaveTime);
	const conferenceStartMs = parseGoogleMeetTimestamp(conferenceRecord.startTime);
	const conferenceEndMs = parseGoogleMeetTimestamp(conferenceRecord.endTime);
	const firstJoinMs = parseGoogleMeetTimestamp(firstJoinTime);
	const lastLeaveMs = parseGoogleMeetTimestamp(lastLeaveTime);
	const lateGraceMs = (params.lateAfterMinutes ?? 5) * 6e4;
	const earlyGraceMs = (params.earlyBeforeMinutes ?? 5) * 6e4;
	const lateByMs = conferenceStartMs !== void 0 && firstJoinMs !== void 0 ? Math.max(firstJoinMs - conferenceStartMs, 0) : void 0;
	const earlyLeaveByMs = conferenceEndMs !== void 0 && lastLeaveMs !== void 0 ? Math.max(conferenceEndMs - lastLeaveMs, 0) : void 0;
	const decorated = {
		...row,
		sessions,
		participants: row.participants ?? [row.participant]
	};
	decorated.earliestStartTime = firstJoinTime ?? row.earliestStartTime;
	decorated.latestEndTime = lastLeaveTime ?? row.latestEndTime;
	if (firstJoinTime) decorated.firstJoinTime = firstJoinTime;
	if (lastLeaveTime) decorated.lastLeaveTime = lastLeaveTime;
	if (durationMs !== void 0) decorated.durationMs = durationMs;
	if (lateByMs !== void 0) {
		decorated.late = lateByMs > lateGraceMs;
		if (decorated.late) decorated.lateByMs = lateByMs;
	}
	if (earlyLeaveByMs !== void 0) {
		decorated.earlyLeave = earlyLeaveByMs > earlyGraceMs;
		if (decorated.earlyLeave) decorated.earlyLeaveByMs = earlyLeaveByMs;
	}
	return decorated;
}
function mergeAttendanceRows(rows, conferenceRecord, params) {
	if (params.mergeDuplicateParticipants === false) return rows.map((row) => decorateAttendanceRow(row, conferenceRecord, params));
	const grouped = /* @__PURE__ */ new Map();
	for (const row of rows) {
		const key = attendanceMergeKey(row);
		const existing = grouped.get(key);
		if (!existing) {
			grouped.set(key, {
				...row,
				participants: [row.participant]
			});
			continue;
		}
		existing.participants = [...new Set([...existing.participants ?? [existing.participant], row.participant])];
		existing.sessions.push(...row.sessions);
		existing.displayName ??= row.displayName;
		existing.user ??= row.user;
		existing.earliestStartTime = minTimestamp([existing.earliestStartTime, row.earliestStartTime]);
		existing.latestEndTime = maxTimestamp([existing.latestEndTime, row.latestEndTime]);
	}
	return [...grouped.values()].map((row) => decorateAttendanceRow(row, conferenceRecord, params));
}
async function resolveConferenceRecordQuery(params) {
	if (params.conferenceRecord?.trim()) {
		const conferenceRecord = await fetchGoogleMeetConferenceRecord({
			accessToken: params.accessToken,
			conferenceRecord: params.conferenceRecord
		});
		return {
			input: params.conferenceRecord.trim(),
			conferenceRecords: [conferenceRecord]
		};
	}
	if (!params.meeting?.trim()) throw new Error("Meeting input or conference record is required");
	const space = await fetchGoogleMeetSpace({
		accessToken: params.accessToken,
		meeting: params.meeting
	});
	const conferenceRecords = await listGoogleMeetConferenceRecords({
		accessToken: params.accessToken,
		meeting: space.name,
		pageSize: params.allConferenceRecords ? params.pageSize : 1,
		maxItems: params.allConferenceRecords ? void 0 : 1
	});
	return {
		input: params.meeting,
		space,
		conferenceRecords
	};
}
async function fetchGoogleMeetArtifacts(params) {
	const resolved = await resolveConferenceRecordQuery(params);
	const artifacts = await Promise.all(resolved.conferenceRecords.map(async (conferenceRecord) => {
		const [participants, recordings, transcripts, smartNotesResult] = await Promise.all([
			listGoogleMeetParticipants({
				accessToken: params.accessToken,
				conferenceRecord: conferenceRecord.name,
				pageSize: params.pageSize
			}),
			listGoogleMeetRecordings({
				accessToken: params.accessToken,
				conferenceRecord: conferenceRecord.name,
				pageSize: params.pageSize
			}),
			listGoogleMeetTranscripts({
				accessToken: params.accessToken,
				conferenceRecord: conferenceRecord.name,
				pageSize: params.pageSize
			}),
			listGoogleMeetSmartNotes({
				accessToken: params.accessToken,
				conferenceRecord: conferenceRecord.name,
				pageSize: params.pageSize
			}).then((smartNotes) => ({ smartNotes })).catch((error) => ({
				smartNotes: [],
				smartNotesError: getErrorMessage(error)
			}))
		]);
		const transcriptEntries = params.includeTranscriptEntries === false ? [] : await Promise.all(transcripts.map(async (transcript) => {
			try {
				return {
					transcript: transcript.name,
					entries: await listGoogleMeetTranscriptEntries({
						accessToken: params.accessToken,
						transcript: transcript.name,
						pageSize: params.pageSize
					})
				};
			} catch (error) {
				return {
					transcript: transcript.name,
					entries: [],
					entriesError: getErrorMessage(error)
				};
			}
		}));
		return {
			conferenceRecord,
			participants,
			recordings,
			transcripts: params.includeDocumentBodies === true ? await Promise.all(transcripts.map((transcript) => attachDocumentText({
				accessToken: params.accessToken,
				resource: transcript
			}))) : transcripts,
			transcriptEntries,
			smartNotes: params.includeDocumentBodies === true ? await Promise.all(smartNotesResult.smartNotes.map((smartNote) => attachDocumentText({
				accessToken: params.accessToken,
				resource: smartNote
			}))) : smartNotesResult.smartNotes,
			...smartNotesResult.smartNotesError ? { smartNotesError: smartNotesResult.smartNotesError } : {}
		};
	}));
	return {
		input: resolved.input,
		space: resolved.space,
		conferenceRecords: resolved.conferenceRecords,
		artifacts
	};
}
async function fetchGoogleMeetAttendance(params) {
	const resolved = await resolveConferenceRecordQuery(params);
	const nestedRows = await Promise.all(resolved.conferenceRecords.map(async (conferenceRecord) => {
		const participants = await listGoogleMeetParticipants({
			accessToken: params.accessToken,
			conferenceRecord: conferenceRecord.name,
			pageSize: params.pageSize
		});
		return mergeAttendanceRows(await Promise.all(participants.map(async (participant) => ({
			conferenceRecord: conferenceRecord.name,
			participant: participant.name,
			displayName: getParticipantDisplayName(participant),
			user: getParticipantUser(participant),
			earliestStartTime: participant.earliestStartTime,
			latestEndTime: participant.latestEndTime,
			sessions: await listGoogleMeetParticipantSessions({
				accessToken: params.accessToken,
				participant: participant.name,
				pageSize: params.pageSize
			})
		}))), conferenceRecord, params);
	}));
	return {
		input: resolved.input,
		space: resolved.space,
		conferenceRecords: resolved.conferenceRecords,
		attendance: nestedRows.flat()
	};
}
function buildGoogleMeetPreflightReport(params) {
	const blockers = [];
	if (!params.previewAcknowledged) blockers.push("Set preview.enrollmentAcknowledged=true after confirming your Cloud project, OAuth principal, and meeting participants are enrolled in the Google Workspace Developer Preview Program.");
	return {
		input: params.input,
		resolvedSpaceName: params.space.name,
		meetingCode: params.space.meetingCode,
		meetingUri: params.space.meetingUri,
		hasActiveConference: Boolean(params.space.activeConference),
		previewAcknowledged: params.previewAcknowledged,
		tokenSource: params.tokenSource,
		blockers
	};
}
//#endregion
//#region extensions/google-meet/src/transports/chrome-browser-proxy.ts
function normalizeMeetUrlForReuse(url) {
	if (!url) return;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "meet.google.com") return;
		const match = parsed.pathname.match(/^\/(new|[a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/)?$/i);
		if (!match?.[1]) return;
		return `https://meet.google.com/${match[1].toLowerCase()}`;
	} catch {
		return;
	}
}
function isSameMeetUrlForReuse(a, b) {
	const normalizedA = normalizeMeetUrlForReuse(a);
	const normalizedB = normalizeMeetUrlForReuse(b);
	return Boolean(normalizedA && normalizedB && normalizedA === normalizedB);
}
function isGoogleMeetNode(node) {
	const commands = Array.isArray(node.commands) ? node.commands : [];
	const caps = Array.isArray(node.caps) ? node.caps : [];
	return node.connected === true && commands.includes("googlemeet.chrome") && (commands.includes("browser.proxy") || caps.includes("browser"));
}
function matchesRequestedNode(node, requested) {
	return [
		node.nodeId,
		node.displayName,
		node.remoteIp
	].some((value) => value === requested);
}
function formatNodeLabel(node) {
	const parts = [
		node.displayName,
		node.nodeId,
		node.remoteIp
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" / ") : "unknown node";
}
function describeNodeUsabilityIssues(node) {
	const commands = Array.isArray(node.commands) ? node.commands : [];
	const caps = Array.isArray(node.caps) ? node.caps : [];
	const issues = [];
	if (node.connected !== true) issues.push("offline");
	if (!commands.includes("googlemeet.chrome")) issues.push("missing googlemeet.chrome");
	if (!commands.includes("browser.proxy") && !caps.includes("browser")) issues.push("missing browser.proxy/browser capability");
	return issues;
}
async function listGoogleMeetNodes(runtime, params) {
	try {
		return params ? await runtime.nodes.list(params) : await runtime.nodes.list();
	} catch (error) {
		throw new Error("Google Meet node inventory unavailable", { cause: error });
	}
}
async function resolveChromeNodeInfo(params) {
	const requested = params.requestedNode?.trim();
	if (requested) {
		const matches = (await listGoogleMeetNodes(params.runtime)).nodes.filter((node) => matchesRequestedNode(node, requested));
		if (matches.length === 1) {
			const [node] = matches;
			if (isGoogleMeetNode(node)) return node;
			throw new Error(`Configured Google Meet node ${requested} is not usable (${formatNodeLabel(node)}): ${describeNodeUsabilityIssues(node).join("; ")}. Start or reinstall \`openclaw node run\` on that Chrome host, approve pairing, and allow googlemeet.chrome plus browser.proxy.`);
		}
		if (matches.length > 1) throw new Error(`Configured Google Meet node ${requested} is ambiguous (${matches.length} matches). Pin chromeNode.node to a unique node id, display name, or remote IP.`);
		throw new Error(`Configured Google Meet node ${requested} was not found. Run \`openclaw nodes status\` and start or approve the Chrome node.`);
	}
	const nodes = (await listGoogleMeetNodes(params.runtime, { connected: true })).nodes.filter(isGoogleMeetNode);
	if (nodes.length === 0) throw new Error("No connected Google Meet-capable node with browser proxy. Run `openclaw node run` on the Chrome host with browser proxy enabled, approve pairing, and allow googlemeet.chrome plus browser.proxy.");
	if (nodes.length === 1) return nodes[0];
	throw new Error("Multiple Google Meet-capable nodes connected. Set plugins.entries.google-meet.config.chromeNode.node.");
}
async function resolveChromeNode(params) {
	const node = await resolveChromeNodeInfo(params);
	if (!node.nodeId) throw new Error("Google Meet node did not include a node id.");
	return node.nodeId;
}
function unwrapNodeInvokePayload(raw) {
	const record = raw && typeof raw === "object" ? raw : {};
	if (typeof record.payloadJSON === "string" && record.payloadJSON.trim()) try {
		return JSON.parse(record.payloadJSON);
	} catch (error) {
		throw new Error("Google Meet browser proxy returned malformed payloadJSON.", { cause: error });
	}
	if ("payload" in record) return record.payload;
	return raw;
}
function parseBrowserProxyResult(raw) {
	const payload = unwrapNodeInvokePayload(raw);
	const proxy = payload && typeof payload === "object" ? payload : void 0;
	if (!proxy || !("result" in proxy)) throw new Error("Google Meet browser proxy returned an invalid result.");
	return proxy.result;
}
async function callBrowserProxyOnNode(params) {
	return parseBrowserProxyResult(await params.runtime.nodes.invoke({
		nodeId: params.nodeId,
		command: "browser.proxy",
		params: {
			method: params.method,
			path: params.path,
			body: params.body,
			timeoutMs: params.timeoutMs
		},
		timeoutMs: params.timeoutMs + 5e3
	}));
}
function asBrowserTabs(result) {
	const record = result && typeof result === "object" ? result : {};
	return Array.isArray(record.tabs) ? record.tabs : [];
}
function readBrowserTab(result) {
	return result && typeof result === "object" ? result : void 0;
}
//#endregion
//#region extensions/google-meet/src/transports/chrome-create.ts
const GOOGLE_MEET_NEW_URL = "https://meet.google.com/new";
const GOOGLE_MEET_BROWSER_CREATE_TIMEOUT_MS = 6e4;
const GOOGLE_MEET_BROWSER_STEP_TIMEOUT_MS = 1e4;
const GOOGLE_MEET_BROWSER_NAVIGATION_RETRY_MS = 1e3;
const GOOGLE_MEET_BROWSER_POLL_MS = 500;
var GoogleMeetBrowserManualActionError = class extends Error {
	constructor(payload) {
		const prefix = payload.manualActionReason ? `${payload.manualActionReason}: ` : "";
		super(`${prefix}${payload.manualActionMessage}`);
		this.name = "GoogleMeetBrowserManualActionError";
		this.payload = {
			source: "browser",
			error: this.message,
			...payload
		};
	}
};
function isGoogleMeetBrowserManualActionError(error) {
	return error instanceof GoogleMeetBrowserManualActionError;
}
function formatBrowserAutomationError(error) {
	if (error instanceof Error) return error.message;
	try {
		return JSON.stringify(error);
	} catch {
		return "unknown error";
	}
}
function isBrowserNavigationInterruption(error) {
	return /execution context was destroyed|navigation|target closed/i.test(formatBrowserAutomationError(error));
}
function isGoogleMeetCreateTab(tab) {
	const url = tab.url ?? "";
	if (/^https:\/\/meet\.google\.com\/(?:new|[a-z]{3}-[a-z]{4}-[a-z]{3})(?:$|[/?#])/i.test(url)) return true;
	return url.startsWith("https://accounts.google.com/") && /sign in|google accounts|meet/i.test(tab.title ?? "");
}
async function findGoogleMeetCreateTab(params) {
	return asBrowserTabs(await callBrowserProxyOnNode({
		runtime: params.runtime,
		nodeId: params.nodeId,
		method: "GET",
		path: "/tabs",
		timeoutMs: params.timeoutMs
	})).find(isGoogleMeetCreateTab);
}
async function focusBrowserTab(params) {
	await callBrowserProxyOnNode({
		runtime: params.runtime,
		nodeId: params.nodeId,
		method: "POST",
		path: "/tabs/focus",
		body: { targetId: params.targetId },
		timeoutMs: params.timeoutMs
	});
}
function readStringArray(value) {
	return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : void 0;
}
function readBrowserCreateResult(result) {
	const record = result && typeof result === "object" ? result : {};
	const nested = record.result && typeof record.result === "object" ? record.result : record;
	return {
		meetingUri: typeof nested.meetingUri === "string" ? nested.meetingUri : void 0,
		browserUrl: typeof nested.browserUrl === "string" ? nested.browserUrl : void 0,
		browserTitle: typeof nested.browserTitle === "string" ? nested.browserTitle : void 0,
		manualAction: typeof nested.manualAction === "string" ? nested.manualAction : void 0,
		manualActionReason: typeof nested.manualActionReason === "string" ? nested.manualActionReason : void 0,
		notes: readStringArray(nested.notes),
		retryAfterMs: typeof nested.retryAfterMs === "number" && Number.isFinite(nested.retryAfterMs) ? nested.retryAfterMs : void 0
	};
}
const CREATE_MEET_FROM_BROWSER_SCRIPT = `async () => {
  const meetUrlPattern = /^https:\\/\\/meet\\.google\\.com\\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:$|[/?#])/i;
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const current = () => location.href;
  const notes = [];
  const findButton = (pattern) =>
    [...document.querySelectorAll("button")].find((button) => {
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("data-tooltip"),
        text(button),
      ]
        .filter(Boolean)
        .join(" ");
      return pattern.test(label) && !button.disabled;
    });
  const clickButton = (pattern, note) => {
    const button = findButton(pattern);
    if (!button) {
      return false;
    }
    button.click();
    notes.push(note);
    return true;
  };
  if (!current().startsWith("https://meet.google.com/")) {
    return {
      manualActionReason: "google-login-required",
      manualAction: "Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
      browserUrl: current(),
      browserTitle: document.title,
      notes,
    };
  }
  const href = current();
  if (meetUrlPattern.test(href)) {
    return { meetingUri: href, browserUrl: href, browserTitle: document.title, notes };
  }
  const pageText = text(document.body);
  if (clickButton(/\\buse microphone\\b/i, "Accepted Meet microphone prompt with browser automation.")) {
    return { browserUrl: href, browserTitle: document.title, notes, retryAfterMs: 1000 };
  }
  if (
    clickButton(
      /continue without microphone/i,
      "Continued through Meet microphone prompt with browser automation.",
    )
  ) {
    return { browserUrl: href, browserTitle: document.title, notes, retryAfterMs: 1000 };
  }
  if (/do you want people to hear you in the meeting/i.test(pageText)) {
    return {
      manualActionReason: "meet-audio-choice-required",
      manualAction: "Meet is showing the microphone choice. Click Use microphone in the OpenClaw browser profile, then retry meeting creation.",
      browserUrl: href,
      browserTitle: document.title,
      notes,
    };
  }
  if (/allow.*(microphone|camera)|blocked.*(microphone|camera)|permission.*(microphone|camera)/i.test(pageText)) {
    return {
      manualActionReason: "meet-permission-required",
      manualAction: "Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry meeting creation.",
      browserUrl: href,
      browserTitle: document.title,
      notes,
    };
  }
  if (/couldn't create|unable to create/i.test(pageText)) {
    return {
      manualAction: "Resolve the Google Meet page prompt in the OpenClaw browser profile, then retry meeting creation.",
      browserUrl: href,
      browserTitle: document.title,
      notes,
    };
  }
  if (location.hostname.toLowerCase() === "accounts.google.com" || /use your google account|to continue to google meet|choose an account|sign in to (join|continue)/i.test(pageText)) {
    return {
      manualActionReason: "google-login-required",
      manualAction: "Sign in to Google in the OpenClaw browser profile, then retry meeting creation.",
      browserUrl: href,
      browserTitle: document.title,
      notes,
    };
  }
  return {
    retryAfterMs: 500,
    browserUrl: current(),
    browserTitle: document.title,
    notes,
  };
}`;
async function createMeetWithBrowserProxyOnNode(params) {
	const nodeId = await resolveChromeNode({
		runtime: params.runtime,
		requestedNode: params.config.chromeNode.node
	});
	const timeoutMs = Math.max(GOOGLE_MEET_BROWSER_CREATE_TIMEOUT_MS, params.config.chrome.joinTimeoutMs);
	const stepTimeoutMs = Math.min(timeoutMs, GOOGLE_MEET_BROWSER_STEP_TIMEOUT_MS);
	let tab = await findGoogleMeetCreateTab({
		runtime: params.runtime,
		nodeId,
		timeoutMs: stepTimeoutMs
	});
	if (tab?.targetId) await focusBrowserTab({
		runtime: params.runtime,
		nodeId,
		targetId: tab.targetId,
		timeoutMs: stepTimeoutMs
	});
	else tab = readBrowserTab(await callBrowserProxyOnNode({
		runtime: params.runtime,
		nodeId,
		method: "POST",
		path: "/tabs/open",
		body: { url: GOOGLE_MEET_NEW_URL },
		timeoutMs: stepTimeoutMs
	}));
	const targetId = tab?.targetId;
	if (!targetId) throw new Error("Browser fallback opened Google Meet but did not return a targetId.");
	const notes = /* @__PURE__ */ new Set();
	let lastResult;
	let lastError;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) try {
		const result = readBrowserCreateResult(await callBrowserProxyOnNode({
			runtime: params.runtime,
			nodeId,
			method: "POST",
			path: "/act",
			body: {
				kind: "evaluate",
				targetId,
				fn: CREATE_MEET_FROM_BROWSER_SCRIPT
			},
			timeoutMs: stepTimeoutMs
		}));
		lastResult = result;
		for (const note of result.notes ?? []) notes.add(note);
		if (result.meetingUri) return {
			source: "browser",
			nodeId,
			targetId,
			meetingUri: result.meetingUri,
			browserUrl: result.browserUrl,
			browserTitle: result.browserTitle,
			notes: [...notes]
		};
		if (result.manualAction) throw new GoogleMeetBrowserManualActionError({
			manualActionRequired: true,
			manualActionReason: result.manualActionReason,
			manualActionMessage: result.manualAction,
			browser: {
				nodeId,
				targetId,
				browserUrl: result.browserUrl,
				browserTitle: result.browserTitle,
				notes: [...notes]
			}
		});
		await sleep(result.retryAfterMs ?? GOOGLE_MEET_BROWSER_POLL_MS);
	} catch (error) {
		lastError = error;
		if (!isBrowserNavigationInterruption(error)) throw error;
		await sleep(GOOGLE_MEET_BROWSER_NAVIGATION_RETRY_MS);
	}
	throw new Error(lastResult?.manualAction ?? `Google Meet did not return a meeting URL from the browser create flow before timeout.${lastError ? ` Last browser automation error: ${formatBrowserAutomationError(lastError)}` : ""}`);
}
//#endregion
export { googleApiError as _, isSameMeetUrlForReuse as a, resolveChromeNode as c, createGoogleMeetSpace as d, endGoogleMeetActiveConference as f, fetchLatestGoogleMeetConferenceRecord as g, fetchGoogleMeetSpace as h, callBrowserProxyOnNode as i, resolveChromeNodeInfo as l, fetchGoogleMeetAttendance as m, isGoogleMeetBrowserManualActionError as n, normalizeMeetUrlForReuse as o, fetchGoogleMeetArtifacts as p, asBrowserTabs as r, readBrowserTab as s, createMeetWithBrowserProxyOnNode as t, buildGoogleMeetPreflightReport as u };
